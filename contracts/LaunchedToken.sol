// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

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
