const { ethers } = require('hardhat');

// Deploys the real $ONLYASS token. Fixed supply, minted entirely to the
// deployer (your treasury key) in the constructor -- there is no mint
// function, so this is the one and only chance to set total supply.
//
// Reads everything from the environment so nothing is hardcoded:
//   ONLYASS_TOKEN_NAME     - defaults to "Only Ass"
//   ONLYASS_TOKEN_SYMBOL   - defaults to "ONLYASS"
//   ONLYASS_TOTAL_SUPPLY   - required, in whole tokens (e.g. "1000000000" for 1B), 18 decimals
async function main() {
  const name = process.env.ONLYASS_TOKEN_NAME || 'Only Ass';
  const symbol = process.env.ONLYASS_TOKEN_SYMBOL || 'ONLYASS';
  const totalSupplyHuman = process.env.ONLYASS_TOTAL_SUPPLY;
  if (!totalSupplyHuman) throw new Error('Set ONLYASS_TOTAL_SUPPLY (whole tokens, e.g. "1000000000") in the environment before deploying.');

  const [deployer] = await ethers.getSigners();
  const totalSupply = ethers.parseEther(totalSupplyHuman);

  const Token = await ethers.getContractFactory('OnlyAssToken');
  const token = await Token.deploy(name, symbol, totalSupply);
  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log('OnlyAssToken deployed to:', address);
  console.log('name/symbol:', name, '/', symbol);
  console.log('totalSupply:', totalSupplyHuman, symbol);
  console.log('entire supply minted to deployer:', deployer.address);
  console.log('\nThis is the one and only mint -- there is no mint function on the contract.');
  console.log('Next: set ONLYASS_TOKEN_ADDRESS to the address above everywhere it is read');
  console.log('(server/.env, contracts/.env for the launchpad deploy, NEXT_PUBLIC_CONTRACT_ADDRESS in Vercel),');
  console.log('then run scripts/seed-onlyass-pool.js to give it an initial market before anyone can trade it.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
