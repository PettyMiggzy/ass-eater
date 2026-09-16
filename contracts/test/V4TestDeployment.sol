// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only: forces Hardhat to compile real Uniswap V4 core/periphery/permit2
// contracts (not just their interfaces) so integration tests can deploy a
// real PoolManager/PositionManager/Permit2/PoolSwapTest locally and exercise
// OnlyAssLaunchpadV4 + OnlyAssLaunchpadHook end to end, instead of only
// unit-testing pure math against mocks. None of these imports are used by
// any production contract in this repo -- OnlyAssLaunchpadHook.sol and
// OnlyAssLaunchpadV4.sol only ever import the MIT-licensed interfaces
// (IPoolManager, IPositionManager, ...), never these concrete contracts, so
// this file's PoolManager import (BUSL-1.1 licensed upstream) never ships in
// anything this repo deploys.
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
// Permit2 itself is pinned to solc 0.8.17 upstream -- pulled in from a
// separate file (PermitTestDeployment.sol) at that exact version instead of
// from here, since a file can't import another pinned to an incompatible
// exact version. Only its interface (version-flexible, `^0.8.0`) is needed
// by anything at 0.8.26.
