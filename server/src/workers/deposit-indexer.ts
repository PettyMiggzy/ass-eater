import { Worker } from 'bullmq';
import { formatUnits, parseEther, parseGwei, keccak256 } from 'viem';
import { prisma } from '../lib/prisma.js';
import { publicClient, CHAIN_ID, CONFIRMATIONS, TOKENS, ACCEPTED_STABLES, ADDR_TO_ASSET, TRANSFER_EVENT, DECIMALS, WATCHED_TOKENS, STABLECOINS, depositWalletClient, INDEX_ONLYONE_DEPOSITS, treasuryAccount, treasuryAddress, treasuryWallet, withTreasuryLock, erc20Abi, envInt, assertTokenDecimals, TokenDecimalsMismatchError } from '../lib/chain.js';
import { getUsdPrice, rawToUsdCents } from '../lib/price.js';
import { money, post, creditDeposit, type Tx } from '../core/ledger.js';
import { publish, sweepQueue, connection } from '../lib/redis.js';
import { registerWorker } from './process-guards.js';
import { chunk } from './indexer-chunks.js';
import { assertSweepsUnpaused, claimGasTopUp, depositCreditedFor, gasTopUpRefusal, gasTopUpRef, isPlatformSender, ethSweepCandidates, sweepWorthTopUp, SweepGasDeferred, SWEEP_GAS_TOPUP_GWEI } from './sweep-gas.js';
import { treasuryOutflow } from '../lib/outflow-journal.js';
import { initialCursorBlock, parseStartBlock } from './deposit-cursor.js';

const BATCH = 1000n;
// Deposit addresses per eth_getLogs `to` filter (geth caps a position at 1000).
const ADDRESS_CHUNK = envInt('DEPOSIT_LOG_ADDRESS_CHUNK', 500, 1, 1000);
const TRACK_NATIVE_ETH = process.env.TRACK_NATIVE_ETH === 'true';
const ONLYONE_BONUS_BPS = envInt('ONLYONE_DEPOSIT_BONUS_BPS', 0, 0, 10_000);
const REPRICE_MS = envInt('DEPOSIT_REPRICE_INTERVAL_MS', 10 * 60_000, 60_000);
const RECONCILE_MS = envInt('SWEEP_RECONCILE_INTERVAL_MS', 60 * 60_000, 60_000);

type Asset = 'STABLE' | 'ETH' | 'ONLYONE';
type SweepJob = { derivationIndex: number; asset: Asset; tokenAddress?: `0x${string}` };

/**
 * Sweep jobs retry, and their ids are deterministic so an enqueue can be
 * repeated safely: BullMQ ignores an add() for an id that is still pending.
 * No ':' in an id -- BullMQ rejects custom ids containing one.
 *
 * BullMQ also ignores an add() for a RETAINED FAILED job (removeOnFail keeps
 * the last 1000 for inspection), so enqueueSweep() removes a failed job of the
 * same id before re-adding. Without that, a sweep that exhausted its retries
 * (e.g. while the treasury had no gas for top-ups) blocked every later
 * re-queue for that id, reconciliation included, and the funds sat at the
 * deposit address for good.
 */
const SWEEP_OPTS = { attempts: 8, backoff: { type: 'exponential' as const, delay: 30_000 }, removeOnComplete: true, removeOnFail: 1000 };

export function sweepJobId(txHash: string, logIndex: number) {
  return `sweep-${CHAIN_ID}-${txHash.toLowerCase()}-${logIndex}`;
}

async function enqueueSweep(job: SweepJob, jobId: string, delay = 60_000) {
  const prev = await sweepQueue.getJob(jobId);
  if (prev && (await prev.isFailed())) await prev.remove();
  await sweepQueue.add('sweep', job, { ...SWEEP_OPTS, jobId, delay });
}

/** Pricing gets a few quick retries before a deposit is parked as pending. */
const PRICE_RETRY_MS = [0, 2_000, 5_000];
async function priceWithRetry(asset: Asset): Promise<number> {
  let last: unknown;
  for (const wait of PRICE_RETRY_MS) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      const px = await getUsdPrice(asset);
      if (Number.isFinite(px) && px > 0) return px;
      last = new Error(`non-positive price ${px}`);
    } catch (e) { last = e; }
  }
  throw last;
}

function depositCents(asset: Asset, raw: bigint, decimals: number, px: number): bigint {
  let cents = rawToUsdCents(raw, decimals, px);
  if (asset === 'ONLYONE' && ONLYONE_BONUS_BPS) cents += (cents * BigInt(ONLYONE_BONUS_BPS)) / 10_000n;   // token deposit bonus
  return cents;
}

/** The ledger side of a deposit, shared by first-pass credit and the reprice loop. */
async function postDeposit(tx: Tx, userId: string, asset: Asset, cents: bigint, depId: string, meta: Record<string, unknown>) {
  if (asset === 'ONLYONE') {
    // Its own pool, and deliberately not credits -- see the Balance type
    // in core/ledger.ts. No buy-credits fee, because no credits are
    // bought. NOTE: nothing currently spends this balance; see MEMORY.md.
    await post(tx, userId, cents, 'DEPOSIT', depId, meta, 'ONLYONE');
    return;
  }
  // Buying credits: the fan gets the deposit less FEES.DEPOSIT_BPS, the
  // platform keeps the rest.
  const { feeCents } = await creditDeposit(tx, userId, cents, depId, meta);
  await tx.deposit.update({ where: { id: depId }, data: { feeCents } });
}

/**
 * Every deposit address on this chain, keyed by lower-cased address. The
 * log query filters on them, so all of them are needed -- but this process
 * holds the treasury key and a hard MemoryMax, and the rows come from a
 * table any .env holder can write: a few million inserted DepositAddress
 * rows used to OOM-kill the unit on its next 6s scan, over and over. So the
 * table is COUNTED first and the scan refuses (loudly, without loading
 * anything) above DEPOSIT_ADDRESS_MAX, and only the three columns used are
 * read, a page at a time.
 */
const DEPOSIT_ADDRESS_MAX = envInt('DEPOSIT_ADDRESS_MAX', 250_000, 1);
const ADDRESS_PAGE = 10_000;
export class TooManyDepositAddresses extends Error {}
type AddrRow = { address: string; userId: string; derivationIndex: number };
async function addressMap() {
  const n = await prisma.depositAddress.count({ where: { chainId: CHAIN_ID } });
  if (n > DEPOSIT_ADDRESS_MAX) {
    throw new TooManyDepositAddresses(`indexer: ${n} deposit addresses on chain ${CHAIN_ID} exceeds DEPOSIT_ADDRESS_MAX=${DEPOSIT_ADDRESS_MAX}; refusing to load them (check the DepositAddress table for injected rows, or raise the limit deliberately)`);
  }
  const map = new Map<string, AddrRow>();
  let cursor: string | undefined;
  for (;;) {
    const rows: (AddrRow & { id: string })[] = await prisma.depositAddress.findMany({
      where: { chainId: CHAIN_ID }, orderBy: { id: 'asc' }, take: ADDRESS_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, address: true, userId: true, derivationIndex: true },
    });
    for (const r of rows) {
      map.set(r.address.toLowerCase(), { address: r.address, userId: r.userId, derivationIndex: r.derivationIndex });
      // Rows inserted while paging are not a reason to exceed the cap either.
      if (map.size > DEPOSIT_ADDRESS_MAX) throw new TooManyDepositAddresses(`indexer: more than DEPOSIT_ADDRESS_MAX=${DEPOSIT_ADDRESS_MAX} deposit addresses; refusing`);
    }
    if (rows.length < ADDRESS_PAGE) break;
    cursor = rows[rows.length - 1].id;
  }
  return map;
}

/** A token deposit that could not be priced. Never blocks the indexer; see credit(). */
class UnpricedDepositError extends Error {}

async function credit(d: { userId: string; txHash: string; logIndex: number; asset: Asset; raw: bigint; derivationIndex: number; token?: { symbol: string; decimals: number }; tokenAddress?: `0x${string}` }) {
  let px: number;
  try {
    px = await priceWithRetry(d.asset);
  } catch (e) {
    // Only reachable for ETH / $ONLYONE (a stablecoin is $1 by definition).
    // Throwing here used to abort the whole scan before the cursor moved, so
    // one un-priceable token transfer -- 1 wei of the live token is enough --
    // stopped every stablecoin deposit after it from ever being credited.
    throw new UnpricedDepositError(`no price for ${d.asset}: ${(e as Error)?.message ?? e}`);
  }
  // A stablecoin's decimals come from its own allowlist entry (checked against
  // the contract at startup), not from a fixed table -- two dollar tokens on
  // the same chain do not have to agree on scale.
  const decimals = d.asset === 'STABLE' ? d.token!.decimals : DECIMALS[d.asset as 'ETH' | 'ONLYONE'];
  const cents = depositCents(d.asset, d.raw, decimals, px);
  if (cents <= 0n) return;
  let fresh = true;
  try {
    await money(prisma, async (tx) => {
      const dep = await tx.deposit.create({ data: { userId: d.userId, chainId: CHAIN_ID, txHash: d.txHash, logIndex: d.logIndex, asset: d.asset, stableSymbol: d.token?.symbol ?? null, rawAmount: d.raw.toString(), usdCents: cents, priceUsed: px } });
      await postDeposit(tx, d.userId, d.asset, cents, dep.id, { asset: d.asset, raw: d.raw.toString(), px });
    });
  } catch (e: any) {
    if (e.code !== 'P2002') throw e;
    fresh = false;   // already credited by an earlier pass
  }
  // The sweep is enqueued on BOTH paths. It runs after the credit commits and
  // outside its transaction, so a crash between the two used to leave a
  // credited deposit that was never swept: the next pass hit P2002 and
  // returned before reaching this line. The deterministic job id makes the
  // repeat harmless. The contract address rides along: with several
  // stablecoins accepted, the asset alone no longer says which ERC-20 to sweep.
  await enqueueSweep({ derivationIndex: d.derivationIndex, asset: d.asset, tokenAddress: d.tokenAddress }, sweepJobId(d.txHash, d.logIndex));
  if (fresh) {
    // A notification is best-effort; it must never be able to skip the sweep
    // above or fail the scan.
    await publish(d.userId, { type: 'deposit', asset: d.token?.symbol ?? d.asset, amount: formatUnits(d.raw, decimals), usdCents: Number(cents) })
      .catch((e) => console.warn('indexer: deposit notification failed', e));
  }
}

/**
 * credit(), with one log's pricing failure contained to that log.
 *
 * A token deposit that still has no price after credit()'s quick retries is
 * recorded durably as PRICE-PENDING -- a Deposit row with pricePending true,
 * usdCents 0 and nothing posted to the ledger -- so the cursor moves past it
 * and the unique (chainId, txHash, logIndex) key rules out a double credit
 * later. It is not swept yet (the tokens stay at the fan's deposit address)
 * and is marked hedged so the hedge worker never sells them. repricePending()
 * credits it once a price is available, so a momentary oracle/RPC blip no
 * longer strands a real deposit. Anything else (a DB error on a stablecoin
 * credit) still throws and the scan retries the range, which is the right
 * answer for a transient failure on real money.
 */
async function creditIsolated(d: Parameters<typeof credit>[0]) {
  try {
    await credit(d);
  } catch (e) {
    if (!(e instanceof UnpricedDepositError)) throw e;
    console.error(`indexer: UNPRICED ${d.asset} deposit ${d.txHash}#${d.logIndex} raw=${d.raw} to user ${d.userId} -- recorded price-pending, will be credited when a price is available`, e.message);
    await prisma.deposit.create({ data: {
      userId: d.userId, chainId: CHAIN_ID, txHash: d.txHash, logIndex: d.logIndex, asset: d.asset,
      rawAmount: d.raw.toString(), usdCents: 0n, priceUsed: 0, hedgedAt: new Date(), pricePending: true,
    } }).catch((err: any) => { if (err?.code !== 'P2002') throw err; });
  }
}

/**
 * Credits price-pending deposits once their asset can be priced. The claim
 * is a guarded UPDATE (pricePending true -> false) inside the same
 * transaction as the ledger posting, so two passes can never both credit one
 * deposit. A deposit still unpriceable is left pending for the next pass.
 */
export async function repricePending(limit = 100) {
  const rows = await prisma.deposit.findMany({ where: { chainId: CHAIN_ID, pricePending: true }, orderBy: { createdAt: 'asc' }, take: limit });
  let credited = 0;
  for (const d of rows) {
    const asset = d.asset as Asset;
    if (asset === 'STABLE') continue;   // never parked; a stablecoin is $1
    let px: number;
    try { px = await getUsdPrice(asset); } catch { continue; }
    if (!Number.isFinite(px) || px <= 0) continue;
    const raw = BigInt(d.rawAmount);
    const cents = depositCents(asset, raw, DECIMALS[asset], px);
    const done = await money(prisma, async (tx) => {
      // Dust that prices to zero is settled with nothing to credit, same as
      // credit() does on the first pass.
      const claim = await tx.deposit.updateMany({
        where: { id: d.id, pricePending: true },
        data: { pricePending: false, usdCents: cents > 0n ? cents : 0n, priceUsed: px, hedgedAt: cents > 0n ? null : d.hedgedAt },
      });
      if (!claim.count || cents <= 0n) return false;
      await postDeposit(tx, d.userId, asset, cents, d.id, { asset, raw: d.rawAmount, px, repriced: true });
      return true;
    });
    if (!done) continue;
    credited++;
    const addr = await prisma.depositAddress.findUnique({ where: { userId_chainId: { userId: d.userId, chainId: CHAIN_ID } } });
    if (addr) {
      await enqueueSweep({ derivationIndex: addr.derivationIndex, asset, tokenAddress: asset === 'ONLYONE' ? TOKENS.ONLYONE.address : undefined }, sweepJobId(d.txHash, d.logIndex));
    }
    await publish(d.userId, { type: 'deposit', asset, amount: formatUnits(raw, DECIMALS[asset]), usdCents: Number(cents) })
      .catch((e) => console.warn('indexer: deposit notification failed', e));
  }
  return credited;
}

/**
 * First run on this chain: never start at the head once addresses exist
 * (workers/deposit-cursor.ts). Returns null -- and creates nothing, so the
 * next tick asks again -- when there is no safe place to start.
 */
async function createCursor(safe: bigint) {
  const [addressCount, unstampedAddresses, agg] = await Promise.all([
    prisma.depositAddress.count({ where: { chainId: CHAIN_ID } }),
    prisma.depositAddress.count({ where: { chainId: CHAIN_ID, issuedBlock: null } }),
    prisma.depositAddress.aggregate({ where: { chainId: CHAIN_ID }, _min: { issuedBlock: true } }),
  ]);
  const lastBlock = initialCursorBlock({
    safe, addressCount, unstampedAddresses,
    minIssuedBlock: agg._min.issuedBlock ?? null,
    envStartBlock: parseStartBlock(process.env.DEPOSIT_START_BLOCK),
  });
  if (lastBlock == null) {
    console.error(`indexer: REFUSING to start the deposit cursor for chain ${CHAIN_ID}: ${unstampedAddresses} deposit address(es) were issued with no recorded block, so any deposit sent to them before now would be skipped for good. Set DEPOSIT_START_BLOCK to a block at or before the first address was handed out (e.g. the block of the deploy that first set DEPOSIT_XPUB) and restart the workers.`);
    return null;
  }
  // Upsert, not create: a second indexer racing this one must not fail.
  return prisma.chainCursor.upsert({ where: { chainId: CHAIN_ID }, create: { chainId: CHAIN_ID, lastBlock }, update: {} });
}

async function scan() {
  const head = await publicClient.getBlockNumber();
  const safe = head - BigInt(CONFIRMATIONS);
  const cursor = await prisma.chainCursor.findUnique({ where: { chainId: CHAIN_ID } }) ?? await createCursor(safe);
  if (!cursor) return;
  let from = cursor.lastBlock + 1n;
  if (from > safe) return;
  const addrs = await addressMap();
  if (!addrs.size) { await prisma.chainCursor.update({ where: { chainId: CHAIN_ID }, data: { lastBlock: safe } }); return; }

  while (from <= safe) {
    const to = from + BATCH - 1n > safe ? safe : from + BATCH - 1n;

    // ERC20: every accepted stablecoin plus $ONLYONE, to any of our addresses.
    // Filtering by contract address in the log query is what makes this an
    // allowlist rather than a ticker match -- a token that calls itself USDG
    // from a different contract is never even looked at.
    //
    // The `to` addresses go out ADDRESS_CHUNK at a time (see
    // indexer-chunks.ts: one filter with every deposit address ever issued
    // passes the RPC's per-position cap and then fails forever). Every chunk
    // for this block range is fetched before anything is credited or the
    // cursor moves, so a failure part-way leaves the whole range to be
    // retried; crediting is idempotent per (txHash, logIndex) regardless.
    const logs = [];
    for (const part of chunk([...addrs.values()].map(a => a.address as `0x${string}`), ADDRESS_CHUNK)) {
      logs.push(...await publicClient.getLogs({ address: WATCHED_TOKENS.map(t => t.address), event: TRANSFER_EVENT, args: { to: part }, fromBlock: from, toBlock: to }));
    }
    for (const l of logs) {
      const row = addrs.get(l.args.to!.toLowerCase()); const asset = ADDR_TO_ASSET.get(l.address.toLowerCase());
      if (!row || !asset || !l.args.value) continue;
      const token = ACCEPTED_STABLES.get(l.address.toLowerCase());
      await creditIsolated({ userId: row.userId, txHash: l.transactionHash, logIndex: l.logIndex, asset, raw: l.args.value, derivationIndex: row.derivationIndex, token, tokenAddress: l.address });
    }

    // Native ETH: scan block txs (only catches direct transfers, not internal calls — document this to users)
    // Never from the platform itself: the treasury's gas top-up to a deposit
    // address (the sweep worker below) is not a fan's deposit, nor is ETH
    // moved between two deposit addresses (workers/sweep-gas.ts isPlatformSender).
    if (TRACK_NATIVE_ETH) {
      // The key these workers actually send top-ups from, not the
      // configured TREASURY_ADDRESS: after a key rotation that left the env
      // value on the old wallet, every top-up from the new one was credited
      // to the fan as an ETH deposit. (workers/treasury-guard.ts refuses to
      // start while the two disagree; this holds even if that is bypassed.)
      let treasury: string | null;
      try { treasury = treasuryAccount().address; } catch { treasury = treasuryAddress(); }
      for (let b = from; b <= to; b++) {
        const block = await publicClient.getBlock({ blockNumber: b, includeTransactions: true });
        for (const t of block.transactions) {
          const row = t.to && addrs.get(t.to.toLowerCase());
          if (row && t.value > 0n && !isPlatformSender(t.from, treasury, addrs)) await creditIsolated({ userId: row.userId, txHash: t.hash, logIndex: -1, asset: 'ETH', raw: t.value, derivationIndex: row.derivationIndex });
        }
      }
    }
    await prisma.chainCursor.update({ where: { chainId: CHAIN_ID }, data: { lastBlock: to } });
    from = to + 1n;
  }
}

/**
 * Boot check with the blast radius contained.
 *
 * Every worker shares this process (workers/index.ts). A transient RPC error
 * here used to reject an un-caught promise and take renewals, payouts,
 * transcode, broadcast and auction-close down with it, restart-looping for as
 * long as the RPC was unhealthy. Now an RPC failure is retried with backoff,
 * and a genuine decimals mismatch disables ONLY the deposit indexer -- loudly,
 * and permanently until the config is fixed and the workers restarted, because
 * an indexer running on the wrong scale mints balances.
 */
async function waitForTokenCheck(): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await assertTokenDecimals();
      return true;
    } catch (e) {
      if (e instanceof TokenDecimalsMismatchError) {
        console.error('indexer: DISABLED -- token configuration does not match the chain. No deposits will be credited until this is fixed and the workers are restarted.', e.message);
        return false;
      }
      const wait = Math.min(300_000, 5_000 * 2 ** Math.min(attempt, 6));
      console.error(`indexer: token decimals check failed (attempt ${attempt + 1}), retrying in ${wait / 1000}s`, e);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// Set once the decimals check passes. The reprice loop credits on the same
// scale, so it waits for the same check.
let tokensVerified = false;

(async function loop() {
  if (!(await waitForTokenCheck())) return;
  tokensVerified = true;
  for (;;) {
    try { await scan(); } catch (e) { console.error('indexer', e); }
    await new Promise(r => setTimeout(r, envInt('INDEXER_INTERVAL_MS', 6000, 1000)));
  }
})().catch((e) => console.error('indexer: loop crashed', e));

/**
 * Reconciliation: re-queue a sweep for any deposit address still holding an
 * accepted stablecoin above dust, or (while $ONLYONE deposits are indexed)
 * any $ONLYONE at all at an address with a credited $ONLYONE deposit. Covers
 * every way a sweep can be lost -- a job that exhausted its retries (an
 * $ONLYONE price that could not be read, or a gas-cap refusal: both defer
 * for far longer than SWEEP_OPTS' ~64-minute retry budget), one enqueued
 * before this code existed, a deposit credited while Redis was being
 * replaced. Only addresses that have ever received a deposit are checked, so
 * the RPC cost tracks real usage.
 *
 * $ONLYONE has no fixed dollar floor to check here (its price moves), so any
 * non-zero balance is re-queued and the sweep worker decides: it defers
 * again on an unreadable price and returns on one KNOWN to put the balance
 * under the top-up floor.
 */
async function reconcileSweeps() {
  const rows = await prisma.$queryRaw<{ derivationIndex: number; address: string }[]>`
    SELECT DISTINCT a."derivationIndex", a."address"
      FROM "DepositAddress" a JOIN "Deposit" d ON d."userId" = a."userId" AND d."chainId" = a."chainId"
     WHERE a."chainId" = ${CHAIN_ID} AND d."asset" = 'STABLE'`;
  for (const r of rows) {
    for (const s of STABLECOINS) {
      const bal = await publicClient.readContract({ address: s.address, abi: erc20Abi, functionName: 'balanceOf', args: [r.address as `0x${string}`] });
      if (bal < 10n ** BigInt(s.decimals)) continue;   // under one dollar: not worth the gas yet
      await enqueueSweep({ derivationIndex: r.derivationIndex, asset: 'STABLE', tokenAddress: s.address },
        `sweep-recon-${CHAIN_ID}-${r.derivationIndex}-${s.address.toLowerCase()}`, 0);
    }
  }
  // Native ETH deposits too (TRACK_NATIVE_ETH): an ETH sweep deferred past
  // its retries -- a key rotation (TREASURY_SETTLE_ONLY) lasting hours, an
  // RPC outage -- used to wait for that fan's next ETH deposit. The floor
  // sits well above the 0.00005 ETH gas top-up an ERC-20 sweep leaves
  // behind, so leftover top-up gas alone never queues a job.
  if (TRACK_NATIVE_ETH) {
    // Credited ETH deposits only (workers/sweep-gas.ts ethSweepCandidates).
    const ethRows = await ethSweepCandidates(CHAIN_ID);
    for (const r of ethRows) {
      const bal = await publicClient.getBalance({ address: r.address as `0x${string}` });
      if (bal < parseEther('0.0005')) continue;
      await enqueueSweep({ derivationIndex: r.derivationIndex, asset: 'ETH' }, `sweep-recon-${CHAIN_ID}-${r.derivationIndex}-eth`, 0);
    }
  }
  if (!INDEX_ONLYONE_DEPOSITS) return;
  const tokenRows = await prisma.$queryRaw<{ derivationIndex: number; address: string }[]>`
    SELECT DISTINCT a."derivationIndex", a."address"
      FROM "DepositAddress" a JOIN "Deposit" d ON d."userId" = a."userId" AND d."chainId" = a."chainId"
     WHERE a."chainId" = ${CHAIN_ID} AND d."asset" = 'ONLYONE' AND d."pricePending" = false AND d."usdCents" > 0`;
  for (const r of tokenRows) {
    const bal = await publicClient.readContract({ address: TOKENS.ONLYONE.address, abi: erc20Abi, functionName: 'balanceOf', args: [r.address as `0x${string}`] });
    if (bal === 0n) continue;
    await enqueueSweep({ derivationIndex: r.derivationIndex, asset: 'ONLYONE', tokenAddress: TOKENS.ONLYONE.address },
      `sweep-recon-${CHAIN_ID}-${r.derivationIndex}-onlyone`, 0);
  }
}

(async function repriceLoop() {
  for (;;) {
    await new Promise(r => setTimeout(r, REPRICE_MS));
    if (!tokensVerified) continue;
    try { await repricePending(); } catch (e) { console.error('indexer: deposit repricing failed', e); }
  }
})().catch((e) => console.error('indexer: reprice loop crashed', e));

(async function reconcileLoop() {
  for (;;) {
    await new Promise(r => setTimeout(r, RECONCILE_MS));
    try { await reconcileSweeps(); } catch (e) { console.error('indexer: sweep reconciliation failed', e); }
  }
})().catch((e) => console.error('indexer: reconcile loop crashed', e));

/**
 * The signing key for a deposit index must derive the address the API gave
 * the fan (from DEPOSIT_XPUB) and the DB recorded. A wrong DEPOSIT_MNEMONIC
 * -- one mistyped word that still passes as a mnemonic -- derived a
 * different wallet, found a zero balance there and reported the sweep done,
 * forever, while the real funds sat at an address whose key nobody held.
 * Thrown loudly (the job fails and stays visible) instead.
 */
export class DepositKeyMismatchError extends Error {}
export async function expectedDepositSigner(derivationIndex: number) {
  const row = await prisma.depositAddress.findFirst({ where: { chainId: CHAIN_ID, derivationIndex }, select: { address: true } });
  if (!row) throw new DepositKeyMismatchError(`no DepositAddress row for index ${derivationIndex}`);
  const wc = depositWalletClient(derivationIndex);
  if (wc.account.address.toLowerCase() !== row.address.toLowerCase()) {
    throw new DepositKeyMismatchError(`DEPOSIT_MNEMONIC derives ${wc.account.address} for index ${derivationIndex}, but deposits go to ${row.address} -- the mnemonic does not match DEPOSIT_XPUB. Sweeps are disabled until it is fixed.`);
  }
  return wc;
}

// Checked once at startup against a real row: a mismatched mnemonic disables
// sweeping (loudly) rather than letting every sweep "complete" against the
// wrong wallet. Skipped when no deposit address exists yet or the mnemonic is
// not set in this process.
let sweepsDisabled: string | null = null;
(async function checkDepositKey() {
  if (!process.env.DEPOSIT_MNEMONIC) return;
  try {
    const sample = await prisma.depositAddress.findFirst({ where: { chainId: CHAIN_ID }, orderBy: { derivationIndex: 'desc' }, select: { derivationIndex: true } });
    if (sample) await expectedDepositSigner(sample.derivationIndex);
  } catch (e) {
    sweepsDisabled = String((e as Error).message);
    console.error('indexer: DEPOSIT KEY CHECK FAILED -- sweeps disabled:', sweepsDisabled);
  }
})().catch((e) => console.error('indexer: deposit key check crashed', e));

/** Move funds from deposit address → treasury. ERC20 sweeps need gas first. */
registerWorker(new Worker('sweep', async (job) => {
  const { derivationIndex, asset, tokenAddress } = job.data as SweepJob;
  if (sweepsDisabled) throw new DepositKeyMismatchError(sweepsDisabled);
  // Key rotation: nothing moves into the (old, exposed) treasury address --
  // not the ETH path, not an ERC-20 that already has gas, not a top-up.
  assertSweepsUnpaused();
  const wc = await expectedDepositSigner(derivationIndex); const me = wc.account.address;
  const treasuryAddress = treasuryAccount().address;
  if (asset === 'ETH') {
    // Never move ETH off an address with no credited ETH deposit: an
    // unpriced one stays at the fan's address until it is priced (credit()
    // queues no sweep for it), and this job's data alone is not proof. Not
    // retried (a plain return): the credit of that deposit queues its own.
    if (!(await depositCreditedFor(CHAIN_ID, derivationIndex, 'ETH'))) return;
    const bal = await publicClient.getBalance({ address: me });
    const gas = await publicClient.estimateFeesPerGas(); const cost = 21_000n * (gas.maxFeePerGas ?? 0n) * 2n;
    if (bal > cost) await wc.sendTransaction({ to: treasuryAddress, value: bal - cost });
    return;
  }
  const tok = asset === 'ONLYONE' ? TOKENS.ONLYONE : ACCEPTED_STABLES.get((tokenAddress ?? '').toLowerCase());
  if (!tok?.address) return; // unknown token in a sweep job -- never guess which contract to move

  const bal = await publicClient.readContract({ address: tok.address, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
  if (bal === 0n) return;
  const gasBal = await publicClient.getBalance({ address: me });
  if (gasBal < parseEther('0.00002')) {
    // Under a dollar, a sweep is not worth a treasury-funded top-up: every
    // credited deposit queues its own sweep, and a stream of 1-cent deposits
    // (credited in full) used to buy one top-up each until the platform-wide
    // cap refused every sweep for everyone. Done without failing: the balance
    // waits at the address, and the next deposit's sweep -- or the hourly
    // reconciler (reconcileSweeps: a stablecoin once it reaches a dollar,
    // $ONLYONE whenever any is there) -- moves it.
    //
    // That return is only for a price KNOWN to put the balance under the
    // floor. An $ONLYONE price that could not be read (oracle or RPC blip)
    // says nothing about the balance: returning completed the job and left
    // a credited deposit at the address. It is deferred instead, so BullMQ
    // retries with backoff (SWEEP_OPTS, ~64 minutes); an outage outlasting
    // that is picked up again by the hourly reconciler, which re-queues any
    // $ONLYONE balance at an address with a credited $ONLYONE deposit --
    // the same net that catches a gas-cap refusal (24h windows).
    let px = 1;
    if (asset === 'ONLYONE') {
      try { px = await getUsdPrice('ONLYONE'); } catch (e) {
        throw new SweepGasDeferred(`sweep deferred: $ONLYONE price unavailable (${(e as Error).message})`);
      }
    }
    if (!sweepWorthTopUp(bal, tok.decimals, px)) return;
    // The gas top-up is treasury money leaving on the strength of a Redis job
    // and a DB row, so it is bounded like every other automatic outflow
    // (workers/sweep-gas.ts): only for an address with a credited deposit of
    // this asset, counted in the outflow journal before signing, and refused
    // past the daily cap -- the job then fails and retries later.
    if (!(await depositCreditedFor(CHAIN_ID, derivationIndex, asset))) {
      throw new SweepGasDeferred(`sweep gas top-up refused: no credited ${asset} deposit for deposit index ${derivationIndex}`);
    }
    // A treasury send, so it queues behind payouts, the hedge and the burn
    // rather than racing them for a nonce; the cap check and the journal
    // write happen under the same lock, so two top-ups cannot both fit.
    //
    // Journaled only once the top-up is SIGNED (then broadcast), the
    // sendTreasuryTx pattern: preparing it -- nonce, fees, gas estimate --
    // throws for a treasury with no ETH or an RPC error, and a record made
    // before that let failed retries fill the daily cap with nothing sent.
    const ref = gasTopUpRef(CHAIN_ID, derivationIndex);
    // Key rotation: re-checked right before the treasury signs, in case the
    // mode was switched on while this job was reading balances.
    assertSweepsUnpaused();
    const h = await withTreasuryLock(async () => {
      const why = gasTopUpRefusal(treasuryOutflow, undefined, undefined, ref);
      if (why) throw new SweepGasDeferred(`sweep gas top-up deferred: ${why}`);
      const wallet = treasuryWallet();
      const request = await wallet.prepareTransactionRequest({ to: me, value: parseGwei(String(SWEEP_GAS_TOPUP_GWEI)) } as any);
      const serialized = await wallet.signTransaction(request as any);
      claimGasTopUp(treasuryOutflow, ref);
      await wallet.sendRawTransaction({ serializedTransaction: serialized });
      return keccak256(serialized);
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  const h = await wc.writeContract({ address: tok.address, abi: erc20Abi, functionName: 'transfer', args: [treasuryAddress, bal] });
  await publicClient.waitForTransactionReceipt({ hash: h });
}, { ...connection, concurrency: 1 }));
