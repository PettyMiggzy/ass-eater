const { ethers } = require('hardhat');

// Reads deployment inputs from the environment so nothing sensitive is
// hardcoded in the repo. Set these before running:
//   PLATFORM_WALLET_ADDRESS  - wallet that receives the launch fee + platform's token supply cut
//   ONLYASS_TOKEN_ADDRESS    - deployed $ONLYASS ERC-20 contract address on the target chain
//   UNISWAP_V2_FACTORY_ADDRESS - Uniswap V2 factory on the target chain (verify on Blockscout first)
//   UNISWAP_V2_ROUTER_ADDRESS  - Uniswap V2 router on the target chain (verify on Blockscout first)
async function main() {
  const [deployer] = await ethers.getSigners();
  const platformWallet = process.env.PLATFORM_WALLET_ADDRESS;
  const onlyAssToken = process.env.ONLYASS_TOKEN_ADDRESS;
  const uniswapFactory = process.env.UNISWAP_V2_FACTORY_ADDRESS;
  const uniswapRouter = process.env.UNISWAP_V2_ROUTER_ADDRESS;

  if (!platformWallet) throw new Error('Set PLATFORM_WALLET_ADDRESS in the environment before deploying.');
  if (!onlyAssToken) throw new Error('Set ONLYASS_TOKEN_ADDRESS in the environment before deploying.');
  if (!uniswapFactory) throw new Error('Set UNISWAP_V2_FACTORY_ADDRESS in the environment before deploying.');
  if (!uniswapRouter) throw new Error('Set UNISWAP_V2_ROUTER_ADDRESS in the environment before deploying.');

  const Launchpad = await ethers.getContractFactory('OnlyAssLaunchpad');
  const launchpad = await Launchpad.deploy(deployer.address, platformWallet, onlyAssToken, uniswapFactory, uniswapRouter);
  await launchpad.waitForDeployment();

  const address = await launchpad.getAddress();
  console.log('OnlyAssLaunchpad deployed to:', address);
  console.log('owner (can pause / adjust fee+supply bps within caps):', deployer.address);
  console.log('platformWallet:', platformWallet);
  console.log('onlyAssToken:', onlyAssToken);
  console.log('uniswapFactory:', uniswapFactory);
  console.log('uniswapRouter:', uniswapRouter);
  console.log('launchFeeWei: 0.01 ETH, platformSupplyBps: 1000 (10%), both owner-adjustable within hard caps.');
  console.log('\nSet NEXT_PUBLIC_LAUNCHPAD_CONTRACT_ADDRESS to the address above in Vercel.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
