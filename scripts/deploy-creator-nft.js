const { ethers } = require('hardhat');

// Reads deployment inputs from the environment so nothing sensitive is
// hardcoded in the repo. Set these before running:
//   PLATFORM_WALLET_ADDRESS   - wallet that receives the platform's 10% cut of every mint
//   ONLYASS_TOKEN_ADDRESS     - deployed $ONLYASS ERC-20 contract address
//   PLATFORM_FEE_BPS          - optional, defaults to 1000 (10%)
//   NFT_CONTRACT_METADATA_URI - optional, a contract-level metadata URL (OpenSea "collection"
//                               info etc.) -- defaults to a placeholder on the main site
async function main() {
  const platformWallet = process.env.PLATFORM_WALLET_ADDRESS;
  const onlyAssToken = process.env.ONLYASS_TOKEN_ADDRESS;
  const feeBps = process.env.PLATFORM_FEE_BPS || '1000';
  const contractMetadataURI = process.env.NFT_CONTRACT_METADATA_URI || 'https://onlyass.fun/api/nft-contract-metadata';

  if (!platformWallet) throw new Error('Set PLATFORM_WALLET_ADDRESS in the environment before deploying.');
  if (!onlyAssToken) throw new Error('Set ONLYASS_TOKEN_ADDRESS in the environment before deploying.');

  const [deployer] = await ethers.getSigners();
  const NFT = await ethers.getContractFactory('OnlyAssCreatorNFT');
  const nft = await NFT.deploy(deployer.address, platformWallet, feeBps, onlyAssToken, contractMetadataURI);
  await nft.waitForDeployment();

  const address = await nft.getAddress();
  console.log('OnlyAssCreatorNFT deployed to:', address);
  console.log('owner (can pause / adjust fee within the hard cap):', deployer.address);
  console.log('platformWallet:', platformWallet);
  console.log('onlyAssToken:', onlyAssToken);
  console.log('platformFeeBps:', feeBps);
  console.log('\nRead contracts/NFT.md before wiring up a creator-facing minting UI -- in particular,');
  console.log('every drop\'s metadataURI MUST point at a platform-controlled URL (this repo\'s own API),');
  console.log('never raw IPFS/Arweave -- that is what makes the blur-until-purchased gating and any');
  console.log('future content takedown possible at all.');
  console.log('\nSet NEXT_PUBLIC_CREATOR_NFT_CONTRACT_ADDRESS to the address above in Vercel.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
