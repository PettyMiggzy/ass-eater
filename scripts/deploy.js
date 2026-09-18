const { ethers } = require('hardhat');

// Reads deployment inputs from the environment so nothing sensitive is
// hardcoded in the repo. Set these before running:
//   PLATFORM_WALLET_ADDRESS  - wallet that receives the platform's fee cut
//   PLATFORM_FEE_BPS         - fee in basis points, e.g. 1000 = 10% (defaults to 1000)
//   ONLYASS_TOKEN_ADDRESS    - deployed $ONLYASS ERC-20 contract address
//
// The contract is owned by whichever key runs this script. OnlyAssPayments
// takes its owner as the FIRST constructor argument, ahead of the platform
// wallet -- both are plain addresses, so swapping them compiles, deploys and
// reverts nothing; it just hands ownership to the fee wallet, unfixably,
// once it is live.
async function main() {
  const platformWallet = process.env.PLATFORM_WALLET_ADDRESS;
  const feeBps = process.env.PLATFORM_FEE_BPS || '1000';
  const onlyAssToken = process.env.ONLYASS_TOKEN_ADDRESS;

  if (!platformWallet) throw new Error('Set PLATFORM_WALLET_ADDRESS in the environment before deploying.');
  if (!onlyAssToken) throw new Error('Set ONLYASS_TOKEN_ADDRESS in the environment before deploying.');

  const [deployer] = await ethers.getSigners();
  const Payments = await ethers.getContractFactory('OnlyAssPayments');
  // Owner FIRST -- see the note at the top of this file.
  const payments = await Payments.deploy(deployer.address, platformWallet, feeBps, onlyAssToken);
  await payments.waitForDeployment();

  const address = await payments.getAddress();
  console.log('OnlyAssPayments deployed to:', address);
  console.log('platformWallet:', platformWallet);
  console.log('platformFeeBps:', feeBps);
  console.log('onlyAssToken:', onlyAssToken);
  console.log('owner:', deployer.address);
  console.log('\nSet NEXT_PUBLIC_PAYMENTS_CONTRACT_ADDRESS to the address above in Vercel.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
