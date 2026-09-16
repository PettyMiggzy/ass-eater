// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title HookDeployer
/// @notice A tiny, permissionless CREATE2 factory used exactly once, to
/// deploy `OnlyAssLaunchpadHook` to an address whose low bits encode its
/// Uniswap V4 hook permissions (see Hooks.sol / mine-hook-salt.js). Deploying
/// this ourselves -- rather than depending on Robinhood Chain already having
/// the canonical `0x4e59b44847b379578588920cA78FbF26c0B4956C` deterministic
/// deployer that most EVM chains ship -- means this whole flow doesn't rest
/// on an assumption nobody in this repo has verified for this chain.
/// @dev Permissionless by design: CREATE2's address is fully determined by
/// (deployer address, salt, creationCode), so anyone calling `deploy` with a
/// given salt+creationCode gets the exact same, pre-committed result -- there
/// is nothing for an arbitrary caller to grief here.
contract HookDeployer {
    event Deployed(address indexed addr, bytes32 salt);

    error DeployFailed();

    function deploy(bytes32 salt, bytes memory creationCode) external returns (address addr) {
        assembly {
            addr := create2(0, add(creationCode, 0x20), mload(creationCode), salt)
        }
        if (addr == address(0)) revert DeployFailed();
        emit Deployed(addr, salt);
    }

    function computeAddress(bytes32 salt, bytes32 creationCodeHash) external view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, creationCodeHash))))
        );
    }
}
