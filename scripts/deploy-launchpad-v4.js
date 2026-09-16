const { ethers } = require('hardhat');
const { mineHookSalt } = require('./lib/hook-miner');

// Reads deployment inputs from the environment so nothing sensitive is
// hardcoded in the repo. Set these before running:
//   PLATFORM_WALLET_ADDRESS       - wallet that receives the launch fee, platform's token supply cut, and every swap's fixed 1% fee
//   ONLYASS_TOKEN_ADDRESS         - deployed $ONLYASS ERC-20 contract address on the target chain
//   V4_POOL_MANAGER_ADDRESS       - the chain's singleton Uniswap V4 PoolManager
//   V4_POSITION_MANAGER_ADDRESS   - the chain's canonical Uniswap V4 PositionManager (periphery)
//   PERMIT2_ADDRESS               - Permit2 on the target chain (canonically 0x000000000022D473030F116dDEE9F6B43aC78BA3
//                                   on most EVM chains -- STILL verify this against Robinhood Chain's own explorer,
//                                   the same way every other address here must be verified; do not assume it)
//
// Per contracts/ONLYASS_LAUNCH.md's existing methodology: verify every one of
// these addresses yourself via a real wallet's transaction preview on
// Robinhood Chain (or the chain's own docs/explorer for Permit2/PoolManager
// specifically) before running this. Nothing in this script can validate
// that an address you paste in is actually what it claims to be.
async function main() {
  const [deployer] = await ethers.getSigners();
  const platformWallet = process.env.PLATFORM_WALLET_ADDRESS;
  const onlyAssToken = process.env.ONLYASS_TOKEN_ADDRESS;
  const poolManager = process.env.V4_POOL_MANAGER_ADDRESS;
  const positionManager = process.env.V4_POSITION_MANAGER_ADDRESS;
  const permit2 = process.env.PERMIT2_ADDRESS;

  for (const [name, value] of Object.entries({
    PLATFORM_WALLET_ADDRESS: platformWallet,
    ONLYASS_TOKEN_ADDRESS: onlyAssToken,
    V4_POOL_MANAGER_ADDRESS: poolManager,
    V4_POSITION_MANAGER_ADDRESS: positionManager,
    PERMIT2_ADDRESS: permit2,
  })) {
    if (!value) throw new Error(`Set ${name} in the environment before deploying.`);
  }

  // --- Step 1: a fresh, permissionless CREATE2 factory just for the hook ---
  console.log('Deploying HookDeployer...');
  const hookDeployer = await (await ethers.getContractFactory('HookDeployer')).deploy();
  await hookDeployer.waitForDeployment();
  const hookDeployerAddress = await hookDeployer.getAddress();
  console.log('HookDeployer:', hookDeployerAddress);

  // --- Step 2: mine a salt so the hook's own address encodes exactly the
  // two permissions it needs (afterSwap + afterSwapReturnDelta) ---
  console.log('Mining a hook salt (this can take a few seconds)...');
  const hookFactory = await ethers.getContractFactory('OnlyAssLaunchpadHook');
  const constructorArgs = [poolManager, platformWallet, deployer.address];
  const { salt, address: hookAddress, initCode, attempts } = mineHookSalt({
    deployerAddress: hookDeployerAddress,
    creationBytecode: hookFactory.bytecode,
    constructorArgTypes: ['address', 'address', 'address'],
    constructorArgValues: constructorArgs,
  });
  console.log(`Found salt after ${attempts} attempts. Expected hook address: ${hookAddress}`);

  // --- Step 3: deploy the hook through that factory with that exact salt ---
  const deployTx = await hookDeployer.deploy(salt, initCode);
  await deployTx.wait();
  const deployedCode = await ethers.provider.getCode(hookAddress);
  if (deployedCode === '0x') {
    throw new Error('Hook deployment failed -- no code at the mined address. Do not proceed.');
  }
  console.log('OnlyAssLaunchpadHook deployed to:', hookAddress, '(matches mined address, verified on-chain)');

  // --- Step 4: deploy the launchpad, wired to the hook above ---
  console.log('Deploying OnlyAssLaunchpadV4...');
  const launchpad = await (
    await ethers.getContractFactory('OnlyAssLaunchpadV4')
  ).deploy(deployer.address, platformWallet, onlyAssToken, poolManager, positionManager, permit2, hookAddress);
  await launchpad.waitForDeployment();
  const launchpadAddress = await launchpad.getAddress();
  console.log('OnlyAssLaunchpadV4 deployed to:', launchpadAddress);

  // --- Step 5: break the deploy-order circular dependency -- only now does
  // the hook learn the launchpad's address, so it can gate registerPool ---
  console.log('Wiring hook.setLaunchpad...');
  await (await hookFactory.attach(hookAddress).connect(deployer).setLaunchpad(launchpadAddress)).wait();

  console.log('\nDone. Summary:');
  console.log('  owner (can pause / adjust fee+supply bps + graduation params within caps):', deployer.address);
  console.log('  platformWallet:', platformWallet);
  console.log('  onlyAssToken:', onlyAssToken);
  console.log('  poolManager:', poolManager);
  console.log('  positionManager:', positionManager);
  console.log('  permit2:', permit2);
  console.log('  hook:', hookAddress);
  console.log('  launchpad:', launchpadAddress);
  console.log('\nFixed 1% platform swap fee (non-adjustable), creator trading tax capped at 10%,');
  console.log('launchFeeWei 0.01 ETH / platformSupplyBps 10% (both owner-adjustable within hard caps),');
  console.log('graduation bonus 0.5 ETH creator / 0.5 ETH platform at 500,000 $ONLYASS cumulative volume');
  console.log('(all three graduation params owner-adjustable; the bonus pool needs separate funding via');
  console.log('launchpad.fundGraduationPool() -- it is NOT funded automatically by trading fees).');
  console.log('\nSet NEXT_PUBLIC_LAUNCHPAD_V4_CONTRACT_ADDRESS to the launchpad address above in Vercel.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
