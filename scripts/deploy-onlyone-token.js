const { ethers } = require('hardhat');
const { LIVE_ONLYONE, refuseLiveTokenRelaunch } = require('./lib/deploy-guards');

// NOT the live token. $ONLYONE is already live on Robinhood Chain at
// 0x2c34ED86552076715272056D021cEab6080F1Ab5, deployed from the founder's own
// launchpad -- not from this repo. This script deploys a SEPARATE fixed-supply
// ERC-20 (OnlyOneToken.sol) and is only for testnets / local experiments. On
// a production chain it refuses unless I_UNDERSTAND_ONLYONE_IS_ALREADY_LIVE
// is set to the live address, because a second "OnlyOne"/"ONLYONE" is an
// impostor that the deployer holds 100% of.
//
// Fixed supply, minted entirely to the deployer in the constructor -- there
// is no mint function.
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

  await refuseLiveTokenRelaunch(ethers, 'deploy another $ONLYONE token');
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
  console.log(`This is NOT the platform token. Do not point ONLYONE_TOKEN_ADDRESS or`);
  console.log(`NEXT_PUBLIC_ONLYONE_TOKEN_ADDRESS at it -- the live $ONLYONE is ${LIVE_ONLYONE}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
