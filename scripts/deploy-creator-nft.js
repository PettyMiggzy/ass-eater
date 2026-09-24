const { ethers } = require('hardhat');
const { requireOwnerAddress, refuseTokenPaymentContractOnProduction } = require('./lib/deploy-guards');

// Reads deployment inputs from the environment so nothing sensitive is
// hardcoded in the repo. Set these before running:
//   PLATFORM_WALLET_ADDRESS   - wallet that receives the platform's 10% cut of every mint
//   ONLYONE_TOKEN_ADDRESS     - deployed $ONLYONE ERC-20 contract address
//   PLATFORM_FEE_BPS          - optional, defaults to 1000 (10%)
//   OWNER_ADDRESS             - the (cold/multisig) owner; must NOT be the deploying key
//   NFT_CONTRACT_METADATA_URI - required: a contract-level metadata URL (OpenSea "collection"
//                               info). No route serves one yet, so there is no default.
//
// NOT DEPLOYABLE TO PRODUCTION AS IT STANDS: drops can be priced in $ONLYONE
// and there is no USDG path, and the token is never a payment method on this
// platform. The guard below refuses production chains; testnets only, until
// the contract is reworked or archived.
async function main() {
  const platformWallet = process.env.PLATFORM_WALLET_ADDRESS;
  const onlyOneToken = process.env.ONLYONE_TOKEN_ADDRESS;
  const feeBps = process.env.PLATFORM_FEE_BPS || '1000';
  const contractMetadataURI = process.env.NFT_CONTRACT_METADATA_URI;

  if (!platformWallet) throw new Error('Set PLATFORM_WALLET_ADDRESS in the environment before deploying.');
  if (!onlyOneToken) throw new Error('Set ONLYONE_TOKEN_ADDRESS in the environment before deploying.');
  if (!contractMetadataURI) throw new Error('Set NFT_CONTRACT_METADATA_URI (a URL that actually serves contract metadata) before deploying.');

  await refuseTokenPaymentContractOnProduction(ethers, 'OnlyOneCreatorNFT');
  const [deployer] = await ethers.getSigners();
  const owner = requireOwnerAddress(ethers, deployer.address);
  const NFT = await ethers.getContractFactory('OnlyOneCreatorNFT');
  const nft = await NFT.deploy(owner, platformWallet, feeBps, onlyOneToken, contractMetadataURI);
  await nft.waitForDeployment();

  const address = await nft.getAddress();
  console.log('OnlyOneCreatorNFT deployed to:', address);
  console.log('owner (can pause / adjust fee within the hard cap):', owner);
  console.log('deployed by (holds no rights):', deployer.address);
  console.log('platformWallet:', platformWallet);
  console.log('onlyOneToken:', onlyOneToken);
  console.log('platformFeeBps:', feeBps);
  console.log('\nRead contracts/NFT.md before wiring up a creator-facing minting UI -- in particular,');
  console.log('every drop\'s metadataURI MUST point at a platform-controlled URL (this repo\'s own API),');
  console.log('never raw IPFS/Arweave -- that is what makes the blur-until-purchased gating and any');
  console.log('future content takedown possible at all.');
  console.log('\nNothing in the site or server reads this contract\'s address yet.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
