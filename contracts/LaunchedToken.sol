// SPDX-License-Identifier: MIT
// Deliberately a range, not an exact pin: this token is deployed by both the
// V2 launchpad (compiled at 0.8.24) and the V4 launchpad (compiled at 0.8.26,
// matching @uniswap/v4-core's own pinned version) -- see hardhat.config.js.
pragma solidity >=0.8.24 <=0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LaunchedToken
/// @notice Fixed-supply ERC20 deployed by OnlyAssLaunchpad for a single creator
/// launch. The entire supply is minted once, to the launchpad itself, in the
/// constructor -- there is no mint function, so this token can never inflate
/// beyond what OnlyAssLaunchpad.launchToken() decided at deploy time.
contract LaunchedToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_, address mintTo)
        ERC20(name_, symbol_)
    {
        _mint(mintTo, totalSupply_);
    }
}
