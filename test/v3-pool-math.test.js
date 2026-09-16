const { expect } = require('chai');
const { isqrt, sqrtPriceX96FromPrice, sortTokens, fullRangeTicks, TICK_SPACING_BY_FEE } = require('../scripts/lib/v3-pool-math');

const Q96 = 2n ** 96n;

describe('v3-pool-math isqrt', () => {
  it('is exact for perfect squares', () => {
    expect(isqrt(144n)).to.equal(12n);
    expect(isqrt(0n)).to.equal(0n);
    expect(isqrt(1n)).to.equal(1n);
  });

  it('floors for non-perfect squares', () => {
    expect(isqrt(10n)).to.equal(3n); // 3^2=9 <= 10 < 16=4^2
    expect(isqrt(99n)).to.equal(9n);
  });

  it('rejects negative input', () => {
    expect(() => isqrt(-1n)).to.throw();
  });
});

describe('v3-pool-math sqrtPriceX96FromPrice', () => {
  it('matches the textbook price=1, equal-decimals case (sqrtPriceX96 = 2^96)', () => {
    expect(sqrtPriceX96FromPrice('1', 18, 18)).to.equal(Q96);
  });

  it('recovers back to the same human price after decoding, for equal decimals', () => {
    // decode: price = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0-decimals1)
    const sqrtP = sqrtPriceX96FromPrice('0.25', 18, 18);
    const priceBack = Number(sqrtP) ** 2 / Number(Q96) ** 2;
    expect(priceBack).to.be.closeTo(0.25, 1e-9);
  });

  it('accounts for a decimals gap between token0 and token1 (e.g. 18-decimal ONLYASS priced in 6-decimal USDG)', () => {
    // 1 ONLYASS (18 dec, token0) = 0.5 USDG (6 dec, token1) => human price (token1 per token0) = 0.5
    const sqrtP = sqrtPriceX96FromPrice('0.5', 18, 6);
    const priceRaw = Number(sqrtP) ** 2 / Number(Q96) ** 2; // raw (wei-unit) price
    const priceHuman = priceRaw / 10 ** (6 - 18); // undo the decimals adjustment
    expect(priceHuman).to.be.closeTo(0.5, 1e-6);
  });

  it('handles a price greater than 1', () => {
    const sqrtP = sqrtPriceX96FromPrice('4', 18, 18);
    const priceBack = Number(sqrtP) ** 2 / Number(Q96) ** 2;
    expect(priceBack).to.be.closeTo(4, 1e-9);
  });
});

describe('v3-pool-math sortTokens', () => {
  it('orders the numerically smaller address as token0', () => {
    const a = '0x0000000000000000000000000000000000000001';
    const b = '0x0000000000000000000000000000000000000002';
    expect(sortTokens(a, b)).to.deep.equal({ token0: a, token1: b, swapped: false });
    expect(sortTokens(b, a)).to.deep.equal({ token0: a, token1: b, swapped: true });
  });

  it('rejects identical addresses', () => {
    const a = '0x0000000000000000000000000000000000000001';
    expect(() => sortTokens(a, a)).to.throw();
  });
});

describe('v3-pool-math fullRangeTicks', () => {
  for (const fee of Object.keys(TICK_SPACING_BY_FEE)) {
    it(`aligns to the tick spacing for the ${fee} fee tier`, () => {
      const spacing = TICK_SPACING_BY_FEE[fee];
      const { tickLower, tickUpper } = fullRangeTicks(spacing);
      expect(tickLower % spacing).to.equal(0);
      expect(tickUpper % spacing).to.equal(0);
      expect(tickLower).to.be.lessThan(0);
      expect(tickUpper).to.be.greaterThan(0);
      expect(tickUpper).to.equal(-tickLower); // symmetric full range
    });
  }
});
