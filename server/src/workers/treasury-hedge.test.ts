import { describe, it, expect } from 'vitest';
import { parseUnits } from 'viem';
import { impactBpsOf, selectHedgedDeposits } from './treasury-hedge-math';

describe('treasury-hedge impactBpsOf', () => {
  it('reads zero impact when the quote matches spot exactly', () => {
    const amountIn = parseUnits('100', 18);   // 100 $ONLYASS
    const amountOut = parseUnits('50', 6);    // at spot 0.50 USDC
    expect(impactBpsOf(amountIn, amountOut, 0.5, 18, 6)).toBe(0);
  });

  it('reports the shortfall in bps when the quote comes in below spot', () => {
    const amountIn = parseUnits('100', 18);
    const amountOut = parseUnits('48.5', 6); // 3% worse than spot
    expect(impactBpsOf(amountIn, amountOut, 0.5, 18, 6)).toBeCloseTo(300, 0);
  });

  it('never reports negative impact when the quote beats spot', () => {
    const amountIn = parseUnits('100', 18);
    const amountOut = parseUnits('51', 6);
    expect(impactBpsOf(amountIn, amountOut, 0.5, 18, 6)).toBe(0);
  });
});

describe('treasury-hedge selectHedgedDeposits', () => {
  const dep = (id: string, raw: string) => ({ id, rawAmount: raw });

  it('marks a deposit done once its hedge share fits under the swapped amount', () => {
    // 75% hedge share of a 1000-raw deposit needs 750 swapped.
    const ids = selectHedgedDeposits([dep('a', '1000')], 750n, 7500);
    expect(ids).toEqual(['a']);
  });

  it('leaves a deposit pending when the swap only partially covers its hedge share', () => {
    const ids = selectHedgedDeposits([dep('a', '1000')], 749n, 7500);
    expect(ids).toEqual([]);
  });

  it('processes oldest-first and stops at the first deposit that does not fit', () => {
    // three deposits each needing 750 (75% of 1000); a swap of 1600 covers exactly two.
    const ids = selectHedgedDeposits([dep('a', '1000'), dep('b', '1000'), dep('c', '1000')], 1600n, 7500);
    expect(ids).toEqual(['a', 'b']);
  });

  it('never skips ahead to a later deposit that would fit when an earlier one does not', () => {
    // 'a' needs 750 which fits in 800, but nothing is left over for 'b' also needing 750.
    const ids = selectHedgedDeposits([dep('a', '1000'), dep('b', '1000')], 800n, 7500);
    expect(ids).toEqual(['a']);
  });

  it('returns nothing pending zero deposits', () => {
    expect(selectHedgedDeposits([], 1000n, 7500)).toEqual([]);
  });
});
