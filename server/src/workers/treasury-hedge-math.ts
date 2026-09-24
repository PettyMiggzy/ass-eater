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

export type HedgeDeposit = { id: string; rawAmount: string; hedgedRaw?: string | null };

/** How much of this deposit's hedge share (hedgeBps of it) is still to be sold. */
export function hedgeRemaining(d: HedgeDeposit, hedgeBps = HEDGE_BPS): bigint {
  const target = (BigInt(d.rawAmount) * BigInt(hedgeBps)) / 10_000n;
  const left = target - BigInt(d.hedgedRaw ?? '0');
  return left > 0n ? left : 0n;
}

/**
 * Spreads a swap's amountIn across pending deposits, oldest first, INCLUDING
 * a partial share of the first one it cannot fully cover. Returns each
 * touched deposit's new cumulative hedgedRaw and whether its target is now
 * met. Without the partial share, one deposit larger than the impact-capped
 * slice was never marked at all, so every cycle re-sold the same "pending"
 * amount and kept selling the treasury's tokens past the target.
 */
export function allocateHedge(pending: HedgeDeposit[], amountIn: bigint, hedgeBps = HEDGE_BPS): { id: string; hedgedRaw: bigint; done: boolean }[] {
  let left = amountIn;
  const out: { id: string; hedgedRaw: bigint; done: boolean }[] = [];
  for (const d of pending) {
    if (left <= 0n) break;
    const need = hedgeRemaining(d, hedgeBps);
    const prior = BigInt(d.hedgedRaw ?? '0');
    if (need === 0n) { out.push({ id: d.id, hedgedRaw: prior, done: true }); continue; }
    const take = need < left ? need : left;
    left -= take;
    out.push({ id: d.id, hedgedRaw: prior + take, done: take === need });
  }
  return out;
}

/** Oldest-first: the deposits whose hedge share is fully covered by amountIn (none previously hedged). */
export function selectHedgedDeposits(pending: { id: string; rawAmount: string }[], amountIn: bigint, hedgeBps = HEDGE_BPS): string[] {
  return allocateHedge(pending, amountIn, hedgeBps).filter((a) => a.done).map((a) => a.id);
}
