// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IOnlyAssLaunchpadV4Views} from "../OnlyAssPayments.sol";

/// @dev Test-only stand-in for OnlyAssLaunchpadV4's view surface, so
/// OnlyAssPayments' payWithCreatorToken can be unit-tested against a
/// controlled set of "launches" without spinning up the full V4 stack
/// (already covered end-to-end by OnlyAssLaunchpadV4's own test suite).
contract MockLaunchpadViews is IOnlyAssLaunchpadV4Views {
    struct Launch {
        address token;
        address creator;
    }

    Launch[] public allLaunches;
    mapping(address => uint256[]) public byCreator;

    function addLaunch(address creator, address token) external returns (uint256 id) {
        id = allLaunches.length;
        allLaunches.push(Launch({token: token, creator: creator}));
        byCreator[creator].push(id);
    }

    function launchesOf(address creator) external view returns (uint256[] memory) {
        return byCreator[creator];
    }

    function launches(uint256 launchId)
        external
        view
        returns (address token, address creator, bytes32 poolId, uint256 positionTokenId, uint256 unlockTime, bool liquidityWithdrawn, bool graduationPaid)
    {
        Launch memory l = allLaunches[launchId];
        return (l.token, l.creator, bytes32(0), 0, 0, false, false);
    }
}
