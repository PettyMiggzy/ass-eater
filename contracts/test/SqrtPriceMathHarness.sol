// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {OnlyAssSqrtPriceMath} from "../libraries/OnlyAssSqrtPriceMath.sol";

/// @notice Test-only wrapper: OnlyAssSqrtPriceMath's function is `internal`,
/// so it needs an external entrypoint for Hardhat tests to call it at all.
contract SqrtPriceMathHarness {
    function toSqrtPriceX96(uint256 amount0, uint256 amount1) external pure returns (uint160) {
        return OnlyAssSqrtPriceMath.toSqrtPriceX96(amount0, amount1);
    }
}
