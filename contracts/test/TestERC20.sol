// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only stand-in for $ONLYASS. Never deployed anywhere real --
/// OnlyAssLaunchpad takes the real $ONLYASS address as a constructor param.
contract TestERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 initialSupply, address mintTo)
        ERC20(name_, symbol_)
    {
        _mint(mintTo, initialSupply);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
