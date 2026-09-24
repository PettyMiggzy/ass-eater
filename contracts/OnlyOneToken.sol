// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title OnlyOneToken ($ONLYONE)
/// @notice A fixed-supply ERC20. The entire supply is minted once, in the
/// constructor, to whatever address deploys it -- there is no mint function,
/// so supply can never be inflated after deploy.
/// @dev NOT the live $ONLYONE. The live token (Robinhood Chain,
/// 0x2c34ED86552076715272056D021cEab6080F1Ab5) was deployed from the
/// founder's own launchpad, not from this repo. Kept for tests and testnet
/// experiments only; scripts/deploy-onlyone-token.js refuses production chains.
contract OnlyOneToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_)
        ERC20(name_, symbol_)
    {
        _mint(msg.sender, totalSupply_);
    }
}
