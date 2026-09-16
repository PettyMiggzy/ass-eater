const { expect } = require('chai');
const { computePoolId, poolStateSlot, decodeSlot0 } = require('../scripts/lib/v4-pool-math');

function packSlot0(sqrtPriceX96, tick, protocolFee, lpFee) {
  const tickBits = BigInt(tick < 0 ? tick + 0x1000000 : tick) & 0xffffffn;
  const word = sqrtPriceX96 | (tickBits << 160n) | (BigInt(protocolFee) << 184n) | (BigInt(lpFee) << 208n);
  return '0x' + word.toString(16).padStart(64, '0');
}

describe('v4-pool-math decodeSlot0', () => {
  it('round-trips a positive tick and typical sqrtPriceX96', () => {
    const sqrtP = 79228162514264337593543950336n; // 2^96
    const decoded = decodeSlot0(packSlot0(sqrtP, 12345, 100, 3000));
    expect(decoded.sqrtPriceX96).to.equal(sqrtP);
    expect(decoded.tick).to.equal(12345);
    expect(decoded.protocolFee).to.equal(100);
    expect(decoded.lpFee).to.equal(3000);
  });

  it('sign-extends a negative tick correctly', () => {
    const decoded = decodeSlot0(packSlot0(79228162514264337593543950336n, -887272, 0, 500));
    expect(decoded.tick).to.equal(-887272);
  });
});

describe('v4-pool-math computePoolId / poolStateSlot', () => {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const TOKEN = '0x1234567890123456789012345678901234567890';

  it('is deterministic', () => {
    expect(computePoolId(ZERO, TOKEN, 2500, 25, ZERO)).to.equal(computePoolId(ZERO, TOKEN, 2500, 25, ZERO));
  });

  it('changes when any pool key field changes', () => {
    const base = computePoolId(ZERO, TOKEN, 2500, 25, ZERO);
    expect(computePoolId(ZERO, TOKEN, 3000, 25, ZERO)).to.not.equal(base);
    expect(computePoolId(ZERO, TOKEN, 2500, 60, ZERO)).to.not.equal(base);
  });

  it('derives a 32-byte slot from the pool id', () => {
    const poolId = computePoolId(ZERO, TOKEN, 2500, 25, ZERO);
    const slot = poolStateSlot(poolId);
    expect(slot).to.match(/^0x[0-9a-f]{64}$/);
    expect(slot).to.not.equal(poolId);
  });
});
