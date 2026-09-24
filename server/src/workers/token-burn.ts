import { parseAbi, parseEventLogs, parseUnits, type Address } from 'viem';
import { prisma } from '../lib/prisma.js';
import { publicClient, treasuryAccount, treasuryWallet, withTreasuryLock, TOKENS, HEDGE_STABLE, erc20Abi, envInt } from '../lib/chain.js';
import { getUsdPrice } from '../lib/price.js';

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

// Not address(0): many ERC-20s reject transfers to it, which would revert the
// burn rather than perform it. 0x…dEaD is the conventional sink and is
// visible as a holder on any explorer, so the burn is legible to holders.
const DEAD = '0x000000000000000000000000000000000000dEaD' as Address;

// Only a Uniswap V3 SwapRouter02 single-pool route is implemented. The live
// $ONLYONE pool is V4 (lib/price.ts), so with the default pool version this
// worker refuses to start rather than sitting there deferring forever with a
// vague warning. Porting it to a V4 router is its own piece of work.
const V3_ONLY = process.env.ONLYONE_POOL_VERSION === 'v3';

const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
]);

export async function runBurnBatch() {
  if (!ROUTER || !TOKENS.ONLYONE.address || !V3_ONLY) return; // nothing to swap through yet

  const pending = await prisma.tokenBurn.findMany({ where: { executedAt: null }, orderBy: { createdAt: 'asc' }, take: 500 });
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
  const hash = await withTreasuryLock(() => treasuryWallet().writeContract({
    address: ROUTER,
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
  }));

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    console.error('token-burn: swap reverted, obligations left pending', hash);
    return;
  }

  // What was actually destroyed is the $ONLYONE that arrived at the dead
  // address in this transaction -- read off the receipt, not assumed. The
  // stablecoin spent (amountIn) is a different token in different units;
  // recording it here made the on-chain-checkable burn figure wrong by
  // construction.
  const burned = tokensSentToDead(receipt.logs);
  await prisma.tokenBurn.updateMany({
    where: { id: { in: pending.map((r) => r.id) } },
    data: { executedAt: new Date(), txHash: hash, tokensBurned: burned.toString() },
  });
  console.log(`token-burn: burned ${totalCents} cents' worth across ${pending.length} obligations (${hash})`);
}

/** Sum of $ONLYONE Transfer amounts to the dead address in a receipt's logs. */
export function tokensSentToDead(logs: { address: string; topics: readonly `0x${string}`[] | `0x${string}`[]; data: `0x${string}` }[]): bigint {
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: logs as any, strict: false });
  let total = 0n;
  for (const t of transfers) {
    if (t.address.toLowerCase() !== TOKENS.ONLYONE.address?.toLowerCase()) continue;
    if ((t.args as any).to?.toLowerCase() !== DEAD.toLowerCase()) continue;
    total += BigInt((t.args as any).value ?? 0n);
  }
  return total;
}

/**
 * The floor on tokens received. Without one, a swap accepts whatever comes
 * back -- which on a thin pool is an invitation to sandwich the batch and
 * hand the platform almost nothing for its money.
 *
 * Deliberately conservative rather than clever: no quote is taken, so this is
 * only a sanity floor derived from the configured slippage cap.
 *
 * Uses the real price oracle (getUsdPrice, lib/price.ts) rather than reading
 * ONLYONE_PRICE_OVERRIDE directly -- that env var is documented as pre-launch
 * only, and getUsdPrice already falls back to it before reading the live pool
 * once it's unset. Reading the raw env var here meant this function silently
 * went back to computing spot=0 the moment the override was removed for a
 * real launch, at which point runBurnBatch (below) would have sent the swap
 * with amountOutMinimum: 0 -- zero slippage protection on a real batch, the
 * exact sandwich risk this function exists to prevent. getUsdPrice throwing
 * (a stale oracle, no pool configured, an RPC hiccup) now propagates up to
 * runBurnBatch, which must defer the whole batch rather than treat "no price"
 * as "assume zero minimum and swap anyway".
 */
async function minimumOut(amountIn: bigint): Promise<bigint> {
  const spot = await getUsdPrice('ONLYONE');
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
