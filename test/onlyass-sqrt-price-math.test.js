const { expect } = require('chai');
const { ethers } = require('hardhat');

const Q96 = 2n ** 96n;

// Independent JS re-implementation of the same formula the Solidity library
// uses (sqrt(amount1/amount0) * 2^96), so this test isn't just "does the
// contract agree with itself" -- same cross-check style as
// test/v3-pool-math.test.js's isqrt tests.
function isqrt(n) {
  if (n < 0n) throw new Error('isqrt of negative');
  if (n < 2n) return n;
  let x0 = n, x1 = (n >> 1n) + 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) >> 1n;
  }
  return x0;
}

function expectedSqrtPriceX96(amount0, amount1) {
  const priceX192 = (amount1 * (Q96 * Q96)) / amount0;
  return isqrt(priceX192);
}

describe('OnlyAssSqrtPriceMath', () => {
  let harness;

  beforeEach(async () => {
    const Harness = await ethers.getContractFactory('SqrtPriceMathHarness');
    harness = await Harness.deploy();
    await harness.waitForDeployment();
  });

  it('returns exactly 2^96 for an equal 1:1 ratio', async () => {
    const oneEth = ethers.parseEther('1');
    expect(await harness.toSqrtPriceX96(oneEth, oneEth)).to.equal(Q96);
  });

  it('matches an independent JS computation for a realistic launch ratio', async () => {
    const tokenLiquidity = ethers.parseEther('800000'); // 800k of the new token
    const onlyAssLiquidity = ethers.parseEther('5000'); // 5k $ONLYASS
    const result = await harness.toSqrtPriceX96(tokenLiquidity, onlyAssLiquidity);
    expect(result).to.equal(expectedSqrtPriceX96(tokenLiquidity, onlyAssLiquidity));
  });

  it('matches for a price greater than 1 (currency1 more valuable per unit)', async () => {
    const amount0 = ethers.parseEther('1000');
    const amount1 = ethers.parseEther('4000');
    const result = await harness.toSqrtPriceX96(amount0, amount1);
    expect(result).to.equal(expectedSqrtPriceX96(amount0, amount1));
    // price = (sqrtPriceX96/2^96)^2 should recover ~4
    const priceBack = Number(result) ** 2 / Number(Q96) ** 2;
    expect(priceBack).to.be.closeTo(4, 1e-6);
  });

  it('handles a realistically lopsided launch ratio (huge supply, tiny $ONLYASS) without overflowing', async () => {
    // 1e9 tokens of liquidity against a mere 0.001 $ONLYASS -- an extreme but
    // plausible fat-finger-adjacent launch, still nowhere near the library's
    // actual mathematical limit (see the RatioOutOfRange test below).
    const amount0 = ethers.parseEther('1000000000');
    const amount1 = ethers.parseUnits('0.001', 18);
    const result = await harness.toSqrtPriceX96(amount0, amount1);
    expect(result).to.equal(expectedSqrtPriceX96(amount0, amount1));
  });

  it('reverts with RatioOutOfRange rather than an opaque panic past ~1.8e19:1', async () => {
    // amount1/amount0 here is far beyond anything MIN_LIQUIDITY_BPS would
    // ever let a real launch reach -- this is the library's documented
    // mathematical ceiling (amount1*2^192 no longer fits in 256 bits), not a
    // realistic launch scenario.
    await expect(harness.toSqrtPriceX96(1n, ethers.parseEther('1000000000000'))).to.be.revertedWithCustomError(
      harness,
      'RatioOutOfRange',
    );
  });

  it('reverts on a zero amount on either side', async () => {
    const oneEth = ethers.parseEther('1');
    await expect(harness.toSqrtPriceX96(0, oneEth)).to.be.revertedWithCustomError(harness, 'ZeroAmount');
    await expect(harness.toSqrtPriceX96(oneEth, 0)).to.be.revertedWithCustomError(harness, 'ZeroAmount');
  });
});
