import { encodeFunctionData, parseAbi, parseUnits, type Address } from 'viem';
import { prisma } from '../lib/prisma.js';
import { publicClient, treasuryAccount, treasuryWallet, withTreasuryLock, TOKENS, HEDGE_STABLE, erc20Abi, envInt, assertStableDecimals, sendTreasuryTx, resolveTreasuryTx, onlyOneBurnedIn, DEAD_ADDRESS } from '../lib/chain.js';
import { getFreshUsdPrice } from '../lib/price.js';
import { treasuryOutflow, type OutflowJournal } from '../lib/outflow-journal.js';

/**
 * Buys $ONLYONE on the open market with VIP revenue and destroys it.
 *
 * This is the automatic version of "we'll burn the tokens manually". Every
 * VIP payment writes a TokenBurn row in the same transaction as the charge
 * (core/vip.ts); this worker turns those obligations into an actual on-chain
 * swap and a transfer to the dead address.
 *
 * Why buy on the market rather than burn from the treasury's own bag: a burn
 * from inventory removes supply but puts no bid under the price. A market buy
 * does both -- it is the buy pressure AND the supply cut, and it is the whole
 * reason VIP is priced in dollars rather than asking fans to burn tokens they
 * would have to go and acquire first.
 *
 * Three deliberate properties:
 *
 *  - **Obligations are never lost.** A row stays pending until its swap
 *    actually confirms. No pool, no router configured, an RPC outage, a
 *    reverted trade -- all of them delay the burn; none of them drop it. The
 *    pending total is what the platform still owes the supply and admin can
 *    read it (`GET /admin/token-burns`).
 *  - **Rows are only marked done after a successful receipt**, and the tx
 *    hash is stored, so "we burned X" is checkable on-chain by anybody rather
 *    than being a claim in a dashboard.
 *  - **It batches.** A $20 swap every time someone subscribes would pay more
 *    in gas and price impact than it destroys.
 *  - **A swap is never paid for twice.** The swap is signed locally and its
 *    hash persisted on the batch's rows (pendingTxHash) BEFORE it is
 *    broadcast. A receipt wait that times out, an RPC error or a restart
 *    used to leave the rows plain pending, so the next run bought and burned
 *    the same obligations again out of treasury funds. Now every run first
 *    settles any in-flight swap from the chain and starts a new one only
 *    when nothing is in flight.
 */

// OFF by default. The founder holds the money and burns manually once a
// month (POST /admin/token-burns/record), which avoids leaving a hot wallet
// with swap permissions running on a server -- the single most valuable thing
// an attacker could find in this runtime. Set TOKEN_BURN_AUTOMATIC=true only
// if that trade is deliberately being made.
const AUTOMATIC = process.env.TOKEN_BURN_AUTOMATIC === 'true';
const ROUTER = process.env.UNISWAP_V3_ROUTER_ADDRESS as Address | undefined;
const POOL_FEE = envInt('ONLYONE_POOL_FEE', 3000, 1, 1_000_000);
const INTERVAL_MS = envInt('TOKEN_BURN_INTERVAL_MS', 15 * 60_000, 60_000);
// Don't trade dust: below this the gas and the spread cost more than the burn
// is worth. Obligations simply accumulate until they clear it.
const MIN_BATCH_CENTS = BigInt(envInt('TOKEN_BURN_MIN_CENTS', 5000, 0));
// Accepting any amount out would hand a sandwich bot the whole batch.
const MAX_SLIPPAGE_BPS = BigInt(envInt('TOKEN_BURN_MAX_SLIPPAGE_BPS', 300, 0, 10_000));
// Outflow caps, from this process's environment and never from the database
// (same reasoning as the payout worker's -- workers/payout-worker.ts
// outflowLimitReason): the obligations this loop spends on are TokenBurn rows
// any .env holder can INSERT. One swap never spends more than the batch cap,
// and the rolling 24h total -- counted in the restart-proof outflow journal
// (lib/outflow-journal.ts) -- never more than the daily cap. An obligation
// bigger than the batch cap is never bought automatically: burn it by hand
// (POST /admin/token-burns/record).
const BATCH_MAX_CENTS = envInt('TOKEN_BURN_BATCH_MAX_CENTS', 200_000, 1);
const DAILY_MAX_CENTS = envInt('TOKEN_BURN_DAILY_MAX_CENTS', 500_000, 1);

// Not address(0): many ERC-20s reject transfers to it, which would revert the
// burn rather than perform it. 0x…dEaD is the conventional sink and is
// visible as a holder on any explorer, so the burn is legible to holders.
const DEAD = DEAD_ADDRESS;

// Only a Uniswap V3 SwapRouter02 single-pool route is implemented. The live
// $ONLYONE pool is V4 (lib/price.ts), so with the default pool version this
// worker refuses to start rather than sitting there deferring forever with a
// vague warning. Porting it to a V4 router is its own piece of work.
const V3_ONLY = process.env.ONLYONE_POOL_VERSION === 'v3';

const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
]);

/**
 * Settles the swap a previous run left in flight. Returns true when nothing
 * is in flight any more (a new batch may start), false when it is still
 * undecided -- then this run does nothing else: doubt never re-sends.
 */
export async function settleInFlightBurn(client = publicClient as any): Promise<boolean> {
  const inFlight = await prisma.tokenBurn.findFirst({ where: { executedAt: null, pendingTxHash: { not: null } }, select: { pendingTxHash: true, pendingNonce: true } });
  if (!inFlight?.pendingTxHash) return true;
  const hash = inFlight.pendingTxHash as `0x${string}`;
  const r = await resolveTreasuryTx(hash, inFlight.pendingNonce, client);
  if (r.state === 'success') {
    const burned = onlyOneBurnedIn(r.receipt.logs);
    const done = await prisma.tokenBurn.updateMany({
      where: { executedAt: null, pendingTxHash: hash },
      data: { executedAt: new Date(), txHash: hash.toLowerCase(), tokensBurned: burned.toString(), pendingTxHash: null, pendingNonce: null, pendingSince: null },
    });
    console.log(`token-burn: settled in-flight swap ${hash} (${done.count} obligations)`);
    return true;
  }
  if (r.state === 'reverted' || r.state === 'dropped') {
    // Nothing was bought: the obligations are owed again, as they were.
    await prisma.tokenBurn.updateMany({ where: { executedAt: null, pendingTxHash: hash }, data: { pendingTxHash: null, pendingNonce: null, pendingSince: null } });
    console.error(`token-burn: in-flight swap ${hash} ${r.state}; obligations back to pending`);
    return true;
  }
  console.warn(`token-burn: swap ${hash} still unsettled; not starting another`);
  return false;
}

export async function runBurnBatch() {
  if (!ROUTER || !TOKENS.ONLYONE.address || !V3_ONLY) return; // nothing to swap through yet
  // amountIn below is scaled with HEDGE_STABLE.decimals; never on an unchecked scale.
  await assertStableDecimals();
  if (!(await settleInFlightBurn())) return;

  const candidates = await prisma.tokenBurn.findMany({ where: { executedAt: null, pendingTxHash: null }, orderBy: { createdAt: 'asc' }, take: 500 });
  if (!candidates.length) return;

  const room = burnRoomCents();
  if (room <= 0n) return;
  const pending = selectBurnBatch(candidates, room);
  if (pending.length < candidates.length) {
    console.warn(`token-burn: ${candidates.length - pending.length} obligation(s) left for a later batch or a manual burn (TOKEN_BURN_BATCH_MAX_CENTS / TOKEN_BURN_DAILY_MAX_CENTS)`);
  }
  if (!pending.length) return;
  const totalCents = pending.reduce((sum, r) => sum + r.usdCents, 0n);
  if (totalCents < MIN_BATCH_CENTS) return;

  const amountIn = parseUnits((Number(totalCents) / 100).toFixed(HEDGE_STABLE.decimals), HEDGE_STABLE.decimals);

  // Computed BEFORE the balance check / allowance approval below, and the
  // whole batch is deferred (obligations stay pending, safely) if this
  // throws -- never proceed to a real swap with no real slippage floor.
  let amountOutMinimum: bigint;
  try {
    amountOutMinimum = await minimumOut(amountIn);
  } catch (e) {
    console.warn('token-burn: could not determine a spot price, deferring batch', e);
    return;
  }

  const treasuryBal = await publicClient.readContract({ address: HEDGE_STABLE.address, abi: erc20Abi, functionName: 'balanceOf', args: [treasuryAccount().address] });
  if (treasuryBal < amountIn) {
    // The ledger says this is owed but the wallet cannot cover it. Leaving the
    // rows pending is right: a partial burn recorded as complete would quietly
    // write off the difference.
    console.warn(`token-burn: treasury holds ${treasuryBal} ${HEDGE_STABLE.symbol}, needs ${amountIn}. Deferring ${pending.length} obligations.`);
    return;
  }

  const allowance = await publicClient.readContract({ address: HEDGE_STABLE.address, abi: erc20Abi, functionName: 'allowance', args: [treasuryAccount().address, ROUTER] });
  if (allowance < amountIn) {
    const approval = await withTreasuryLock(() => treasuryWallet().writeContract({ address: HEDGE_STABLE.address, abi: erc20Abi, functionName: 'approve', args: [ROUTER, amountIn * 10n] }));
    await publicClient.waitForTransactionReceipt({ hash: approval });
  }

  // Straight to the dead address as the swap's recipient: the tokens are
  // destroyed in the same transaction that buys them, so there is no window in
  // which the treasury is holding tokens it has already promised to burn.
  const ids = pending.map((r) => r.id);
  const data = encodeFunctionData({
    abi: routerAbi,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: HEDGE_STABLE.address,
      tokenOut: TOKENS.ONLYONE.address,
      fee: POOL_FEE,
      recipient: DEAD,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
  });
  // Persist the hash on exactly these rows BEFORE broadcasting (see header).
  const hash = await sendTreasuryTx({ to: ROUTER, data }, async (h, nonce) => {
    // Counted before the hash is persisted or anything is broadcast; a
    // failure here aborts the send (sendTreasuryTx broadcasts only after
    // this callback returns).
    treasuryOutflow.record('burn', Number(totalCents), h);
    const claimed = await prisma.tokenBurn.updateMany({
      where: { id: { in: ids }, executedAt: null, pendingTxHash: null },
      data: { pendingTxHash: h, pendingNonce: nonce, pendingSince: new Date() },
    });
    // A manual burn record closed some of them meanwhile: don't buy for those.
    if (claimed.count !== ids.length) {
      await prisma.tokenBurn.updateMany({ where: { pendingTxHash: h, executedAt: null }, data: { pendingTxHash: null, pendingNonce: null, pendingSince: null } });
      throw new Error('token-burn: obligations changed while preparing the swap; retrying next run');
    }
  });

  // What was actually destroyed is the $ONLYONE that arrived at the dead
  // address in this transaction -- read off the receipt, not assumed. The
  // wait may time out; the rows then stay in flight and the next run
  // settles them (settleInFlightBurn) rather than swapping again.
  await publicClient.waitForTransactionReceipt({ hash }).catch(() => null);
  await settleInFlightBurn();
  console.log(`token-burn: swap ${hash} for ${totalCents} cents' worth across ${pending.length} obligations`);
}

/**
 * Cents the automatic burn may still spend right now: the batch cap, less
 * whatever the rolling 24h window has already used. Zero (defer) when the
 * outflow journal is unavailable -- never swap uncounted.
 */
export function burnRoomCents(journal: OutflowJournal = treasuryOutflow, batchMax = BATCH_MAX_CENTS, dailyMax = DAILY_MAX_CENTS): bigint {
  let used: number;
  try { used = journal.sumSince('burn'); } catch (e) {
    console.error('token-burn: outflow journal unavailable, deferring', (e as Error).message);
    return 0n;
  }
  const room = Math.min(batchMax, dailyMax - used);
  return room > 0 ? BigInt(room) : 0n;
}

/**
 * The oldest obligations that fit in `roomCents`, in order. An obligation
 * that alone exceeds the room is skipped (not the ones after it), so one
 * oversized -- possibly injected -- row cannot block every real one; it stays
 * pending for a manual burn.
 */
export function selectBurnBatch<T extends { usdCents: bigint }>(rows: T[], roomCents: bigint): T[] {
  const out: T[] = [];
  let sum = 0n;
  for (const r of rows) {
    if (r.usdCents <= 0n) continue;
    if (sum + r.usdCents > roomCents) continue;
    out.push(r); sum += r.usdCents;
  }
  return out;
}

/** Sum of $ONLYONE Transfer amounts to the dead address in a receipt's logs (lib/chain.ts onlyOneBurnedIn). */
export function tokensSentToDead(logs: { address: string; topics: readonly `0x${string}`[] | `0x${string}`[]; data: `0x${string}` }[]): bigint {
  return onlyOneBurnedIn(logs);
}

/**
 * The floor on tokens received. Without one, a swap accepts whatever comes
 * back -- which on a thin pool is an invitation to sandwich the batch and
 * hand the platform almost nothing for its money.
 *
 * Deliberately conservative rather than clever: no quote is taken, so this is
 * only a sanity floor derived from the configured slippage cap.
 *
 * Uses the real price oracle (getFreshUsdPrice, lib/price.ts) rather than reading
 * ONLYONE_PRICE_OVERRIDE directly -- that env var is documented as pre-launch
 * only, and the oracle already falls back to it before reading the live pool
 * once it's unset. Reading the raw env var here meant this function silently
 * went back to computing spot=0 the moment the override was removed for a
 * real launch, at which point runBurnBatch (below) would have sent the swap
 * with amountOutMinimum: 0 -- zero slippage protection on a real batch, the
 * exact sandwich risk this function exists to prevent. The price throwing
 * (a stale oracle, no pool configured, an RPC hiccup) now propagates up to
 * runBurnBatch, which must defer the whole batch rather than treat "no price"
 * as "assume zero minimum and swap anyway".
 */
async function minimumOut(amountIn: bigint): Promise<bigint> {
  // Fresh from the pool, never the shared Redis cache (lib/price.ts
  // getFreshUsdPrice): an inflated cached price would drive this floor to ~0.
  const spot = await getFreshUsdPrice('ONLYONE');
  const dollars = Number(amountIn) / 10 ** HEDGE_STABLE.decimals;
  const expected = parseUnits((dollars / spot).toFixed(TOKENS.ONLYONE.decimals), TOKENS.ONLYONE.decimals);
  return (expected * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n;
}

if (AUTOMATIC && process.env.NODE_ENV !== 'test' && !V3_ONLY) {
  console.error('token-burn: TOKEN_BURN_AUTOMATIC=true but only a Uniswap V3 route is implemented and ONLYONE_POOL_VERSION is not "v3". Automatic burns are OFF; burn manually (POST /admin/token-burns/record).');
} else if (AUTOMATIC && process.env.NODE_ENV !== 'test') {
  (async function loop() {
    for (;;) {
      try { await runBurnBatch(); } catch (e) { console.error('token-burn', e); }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  })().catch((e) => console.error('token-burn: loop crashed', e));
}
