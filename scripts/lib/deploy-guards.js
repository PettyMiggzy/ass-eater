// Guards shared by the deploy scripts. Each one exists because following a
// script literally would do real, irreversible damage on a live chain.

// The live $ONLYONE, deployed from the founder's own launchpad -- NOT from
// this repo (MEMORY.md). Chain 4663 is Robinhood Chain mainnet.
const LIVE_ONLYONE = '0x2c34ED86552076715272056D021cEab6080F1Ab5';
const PRODUCTION_CHAIN_IDS = new Set([4663n, 1n]);

async function chainId(ethers) {
  return (await ethers.provider.getNetwork()).chainId;
}

/** True on a mainnet this project could actually lose money on. */
async function isProductionChain(ethers) {
  return PRODUCTION_CHAIN_IDS.has(await chainId(ethers));
}

/**
 * The owner of a deployed contract must be an address the operator chose on
 * purpose, not whichever hot key happened to broadcast the deploy. The
 * constructors take an explicit owner precisely for this; passing
 * deployer.address threw that away.
 */
function requireOwnerAddress(ethers, deployerAddress) {
  const owner = process.env.OWNER_ADDRESS;
  if (!owner || !ethers.isAddress(owner)) {
    throw new Error('Set OWNER_ADDRESS to the (cold/multisig) address that should own this contract.');
  }
  if (owner.toLowerCase() === deployerAddress.toLowerCase()) {
    throw new Error('OWNER_ADDRESS must not be the deploying key: the deployer is a hot key that has just been used on a public network.');
  }
  return ethers.getAddress(owner);
}

/**
 * OnlyOnePayments and OnlyOneCreatorNFT take $ONLYONE as a payment method,
 * and have no path for the settlement stablecoin (USDG). The platform's
 * standing rule is that the token is NEVER a payment method; fans pay in
 * credits backed by USDG. So these must not reach a production chain as they
 * are. There is deliberately no override flag: making them deployable is a
 * contract change (rework to USDG, or archive them), which is an owner
 * decision, not an env var.
 */
async function refuseTokenPaymentContractOnProduction(ethers, name) {
  if (await isProductionChain(ethers)) {
    throw new Error(`${name} implements $ONLYONE as a payment method, which the platform's payment model forbids (credits settle in USDG). ` +
      'It must be reworked to settle in the allowlisted stablecoin, or archived, before any production deploy.');
  }
}

/**
 * The live token already exists. Deploying another "OnlyOne"/"ONLYONE", or
 * opening a "first" pool for one, on a production chain would create an
 * impostor or a second market at an operator-chosen price.
 */
async function refuseLiveTokenRelaunch(ethers, what) {
  if (!(await isProductionChain(ethers))) return;
  if (process.env.I_UNDERSTAND_ONLYONE_IS_ALREADY_LIVE !== LIVE_ONLYONE) {
    throw new Error(`Refusing to ${what} on a production chain: $ONLYONE is already live at ${LIVE_ONLYONE} ` +
      '(deployed from the founder\'s launchpad, not from this repo). If you really mean to, set ' +
      `I_UNDERSTAND_ONLYONE_IS_ALREADY_LIVE=${LIVE_ONLYONE}.`);
  }
}

module.exports = { LIVE_ONLYONE, isProductionChain, requireOwnerAddress, refuseTokenPaymentContractOnProduction, refuseLiveTokenRelaunch };
