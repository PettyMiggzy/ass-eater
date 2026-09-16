const { expect } = require('chai');
const { getCreate2Address, keccak256 } = require('ethers');
const { mineHookSalt, ONLYASS_HOOK_FLAGS, ALL_HOOK_MASK, HOOK_FLAGS } = require('../scripts/lib/hook-miner');

const DEPLOYER = '0x0000000000000000000000000000000000000001';
// Arbitrary stand-in "creation bytecode" -- the miner treats it as opaque
// bytes, so a real contract's bytecode isn't needed to test the search logic.
const FAKE_CREATION_CODE = '0x600a600c600039600a6000f3600035ff';

describe('hook-miner', () => {
  it('finds a salt whose resulting address has exactly the desired low-14 flag bits', () => {
    const { salt, address } = mineHookSalt({
      deployerAddress: DEPLOYER,
      creationBytecode: FAKE_CREATION_CODE,
      constructorArgTypes: [],
      constructorArgValues: [],
      desiredFlags: ONLYASS_HOOK_FLAGS,
    });

    expect(BigInt(address) & ALL_HOOK_MASK).to.equal(ONLYASS_HOOK_FLAGS);

    // Cross-check against ethers' own CREATE2 address computation directly,
    // independent of mineHookSalt's internals.
    const initCodeHash = keccak256(FAKE_CREATION_CODE);
    expect(getCreate2Address(DEPLOYER, salt, initCodeHash)).to.equal(address);
  });

  it('is deterministic for the same inputs', () => {
    const args = {
      deployerAddress: DEPLOYER,
      creationBytecode: FAKE_CREATION_CODE,
      desiredFlags: ONLYASS_HOOK_FLAGS,
    };
    const first = mineHookSalt(args);
    const second = mineHookSalt(args);
    expect(second.salt).to.equal(first.salt);
    expect(second.address).to.equal(first.address);
  });

  it('finds a different, still-correct salt for a different flag combination', () => {
    const desiredFlags = HOOK_FLAGS.BEFORE_SWAP | HOOK_FLAGS.AFTER_INITIALIZE;
    const { address } = mineHookSalt({
      deployerAddress: DEPLOYER,
      creationBytecode: FAKE_CREATION_CODE,
      desiredFlags,
    });
    expect(BigInt(address) & ALL_HOOK_MASK).to.equal(desiredFlags);
  });

  it('bakes constructor args into the init code hash (different args -> different address for the same salt)', () => {
    const base = { deployerAddress: DEPLOYER, creationBytecode: FAKE_CREATION_CODE, desiredFlags: ONLYASS_HOOK_FLAGS };
    const a = mineHookSalt({ ...base, constructorArgTypes: ['address'], constructorArgValues: ['0x0000000000000000000000000000000000000002'] });
    const b = mineHookSalt({ ...base, constructorArgTypes: ['address'], constructorArgValues: ['0x0000000000000000000000000000000000000003'] });
    expect(a.address).to.not.equal(b.address);
  });

  it('throws instead of returning a wrong address when no salt is found within the attempt budget', () => {
    expect(() =>
      mineHookSalt({
        deployerAddress: DEPLOYER,
        creationBytecode: FAKE_CREATION_CODE,
        desiredFlags: ONLYASS_HOOK_FLAGS,
        maxAttempts: 0, // the search loop never runs -- deterministically throws, no flakiness
      }),
    ).to.throw(/no salt found/);
  });
});
