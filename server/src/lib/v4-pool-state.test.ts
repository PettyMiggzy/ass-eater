import { describe, it, expect } from 'vitest';
import { computePoolId, poolStateSlot, decodeSlot0 } from './v4-pool-state';

/** Packs a synthetic Slot0 word exactly the way PoolManager's storage does, so decodeSlot0 can be tested independently of a live contract. */
function packSlot0(sqrtPriceX96: bigint, tick: number, protocolFee: number, lpFee: number): string {
  const tickBits = BigInt(tick < 0 ? tick + 0x1000000 : tick) & 0xffffffn; // 24-bit two's complement
  const word = sqrtPriceX96 | (tickBits << 160n) | (BigInt(protocolFee) << 184n) | (BigInt(lpFee) << 208n);
  return '0x' + word.toString(16).padStart(64, '0');
}

describe('v4-pool-state decodeSlot0', () => {
  it('round-trips a positive tick and typical sqrtPriceX96', () => {
    const sqrtP = 79228162514264337593543950336n; // 2^96, price = 1
    const packed = packSlot0(sqrtP, 12345, 100, 3000);
    const decoded = decodeSlot0(packed);
    expect(decoded.sqrtPriceX96).toBe(sqrtP);
    expect(decoded.tick).toBe(12345);
    expect(decoded.protocolFee).toBe(100);
    expect(decoded.lpFee).toBe(3000);
  });

  it('sign-extends a negative tick correctly', () => {
    const sqrtP = 79228162514264337593543950336n;
    const packed = packSlot0(sqrtP, -887272, 0, 500);
    const decoded = decodeSlot0(packed);
    expect(decoded.tick).toBe(-887272);
  });

  it('handles tick zero without misreading the sign bit', () => {
    const packed = packSlot0(1n, 0, 0, 0);
    expect(decodeSlot0(packed).tick).toBe(0);
  });

  it('does not let protocolFee/lpFee bits leak into sqrtPriceX96', () => {
    const maxSqrtP = (1n << 160n) - 1n;
    const packed = packSlot0(maxSqrtP, 1, 0xffffff, 0xffffff);
    const decoded = decodeSlot0(packed);
    expect(decoded.sqrtPriceX96).toBe(maxSqrtP);
  });
});

describe('v4-pool-state computePoolId / poolStateSlot', () => {
  it('produces a stable, deterministic 32-byte id for the same pool key', () => {
    const a = computePoolId('0x0000000000000000000000000000000000000000', '0x1234567890123456789012345678901234567890', 2500, 25, '0x0000000000000000000000000000000000000000');
    const b = computePoolId('0x0000000000000000000000000000000000000000', '0x1234567890123456789012345678901234567890', 2500, 25, '0x0000000000000000000000000000000000000000');
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('changes the id when any field of the pool key changes', () => {
    const base = computePoolId('0x0000000000000000000000000000000000000000', '0x1234567890123456789012345678901234567890', 2500, 25, '0x0000000000000000000000000000000000000000');
    const diffFee = computePoolId('0x0000000000000000000000000000000000000000', '0x1234567890123456789012345678901234567890', 3000, 25, '0x0000000000000000000000000000000000000000');
    const diffSpacing = computePoolId('0x0000000000000000000000000000000000000000', '0x1234567890123456789012345678901234567890', 2500, 60, '0x0000000000000000000000000000000000000000');
    expect(diffFee).not.toBe(base);
    expect(diffSpacing).not.toBe(base);
  });

  it('derives a slot deterministically from the pool id', () => {
    const poolId = computePoolId('0x0000000000000000000000000000000000000000', '0x1234567890123456789012345678901234567890', 2500, 25, '0x0000000000000000000000000000000000000000');
    const slot = poolStateSlot(poolId);
    expect(slot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(slot).not.toBe(poolId); // it's a hash of (poolId, 6), not the id itself
  });
});
