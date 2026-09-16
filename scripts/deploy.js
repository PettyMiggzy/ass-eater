const { ethers } = require('hardhat');

// Reads deployment inputs from the environment so nothing sensitive is
// hardcoded in the repo. Set these before running:
//   PLATFORM_WALLET_ADDRESS  - wallet that receives the platform's fee cut
//   PLATFORM_FEE_BPS         - fee in basis points, e.g. 1000 = 10% (defaults to 1000)
//   ONLYASS_TOKEN_ADDRESS    - deployed $ONLYASS ERC-20 contract address
//   LAUNCHPAD_V4_ADDRESS     - deployed OnlyAssLaunchpadV4 address (optional --
//                              leave unset to deploy without creator-token payments
//                              for now; call setLaunchpad(...) later once it exists)
async function main() {
  const platformWallet = process.env.PLATFORM_WALLET_ADDRESS;
  const feeBps = process.env.PLATFORM_FEE_BPS || '1000';
  const onlyAssToken = process.env.ONLYASS_TOKEN_ADDRESS;
  const launchpad = process.env.LAUNCHPAD_V4_ADDRESS || ethers.ZeroAddress;

  if (!platformWallet) throw new Error('Set PLATFORM_WALLET_ADDRESS in the environment before deploying.');
  if (!onlyAssToken) throw new Error('Set ONLYASS_TOKEN_ADDRESS in the environment before deploying.');

  const Payments = await ethers.getContractFactory('OnlyAssPayments');
  const payments = await Payments.deploy(platformWallet, feeBps, onlyAssToken, launchpad);
  await payments.waitForDeployment();

  const address = await payments.getAddress();
  console.log('OnlyAssPayments deployed to:', address);
  console.log('platformWallet:', platformWallet);
  console.log('platformFeeBps:', feeBps);
  console.log('onlyAssToken:', onlyAssToken);
  console.log('launchpad:', launchpad, launchpad === ethers.ZeroAddress ? '(not set -- payWithCreatorToken disabled until setLaunchpad is called)' : '');
  console.log('\nSet NEXT_PUBLIC_PAYMENTS_CONTRACT_ADDRESS to the address above in Vercel.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
