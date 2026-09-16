// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice The launchpad-facing slice of OnlyAssLaunchpadHook's interface.
interface IOnlyAssLaunchpadHook {
    function registerPool(PoolKey calldata key, address onlyAssToken, address creatorWallet, uint256 creatorTaxBps)
        external;

    function cumulativeOnlyAssVolume(PoolId poolId) external view returns (uint256);
}
