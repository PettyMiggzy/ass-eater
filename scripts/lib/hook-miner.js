'use strict';

const { keccak256, getCreate2Address, AbiCoder } = require('ethers');

// Uniswap V4 decides which hook callbacks fire by reading the low 14 bits of
// the HOOK CONTRACT'S OWN ADDRESS (not any config value) -- see
// @uniswap/v4-core's Hooks.sol top-of-file comment. Since a contract's
// address is fixed once deployed, the only way to control those bits is to
// mine a CREATE2 salt that happens to produce an address with exactly the
// bits you want set, then deploy through that salt. This is the standard
// "HookMiner" pattern every V4 hook deployment uses (Uniswap's own
// v4-periphery ships a Foundry version of this same idea).
const ALL_HOOK_MASK = (1n << 14n) - 1n;

const HOOK_FLAGS = {
  BEFORE_INITIALIZE: 1n << 13n,
  AFTER_INITIALIZE: 1n << 12n,
  BEFORE_ADD_LIQUIDITY: 1n << 11n,
  AFTER_ADD_LIQUIDITY: 1n << 10n,
  BEFORE_REMOVE_LIQUIDITY: 1n << 9n,
  AFTER_REMOVE_LIQUIDITY: 1n << 8n,
  BEFORE_SWAP: 1n << 7n,
  AFTER_SWAP: 1n << 6n,
  BEFORE_DONATE: 1n << 5n,
  AFTER_DONATE: 1n << 4n,
  BEFORE_SWAP_RETURNS_DELTA: 1n << 3n,
  AFTER_SWAP_RETURNS_DELTA: 1n << 2n,
  AFTER_ADD_LIQUIDITY_RETURNS_DELTA: 1n << 1n,
  AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA: 1n << 0n,
};

// OnlyAssLaunchpadHook only ever uses these two.
const ONLYASS_HOOK_FLAGS = HOOK_FLAGS.AFTER_SWAP | HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA;

function initCodeHash(creationBytecode, constructorArgTypes, constructorArgValues) {
  const encodedArgs =
    constructorArgTypes.length > 0 ? AbiCoder.defaultAbiCoder().encode(constructorArgTypes, constructorArgValues) : '0x';
  const initCode = creationBytecode + encodedArgs.slice(2);
  return { initCode, hash: keccak256(initCode) };
}

/// Finds a salt such that CREATE2(deployerAddress, salt, initCodeHash) has an
/// address whose low 14 bits equal `desiredFlags` exactly (not just a
/// superset -- Hooks.validateHookPermissions rejects any extra flag bit too).
/// @param deployerAddress The CREATE2 factory (HookDeployer) address -- the
/// deployer, not the hook, since HookDeployer does `create2` in its own
/// context (`address(this)` there is HookDeployer, not the eventual caller).
function mineHookSalt({ deployerAddress, creationBytecode, constructorArgTypes = [], constructorArgValues = [], desiredFlags = ONLYASS_HOOK_FLAGS, startSalt = 0n, maxAttempts = 5_000_000 }) {
  const { initCode, hash: initCodeHashHex } = initCodeHash(creationBytecode, constructorArgTypes, constructorArgValues);

  for (let i = 0n; i < BigInt(maxAttempts); i++) {
    const salt = startSalt + i;
    const saltHex = '0x' + salt.toString(16).padStart(64, '0');
    const candidate = getCreate2Address(deployerAddress, saltHex, initCodeHashHex);
    const flags = BigInt(candidate) & ALL_HOOK_MASK;
    if (flags === desiredFlags) {
      return { salt: saltHex, address: candidate, initCode, attempts: i + 1n };
    }
  }
  throw new Error(`mineHookSalt: no salt found for flags 0x${desiredFlags.toString(16)} within ${maxAttempts} attempts`);
}

module.exports = { HOOK_FLAGS, ALL_HOOK_MASK, ONLYASS_HOOK_FLAGS, initCodeHash, mineHookSalt };
