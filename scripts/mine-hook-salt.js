const { ethers } = require('hardhat');
const { mineHookSalt } = require('./lib/hook-miner');

// Standalone dry-run: prints the salt + resulting address for
// OnlyAssLaunchpadHook without deploying anything. `deploy-launchpad-v4.js`
// does this same mining inline as part of the real deploy -- this script
// exists purely so the address can be previewed/audited ahead of time (e.g.
// to confirm reproducibility, or hand the address to an auditor before
// spending gas on a real deploy).
//
//   HOOK_DEPLOYER_ADDRESS   - an already-deployed HookDeployer (deploy one
//                             with a throwaway script/console first if you
//                             just want to preview an address)
//   PLATFORM_WALLET_ADDRESS - passed straight through as a constructor arg
//   V4_POOL_MANAGER_ADDRESS - passed straight through as a constructor arg
//   OWNER_ADDRESS           - passed straight through as a constructor arg (defaults to the signer)
async function main() {
  const [deployer] = await ethers.getSigners();
  const hookDeployerAddress = process.env.HOOK_DEPLOYER_ADDRESS;
  const platformWallet = process.env.PLATFORM_WALLET_ADDRESS;
  const poolManager = process.env.V4_POOL_MANAGER_ADDRESS;
  const owner = process.env.OWNER_ADDRESS || deployer.address;

  if (!hookDeployerAddress) throw new Error('Set HOOK_DEPLOYER_ADDRESS in the environment first.');
  if (!platformWallet) throw new Error('Set PLATFORM_WALLET_ADDRESS in the environment first.');
  if (!poolManager) throw new Error('Set V4_POOL_MANAGER_ADDRESS in the environment first.');

  const hookFactory = await ethers.getContractFactory('OnlyAssLaunchpadHook');
  const { salt, address, attempts } = mineHookSalt({
    deployerAddress: hookDeployerAddress,
    creationBytecode: hookFactory.bytecode,
    constructorArgTypes: ['address', 'address', 'address'],
    constructorArgValues: [poolManager, platformWallet, owner],
  });

  console.log('salt:', salt);
  console.log('expected hook address:', address);
  console.log(`(found after ${attempts} attempts)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
