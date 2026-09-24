import { Worker } from 'bullmq';
import { formatUnits, parseEther } from 'viem';
import { prisma } from '../lib/prisma.js';
import { publicClient, CHAIN_ID, CONFIRMATIONS, TOKENS, ACCEPTED_STABLES, ADDR_TO_ASSET, TRANSFER_EVENT, DECIMALS, WATCHED_TOKENS, STABLECOINS, depositWalletClient, treasuryAccount, treasuryWallet, withTreasuryLock, erc20Abi, envInt, assertTokenDecimals, TokenDecimalsMismatchError } from '../lib/chain.js';
import { getUsdPrice, rawToUsdCents } from '../lib/price.js';
import { money, post, creditDeposit, type Tx } from '../core/ledger.js';
import { publish, sweepQueue, connection } from '../lib/redis.js';

const BATCH = 1000n;
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

async function addressMap() {
  const rows = await prisma.depositAddress.findMany({ where: { chainId: CHAIN_ID } });
  return new Map(rows.map(r => [r.address.toLowerCase(), r]));
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

async function scan() {
  const head = await publicClient.getBlockNumber();
  const safe = head - BigInt(CONFIRMATIONS);
  const cursor = await prisma.chainCursor.upsert({ where: { chainId: CHAIN_ID }, create: { chainId: CHAIN_ID, lastBlock: safe - 1n }, update: {} });
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
    const logs = await publicClient.getLogs({ address: WATCHED_TOKENS.map(t => t.address), event: TRANSFER_EVENT, args: { to: [...addrs.values()].map(a => a.address as `0x${string}`) }, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const row = addrs.get(l.args.to!.toLowerCase()); const asset = ADDR_TO_ASSET.get(l.address.toLowerCase());
      if (!row || !asset || !l.args.value) continue;
      const token = ACCEPTED_STABLES.get(l.address.toLowerCase());
      await creditIsolated({ userId: row.userId, txHash: l.transactionHash, logIndex: l.logIndex, asset, raw: l.args.value, derivationIndex: row.derivationIndex, token, tokenAddress: l.address });
    }

    // Native ETH: scan block txs (only catches direct transfers, not internal calls — document this to users)
    if (TRACK_NATIVE_ETH) {
      for (let b = from; b <= to; b++) {
        const block = await publicClient.getBlock({ blockNumber: b, includeTransactions: true });
        for (const t of block.transactions) {
          const row = t.to && addrs.get(t.to.toLowerCase());
          if (row && t.value > 0n) await creditIsolated({ userId: row.userId, txHash: t.hash, logIndex: -1, asset: 'ETH', raw: t.value, derivationIndex: row.derivationIndex });
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
 * accepted stablecoin above dust. Covers every way a sweep can be lost -- a
 * job that exhausted its retries, one enqueued before this code existed, a
 * deposit credited while Redis was being replaced. Only addresses that have
 * ever received a deposit are checked, so the RPC cost tracks real usage.
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

/** Move funds from deposit address → treasury. ERC20 sweeps need gas first. */
new Worker('sweep', async (job) => {
  const { derivationIndex, asset, tokenAddress } = job.data as SweepJob;
  const wc = depositWalletClient(derivationIndex); const me = wc.account.address;
  const treasuryAddress = treasuryAccount().address;
  if (asset === 'ETH') {
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
    // The gas top-up is a treasury send, so it queues behind payouts, the
    // hedge and the burn rather than racing them for a nonce.
    const h = await withTreasuryLock(() => treasuryWallet().sendTransaction({ to: me, value: parseEther('0.00005') }));
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  const h = await wc.writeContract({ address: tok.address, abi: erc20Abi, functionName: 'transfer', args: [treasuryAddress, bal] });
  await publicClient.waitForTransactionReceipt({ hash: h });
}, { ...connection, concurrency: 1 });
