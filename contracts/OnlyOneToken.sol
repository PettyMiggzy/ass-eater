// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title OnlyOneToken ($ONLYONE)
/// @notice The platform's own fixed-supply ERC20. The entire supply is minted
/// once, in the constructor, to whatever address deploys it (the treasury) --
/// there is no mint function, so supply can never be inflated after launch.
/// Same fixed-supply-at-deploy pattern as LaunchedToken.sol, which creator
/// the rest of this repo already relies on and has been tested against.
contract OnlyOneToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_)
        ERC20(name_, symbol_)
    {
        _mint(msg.sender, totalSupply_);
    }
}
