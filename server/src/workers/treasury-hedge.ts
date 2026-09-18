import { parseAbi, type Address } from 'viem';
import { prisma } from '../lib/prisma';
import { publicClient, treasury, treasuryClient, TOKENS, DECIMALS, erc20Abi } from '../lib/chain';
import { impactBpsOf, selectHedgedDeposits } from './treasury-hedge-math';

// Fans can deposit $ONLYONE to burn for VIP (core/vip.ts). That balance is
// booked in fixed USD cents at the price on the day it arrived, but the tokens
// backing it are volatile -- if $ONLYONE drops before the platform does
// anything with them, the treasury is short against a liability it recorded in
// dollars. This worker converts most of each new deposit into the stablecoin
// right away, keeping a slice as intentional token exposure, and caps trade
// size so it doesn't crater its own early, thin liquidity in the process.
//
// No-ops entirely until UNISWAP_V3_ROUTER_ADDRESS / UNISWAP_V3_QUOTER_ADDRESS /
// ONLYASS_POOL are set -- i.e. until $ONLYASS actually has a live market.

const HEDGE_BPS = Number(process.env.TREASURY_HEDGE_BPS ?? 7500); // % of new $ONLYASS converted to stablecoin; rest stays as treasury exposure
const MAX_IMPACT_BPS = Number(process.env.TREASURY_HEDGE_MAX_IMPACT_BPS ?? 300); // max acceptable price impact per swap
const INTERVAL_MS = Number(process.env.TREASURY_HEDGE_INTERVAL_MS ?? 300_000);
const POOL_FEE = Number(process.env.ONLYASS_POOL_FEE ?? 3000); // Uniswap V3 fee tier (hundredths of a bip)
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
  const [sqrtP] = await publicClient.readContract({ address: process.env.ONLYASS_POOL as Address, abi: univ3Abi, functionName: 'slot0' });
  const dec0 = Number(process.env.ONLYASS_POOL_TOKEN0_DECIMALS), dec1 = Number(process.env.ONLYASS_POOL_TOKEN1_DECIMALS);
  const ratio = (Number(sqrtP) / 2 ** 96) ** 2 * 10 ** (dec0 - dec1);
  return process.env.ONLYASS_IS_TOKEN0 === 'true' ? ratio : 1 / ratio;
}

/** Quote the trade and shrink it until price impact vs spot is under the cap. Returns null if even a small slice is too much for the pool right now. */
async function sizeSwap(desiredRaw: bigint, spot: number): Promise<{ amountIn: bigint; amountOut: bigint; amountOutMin: bigint; impactBps: number } | null> {
  let amountIn = desiredRaw;
  for (let i = 0; i < 5 && amountIn > 0n; i++) {
    const { result } = await publicClient.simulateContract({
      address: QUOTER!, abi: quoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: TOKENS.ONLYASS.address, tokenOut: TOKENS.USDG.address, amountIn, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
    });
    const [amountOut] = result as unknown as [bigint, bigint, number, bigint];
    const impactBps = impactBpsOf(amountIn, amountOut, spot, DECIMALS.ONLYASS, DECIMALS.USDG);
    if (impactBps <= MAX_IMPACT_BPS) return { amountIn, amountOut, amountOutMin: (amountOut * 99n) / 100n, impactBps };
    amountIn = amountIn / 2n; // pool's thin at this size -- try half, re-quote against it
  }
  return null;
}

async function sweep() {
  if (!ROUTER || !QUOTER || !process.env.ONLYASS_POOL) return;

  const pending = await prisma.deposit.findMany({ where: { asset: 'ONLYASS', hedgedAt: null }, orderBy: { createdAt: 'asc' } });
  if (!pending.length) return;
  const totalRaw = pending.reduce((s, d) => s + BigInt(d.rawAmount), 0n);
  const desiredRaw = (totalRaw * BigInt(HEDGE_BPS)) / 10_000n;
  if (desiredRaw <= 0n) return;

  const spot = await spotPrice();
  const sized = await sizeSwap(desiredRaw, spot);
  if (!sized) { console.warn('treasury-hedge: pool too thin for even a small slice, retrying next cycle'); return; }

  const allowance = await publicClient.readContract({ address: TOKENS.ONLYASS.address, abi: erc20Abi, functionName: 'allowance', args: [treasury.address, ROUTER] });
  if (allowance < sized.amountIn) {
    const h = await treasuryClient.writeContract({ address: TOKENS.ONLYASS.address, abi: erc20Abi, functionName: 'approve', args: [ROUTER, sized.amountIn * 10n] });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }

  const hash = await treasuryClient.writeContract({
    address: ROUTER, abi: routerAbi, functionName: 'exactInputSingle',
    args: [{ tokenIn: TOKENS.ONLYASS.address, tokenOut: TOKENS.USDG.address, fee: POOL_FEE, recipient: treasury.address, amountIn: sized.amountIn, amountOutMinimum: sized.amountOutMin, sqrtPriceLimitX96: 0n }],
  });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') { console.error('treasury-hedge: swap reverted', hash); return; }

  // The uncovered remainder of each deposit is intentional treasury exposure,
  // not a balance owed to anyone -- it just stays in the treasury wallet as-is.
  const doneIds = selectHedgedDeposits(pending, sized.amountIn);
  if (doneIds.length) await prisma.deposit.updateMany({ where: { id: { in: doneIds } }, data: { hedgedAt: new Date() } });

  await prisma.treasuryHedgeBatch.create({ data: {
    depositCount: doneIds.length, onlyAssRawIn: sized.amountIn.toString(), usdcRawOut: sized.amountOut.toString(), priceImpactBps: Math.round(sized.impactBps), txHash: hash,
  } });
}

(async function loop() {
  for (;;) {
    try { await sweep(); } catch (e) { console.error('treasury-hedge', e); }
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
})();
