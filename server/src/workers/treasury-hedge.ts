import { encodeFunctionData, parseAbi, type Address } from 'viem';
import { prisma } from '../lib/prisma.js';
import { publicClient, treasuryAccount, treasuryWallet, withTreasuryLock, TOKENS, DECIMALS, HEDGE_STABLE, erc20Abi, envInt, assertStableDecimals, sendTreasuryTx, resolveTreasuryTx } from '../lib/chain.js';
import { impactBpsOf, allocateHedge, hedgeRemaining } from './treasury-hedge-math.js';

// Fans can deposit $ONLYONE to burn for VIP (core/vip.ts). That balance is
// booked in fixed USD cents at the price on the day it arrived, but the tokens
// backing it are volatile -- if $ONLYONE drops before the platform does
// anything with them, the treasury is short against a liability it recorded in
// dollars. This worker converts most of each new deposit into the stablecoin
// right away, keeping a slice as intentional token exposure, and caps trade
// size so it doesn't crater its own early, thin liquidity in the process.
//
// No-ops entirely until UNISWAP_V3_ROUTER_ADDRESS / UNISWAP_V3_QUOTER_ADDRESS /
// ONLYONE_POOL are set -- i.e. until $ONLYONE actually has a live market.

const HEDGE_BPS = envInt('TREASURY_HEDGE_BPS', 7500, 0, 10_000); // % of new $ONLYONE converted to stablecoin; rest stays as treasury exposure
const MAX_IMPACT_BPS = envInt('TREASURY_HEDGE_MAX_IMPACT_BPS', 300, 0, 10_000); // max acceptable price impact per swap
const INTERVAL_MS = envInt('TREASURY_HEDGE_INTERVAL_MS', 300_000, 10_000);
const POOL_FEE = envInt('ONLYONE_POOL_FEE', 3000, 1, 1_000_000); // Uniswap V3 fee tier (hundredths of a bip)
const ROUTER = process.env.UNISWAP_V3_ROUTER_ADDRESS as Address | undefined;
const QUOTER = process.env.UNISWAP_V3_QUOTER_ADDRESS as Address | undefined;

const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
]);
const univ3Abi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)']);

/** Same math as lib/price.ts's assUsd(), but in the pool's own quote token (not necessarily USD). */
async function spotPrice(): Promise<number> {
  const [sqrtP] = await publicClient.readContract({ address: process.env.ONLYONE_POOL as Address, abi: univ3Abi, functionName: 'slot0' });
  const dec0 = Number(process.env.ONLYONE_POOL_TOKEN0_DECIMALS), dec1 = Number(process.env.ONLYONE_POOL_TOKEN1_DECIMALS);
  const ratio = (Number(sqrtP) / 2 ** 96) ** 2 * 10 ** (dec0 - dec1);
  return process.env.ONLYONE_IS_TOKEN0 === 'true' ? ratio : 1 / ratio;
}

/** Quote the trade and shrink it until price impact vs spot is under the cap. Returns null if even a small slice is too much for the pool right now. */
async function sizeSwap(desiredRaw: bigint, spot: number): Promise<{ amountIn: bigint; amountOut: bigint; amountOutMin: bigint; impactBps: number } | null> {
  let amountIn = desiredRaw;
  for (let i = 0; i < 5 && amountIn > 0n; i++) {
    const { result } = await publicClient.simulateContract({
      address: QUOTER!, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: TOKENS.ONLYONE.address, tokenOut: HEDGE_STABLE.address, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
    });
    const [amountOut] = result as unknown as [bigint, bigint, number, bigint];
    const impactBps = impactBpsOf(amountIn, amountOut, spot, DECIMALS.ONLYONE, HEDGE_STABLE.decimals);
    if (impactBps <= MAX_IMPACT_BPS) return { amountIn, amountOut, amountOutMin: (amountOut * 99n) / 100n, impactBps };
    amountIn = amountIn / 2n; // pool's thin at this size -- try half, re-quote against it
  }
  return null;
}

/**
 * Applies a mined swap to the deposits it hedged: the oldest unhedged
 * deposits absorb `amountIn`, same allocation as always.
 *
 * Exactly once per batch. The PENDING -> DONE flip is a guarded update that
 * runs FIRST, in the same transaction as the allocation, so a second
 * settlement of the same success (a second worker process, a retry after a
 * partial failure) matches nothing and allocates nothing -- it used to
 * advance every deposit's hedgedRaw a second time for tokens sold once.
 */
async function applyHedge(batchId: string, amountIn: bigint) {
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const claimed = await tx.treasuryHedgeBatch.updateMany({ where: { id: batchId, status: 'PENDING' }, data: { status: 'DONE', resolvedAt: now } });
    if (claimed.count !== 1) return;
    const pending = await tx.deposit.findMany({ where: { asset: 'ONLYONE', hedgedAt: null }, orderBy: { createdAt: 'asc' } });
    const alloc = allocateHedge(pending, amountIn, HEDGE_BPS);
    for (const a of alloc) {
      await tx.deposit.update({ where: { id: a.id }, data: { hedgedRaw: a.hedgedRaw.toString(), ...(a.done ? { hedgedAt: now } : {}) } });
    }
    await tx.treasuryHedgeBatch.update({ where: { id: batchId }, data: { depositCount: alloc.filter((a) => a.done).length } });
  });
}

/**
 * Settles a swap a previous cycle left PENDING (signed, persisted, maybe
 * broadcast). True when nothing is in flight any more. A receipt wait that
 * timed out used to leave nothing recorded at all, so the next cycle sold
 * the same deposits' tokens again.
 */
export async function settleInFlightHedge(client = publicClient as any): Promise<boolean> {
  const b = await prisma.treasuryHedgeBatch.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  if (!b) return true;
  const r = await resolveTreasuryTx(b.txHash as `0x${string}`, b.nonce, client);
  if (r.state === 'success') { await applyHedge(b.id, BigInt(b.onlyOneRawIn)); return true; }
  if (r.state === 'reverted' || r.state === 'dropped') {
    await prisma.treasuryHedgeBatch.updateMany({ where: { id: b.id, status: 'PENDING' }, data: { status: 'FAILED', resolvedAt: new Date() } });
    console.error(`treasury-hedge: swap ${b.txHash} ${r.state}; nothing sold`);
    return true;
  }
  console.warn(`treasury-hedge: swap ${b.txHash} still unsettled; not starting another`);
  return false;
}

async function sweep() {
  if (!ROUTER || !QUOTER || !process.env.ONLYONE_POOL) return;
  // The stablecoin side of every quote and impact figure uses HEDGE_STABLE.decimals.
  await assertStableDecimals();
  if (!(await settleInFlightHedge())) return;

  const pending = await prisma.deposit.findMany({ where: { asset: 'ONLYONE', hedgedAt: null }, orderBy: { createdAt: 'asc' } });
  if (!pending.length) return;
  // What is still owed to the hedge: each deposit's target less what earlier
  // swaps already sold for it (Deposit.hedgedRaw). Selling the full target
  // again every cycle is what kept draining the treasury's own tokens when a
  // deposit was bigger than one impact-capped slice.
  let desiredRaw = pending.reduce((s, d) => s + hedgeRemaining(d, HEDGE_BPS), 0n);
  // Never more than the treasury wallet actually holds. This caps the swap at
  // the WHOLE wallet balance, not at the deposit tokens already swept into
  // it: deposits are not tracked per sweep, so a deposit whose tokens are
  // still at the fan's deposit address is hedged out of whatever else the
  // wallet holds -- including the founder's own tokens, since the treasury
  // wallet is also his. Keep hedging off (no ONLYONE_POOL / router) unless
  // that is acceptable, or add per-deposit sweep tracking first.
  const held = await publicClient.readContract({ address: TOKENS.ONLYONE.address, abi: erc20Abi, functionName: 'balanceOf', args: [treasuryAccount().address] });
  if (held < desiredRaw) desiredRaw = held;
  if (desiredRaw <= 0n) return;

  const spot = await spotPrice();
  const sized = await sizeSwap(desiredRaw, spot);
  if (!sized) { console.warn('treasury-hedge: pool too thin for even a small slice, retrying next cycle'); return; }

  const allowance = await publicClient.readContract({ address: TOKENS.ONLYONE.address, abi: erc20Abi, functionName: 'allowance', args: [treasuryAccount().address, ROUTER] });
  if (allowance < sized.amountIn) {
    const h = await withTreasuryLock(() => treasuryWallet().writeContract({ address: TOKENS.ONLYONE.address, abi: erc20Abi, functionName: 'approve', args: [ROUTER, sized.amountIn * 10n] }));
    await publicClient.waitForTransactionReceipt({ hash: h });
  }

  const recipient = treasuryAccount().address;
  const data = encodeFunctionData({
    abi: routerAbi, functionName: 'exactInputSingle',
    args: [{ tokenIn: TOKENS.ONLYONE.address, tokenOut: HEDGE_STABLE.address, fee: POOL_FEE, recipient, amountIn: sized.amountIn, amountOutMinimum: sized.amountOutMin, sqrtPriceLimitX96: 0n }],
  });
  // The batch row exists (PENDING, with the hash) before the swap is
  // broadcast, so a timeout or restart leaves something to settle instead
  // of a swap the next cycle cannot see.
  const hash = await sendTreasuryTx({ to: ROUTER, data }, async (h, nonce) => {
    await prisma.treasuryHedgeBatch.create({ data: {
      depositCount: 0, onlyOneRawIn: sized.amountIn.toString(), usdcRawOut: sized.amountOut.toString(), priceImpactBps: Math.round(sized.impactBps), txHash: h, nonce, status: 'PENDING',
    } });
  });
  await publicClient.waitForTransactionReceipt({ hash }).catch(() => null);
  // The uncovered remainder of each deposit is intentional treasury exposure,
  // not a balance owed to anyone -- it just stays in the treasury wallet as-is.
  await settleInFlightHedge();
}

(async function loop() {
  for (;;) {
    try { await sweep(); } catch (e) { console.error('treasury-hedge', e); }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
})().catch((e) => console.error('treasury-hedge: loop crashed', e));
