import { formatUnits } from 'viem';

// Pure math for the treasury-hedge worker, split out so it can be unit tested
// without importing the worker's chain client (which reads wallet secrets from
// env at import time) or its infinite polling loop.

const HEDGE_BPS = Number(process.env.TREASURY_HEDGE_BPS ?? 7500);

/** How far a quoted trade's effective price sits below spot, in bps. Never negative -- a quote beating spot is not "negative impact". */
export function impactBpsOf(amountIn: bigint, amountOut: bigint, spot: number, decimalsIn: number, decimalsOut: number): number {
  const effectivePrice = Number(formatUnits(amountOut, decimalsOut)) / Number(formatUnits(amountIn, decimalsIn));
  return Math.max(0, ((spot - effectivePrice) / spot) * 10_000);
}

/** Oldest-first: a deposit is "done" once its hedgeBps share is covered by amountIn actually swapped. */
export function selectHedgedDeposits(pending: { id: string; rawAmount: string }[], amountIn: bigint, hedgeBps = HEDGE_BPS): string[] {
  let covered = 0n;
  const doneIds: string[] = [];
  for (const d of pending) {
    const need = (BigInt(d.rawAmount) * BigInt(hedgeBps)) / 10_000n;
    if (covered + need > amountIn) break;
    covered += need; doneIds.push(d.id);
  }
  return doneIds;
}
