'use strict';

// Pure math for bootstrapping a Uniswap V3 pool -- split out from the deploy
// script so the price/tick math (the part most likely to hide a costly bug:
// get the direction or decimals wrong and you initialize the pool at a wildly
// wrong price, letting the first bot through drain it) can be unit tested
// without touching a chain.

/** Integer square root via Newton's method. Exact for perfect squares, floors otherwise. */
function isqrt(n) {
  if (n < 0n) throw new Error('isqrt of negative number');
  if (n < 2n) return n;
  let x0 = n;
  let x1 = (n >> 1n) + 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x1 + n / x1) >> 1n;
  }
  return x0;
}

/** Parses a decimal string like "0.75" or "1250" into an exact num/den BigInt fraction. */
function decimalToFraction(str) {
  const s = String(str).trim();
  const [whole, frac = ''] = s.split('.');
  const den = 10n ** BigInt(frac.length);
  const num = BigInt((whole || '0') + frac || '0');
  return { num, den };
}

/**
 * sqrtPriceX96 for Uniswap V3's slot0, given a human-readable price expressed
 * as "how many token1 (human units) per 1 token0 (human units)".
 * sqrtPriceX96 = sqrt(price_raw) * 2^96, where price_raw = price_human * 10^(decimals1 - decimals0)
 * (raw/wei-unit price differs from the human price by the decimals gap).
 */
function sqrtPriceX96FromPrice(priceHuman, decimals0, decimals1) {
  const { num, den } = decimalToFraction(priceHuman);
  const decDiff = decimals1 - decimals0;
  let numerator = num;
  let denominator = den;
  if (decDiff >= 0) numerator *= 10n ** BigInt(decDiff);
  else denominator *= 10n ** BigInt(-decDiff);
  numerator <<= 192n; // scale by 2^192 so the sqrt lands pre-multiplied by 2^96
  return isqrt(numerator / denominator);
}

/** Uniswap V3 sorts pool tokens by address value ascending. Returns which of the two inputs is token0. */
function sortTokens(addrA, addrB) {
  const a = BigInt(addrA);
  const b = BigInt(addrB);
  if (a === b) throw new Error('identical addresses');
  return a < b
    ? { token0: addrA, token1: addrB, swapped: false }
    : { token0: addrB, token1: addrA, swapped: true };
}

/** Standard usable tick range aligned to a fee tier's tick spacing -- the conventional "full range" position. */
const MIN_TICK = -887272;
const MAX_TICK = 887272;
function fullRangeTicks(tickSpacing) {
  const tickLower = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const tickUpper = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return { tickLower, tickUpper };
}

const TICK_SPACING_BY_FEE = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

module.exports = { isqrt, decimalToFraction, sqrtPriceX96FromPrice, sortTokens, fullRangeTicks, TICK_SPACING_BY_FEE };
