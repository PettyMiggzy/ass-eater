// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Test-only, split out from V4TestDeployment.sol purely because Permit2 is
// pinned to exactly this solc version upstream, incompatible with the 0.8.26
// used by the rest of the V4 test-deployment forcing-imports. See this repo's
// production contracts (OnlyAssLaunchpadV4.sol) for the real, unpinned
// interface-only dependency on Permit2 (IAllowanceTransfer) -- this concrete
// contract is only ever deployed for local Hardhat integration tests.
import {Permit2} from "permit2/src/Permit2.sol";
