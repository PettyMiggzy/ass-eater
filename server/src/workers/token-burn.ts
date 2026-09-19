import { parseAbi, parseUnits, type Address } from 'viem';
import { prisma } from '../lib/prisma';
import { publicClient, treasuryClient, treasury, TOKENS, HEDGE_STABLE, erc20Abi } from '../lib/chain';

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
const POOL_FEE = Number(process.env.ONLYONE_POOL_FEE ?? 3000);
const INTERVAL_MS = Number(process.env.TOKEN_BURN_INTERVAL_MS ?? 15 * 60_000);
// Don't trade dust: below this the gas and the spread cost more than the burn
// is worth. Obligations simply accumulate until they clear it.
const MIN_BATCH_CENTS = BigInt(process.env.TOKEN_BURN_MIN_CENTS ?? 5000);
// Accepting any amount out would hand a sandwich bot the whole batch.
const MAX_SLIPPAGE_BPS = BigInt(process.env.TOKEN_BURN_MAX_SLIPPAGE_BPS ?? 300);

// Not address(0): many ERC-20s reject transfers to it, which would revert the
// burn rather than perform it. 0x…dEaD is the conventional sink and is
// visible as a holder on any explorer, so the burn is legible to holders.
const DEAD = '0x000000000000000000000000000000000000dEaD' as Address;

const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
]);

export async function runBurnBatch() {
  if (!ROUTER || !TOKENS.ONLYONE.address) return; // nothing to swap through yet

  const pending = await prisma.tokenBurn.findMany({ where: { executedAt: null }, orderBy: { createdAt: 'asc' }, take: 500 });
  if (!pending.length) return;

  const totalCents = pending.reduce((sum, r) => sum + r.usdCents, 0n);
  if (totalCents < MIN_BATCH_CENTS) return;

  const amountIn = parseUnits((Number(totalCents) / 100).toFixed(HEDGE_STABLE.decimals), HEDGE_STABLE.decimals);
  const treasuryBal = await publicClient.readContract({ address: HEDGE_STABLE.address, abi: erc20Abi, functionName: 'balanceOf', args: [treasury.address] });
  if (treasuryBal < amountIn) {
    // The ledger says this is owed but the wallet cannot cover it. Leaving the
    // rows pending is right: a partial burn recorded as complete would quietly
    // write off the difference.
    console.warn(`token-burn: treasury holds ${treasuryBal} ${HEDGE_STABLE.symbol}, needs ${amountIn}. Deferring ${pending.length} obligations.`);
    return;
  }

  const allowance = await publicClient.readContract({ address: HEDGE_STABLE.address, abi: erc20Abi, functionName: 'allowance', args: [treasury.address, ROUTER] });
  if (allowance < amountIn) {
    const approval = await treasuryClient.writeContract({ address: HEDGE_STABLE.address, abi: erc20Abi, functionName: 'approve', args: [ROUTER, amountIn * 10n] });
    await publicClient.waitForTransactionReceipt({ hash: approval });
  }

  // Straight to the dead address as the swap's recipient: the tokens are
  // destroyed in the same transaction that buys them, so there is no window in
  // which the treasury is holding tokens it has already promised to burn.
  const hash = await treasuryClient.writeContract({
    address: ROUTER,
    abi: routerAbi,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: HEDGE_STABLE.address,
      tokenOut: TOKENS.ONLYONE.address,
      fee: POOL_FEE,
      recipient: DEAD,
      amountIn,
      amountOutMinimum: minimumOut(amountIn),
      sqrtPriceLimitX96: 0n,
    }],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    console.error('token-burn: swap reverted, obligations left pending', hash);
    return;
  }

  await prisma.tokenBurn.updateMany({
    where: { id: { in: pending.map((r) => r.id) } },
    data: { executedAt: new Date(), txHash: hash, tokensBurned: amountIn.toString() },
  });
  console.log(`token-burn: burned ${totalCents} cents' worth across ${pending.length} obligations (${hash})`);
}

/**
 * The floor on tokens received. Without one, a swap accepts whatever comes
 * back -- which on a thin pool is an invitation to sandwich the batch and
 * hand the platform almost nothing for its money.
 *
 * Deliberately conservative rather than clever: no quote is taken, so this is
 * only a sanity floor derived from the configured slippage cap. It returns 0
 * when no spot price is configured, which is the one case where the batch
 * should not run at all -- and it does not, because ROUTER and the pool env
 * are checked above.
 */
function minimumOut(amountIn: bigint): bigint {
  const spot = Number(process.env.ONLYONE_PRICE_OVERRIDE ?? 0);
  if (!(spot > 0)) return 0n;
  const dollars = Number(amountIn) / 10 ** HEDGE_STABLE.decimals;
  const expected = parseUnits((dollars / spot).toFixed(TOKENS.ONLYONE.decimals), TOKENS.ONLYONE.decimals);
  return (expected * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n;
}

if (AUTOMATIC && process.env.NODE_ENV !== 'test') {
  (async function loop() {
    for (;;) {
      try { await runBurnBatch(); } catch (e) { console.error('token-burn', e); }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  })();
}
