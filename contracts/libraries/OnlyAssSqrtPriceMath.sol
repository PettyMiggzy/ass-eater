// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title OnlyAssSqrtPriceMath
/// @notice Converts a plain "amount0 : amount1" ratio into the Q64.96
/// `sqrtPriceX96` Uniswap V4's `PoolManager.initialize` expects. Same concept
/// `test/v3-pool-math.test.js` already unit-tests for the V3 seeding script --
/// V3 and V4 use the identical sqrtPriceX96 representation, this is just the
/// on-chain equivalent so a creator can supply plain token amounts (like the
/// existing V2 launchpad's `onlyAssForLiquidity`) instead of having to
/// pre-compute a sqrt price themselves off-chain.
/// @dev Deliberately its own tiny library (rather than reaching into
/// the `uniswap/v4-core` package's bundled `lib/solmate` submodule path) so it only
/// depends on packages this repo already declares directly.
library OnlyAssSqrtPriceMath {
    error ZeroAmount();
    /// @notice Thrown when amount1:amount0 exceeds ~1.8e19:1 (2^64), the point
    /// at which `amount1 * 2^192` (the intermediate this needs) would no
    /// longer fit in 256 bits regardless of `amount0`. Not a real-world
    /// launch scenario -- MIN_LIQUIDITY_BPS already keeps both sides a
    /// meaningful fraction of a real token supply -- but a raw, unguarded
    /// `FullMath.mulDiv` call would otherwise fail this case with an opaque
    /// `require(denominator > prod1)` three call-frames deep instead of a
    /// clear, attributable error.
    error RatioOutOfRange();

    /// @param amount0 Raw amount of currency0 being seeded.
    /// @param amount1 Raw amount of currency1 being seeded.
    /// @return sqrtPriceX96 sqrt(amount1 / amount0) * 2^96, floored.
    function toSqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160 sqrtPriceX96) {
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();
        if (amount1 / amount0 >= (1 << 64)) revert RatioOutOfRange();
        // priceX192 = (amount1 / amount0) * 2^192, computed via a 512-bit-safe
        // mulDiv since amount1 * 2^192 alone overflows a uint256.
        uint256 priceX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
        sqrtPriceX96 = uint160(Math.sqrt(priceX192));
    }
}
