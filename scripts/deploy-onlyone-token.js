const { ethers } = require('hardhat');

// Deploys the real $ONLYONE token. Fixed supply, minted entirely to the
// deployer (your treasury key) in the constructor -- there is no mint
// function, so this is the one and only chance to set total supply.
//
// Reads everything from the environment so nothing is hardcoded:
//   ONLYONE_TOKEN_NAME     - defaults to "OnlyOne"
//   ONLYONE_TOKEN_SYMBOL   - defaults to "ONLYONE"
//   ONLYONE_TOTAL_SUPPLY   - required, in whole tokens (e.g. "1000000000" for 1B), 18 decimals
async function main() {
  const name = process.env.ONLYONE_TOKEN_NAME || 'OnlyOne';
  const symbol = process.env.ONLYONE_TOKEN_SYMBOL || 'ONLYONE';
  const totalSupplyHuman = process.env.ONLYONE_TOTAL_SUPPLY;
  if (!totalSupplyHuman) throw new Error('Set ONLYONE_TOTAL_SUPPLY (whole tokens, e.g. "1000000000") in the environment before deploying.');

  const [deployer] = await ethers.getSigners();
  const totalSupply = ethers.parseEther(totalSupplyHuman);

  const Token = await ethers.getContractFactory('OnlyOneToken');
  const token = await Token.deploy(name, symbol, totalSupply);
  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log('OnlyOneToken deployed to:', address);
  console.log('name/symbol:', name, '/', symbol);
  console.log('totalSupply:', totalSupplyHuman, symbol);
  console.log('entire supply minted to deployer:', deployer.address);
  console.log('\nThis is the one and only mint -- there is no mint function on the contract.');
  console.log('Next: set ONLYONE_TOKEN_ADDRESS to the address above everywhere it is read');
  console.log('(server/.env ONLYONE_TOKEN_ADDRESS, NEXT_PUBLIC_ONLYONE_TOKEN_ADDRESS in Vercel),');
  console.log('then run scripts/seed-onlyone-pool.js to give it an initial market before anyone can trade it.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
