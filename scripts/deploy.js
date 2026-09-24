const { ethers } = require('hardhat');
const { requireOwnerAddress, refuseTokenPaymentContractOnProduction } = require('./lib/deploy-guards');

// Reads deployment inputs from the environment so nothing sensitive is
// hardcoded in the repo. Set these before running:
//   PLATFORM_WALLET_ADDRESS  - wallet that receives the platform's fee cut
//   PLATFORM_FEE_BPS         - fee in basis points, e.g. 1000 = 10% (defaults to 1000)
//   ONLYONE_TOKEN_ADDRESS    - deployed $ONLYONE ERC-20 contract address
//   OWNER_ADDRESS            - the (cold/multisig) owner; must NOT be the deploying key
//
// NOT DEPLOYABLE TO PRODUCTION AS IT STANDS: OnlyOnePayments pays creators in
// $ONLYONE (payWithOnlyOne) and has no USDG path, and the token is never a
// payment method on this platform. The guard below refuses production
// chains; testnets only, until the contract is reworked or archived.
//
// OnlyOnePayments takes its owner as the FIRST constructor argument, ahead of
// the platform wallet -- both are plain addresses, so swapping them compiles,
// deploys and reverts nothing; it just hands ownership to the fee wallet,
// unfixably, once it is live.
async function main() {
  const platformWallet = process.env.PLATFORM_WALLET_ADDRESS;
  const feeBps = process.env.PLATFORM_FEE_BPS || '1000';
  const onlyOneToken = process.env.ONLYONE_TOKEN_ADDRESS;

  if (!platformWallet) throw new Error('Set PLATFORM_WALLET_ADDRESS in the environment before deploying.');
  if (!onlyOneToken) throw new Error('Set ONLYONE_TOKEN_ADDRESS in the environment before deploying.');

  await refuseTokenPaymentContractOnProduction(ethers, 'OnlyOnePayments');
  const [deployer] = await ethers.getSigners();
  const owner = requireOwnerAddress(ethers, deployer.address);
  const Payments = await ethers.getContractFactory('OnlyOnePayments');
  // Owner FIRST -- see the note at the top of this file.
  const payments = await Payments.deploy(owner, platformWallet, feeBps, onlyOneToken);
  await payments.waitForDeployment();

  const address = await payments.getAddress();
  console.log('OnlyOnePayments deployed to:', address);
  console.log('platformWallet:', platformWallet);
  console.log('platformFeeBps:', feeBps);
  console.log('onlyOneToken:', onlyOneToken);
  console.log('owner:', owner);
  console.log('deployed by (holds no rights):', deployer.address);
  console.log('\nNothing in the site or server reads this contract\'s address yet.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
