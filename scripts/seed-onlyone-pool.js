const { ethers } = require('hardhat');
const { sqrtPriceX96FromPrice, sortTokens, fullRangeTicks, TICK_SPACING_BY_FEE } = require('./lib/v3-pool-math');
const { refuseLiveTokenRelaunch } = require('./lib/deploy-guards');

// Creates a Uniswap V3 pool for a token and seeds it with liquidity you
// choose. The live $ONLYONE (0x2c34ED86552076715272056D021cEab6080F1Ab5) was
// launched from the founder's own launchpad and already has its market (a V4
// pool); this script does NOT create "the" $ONLYONE market. Run against the
// live token it would open a SECOND pool at a price you type in, from your
// own wallet, which arbitrage bots drain if that price is off. On a
// production chain it refuses unless I_UNDERSTAND_ONLYONE_IS_ALREADY_LIVE is
// set to the live address. The initial price is final -- there's no way to "fix a typo" after real trading starts, so every
// input below is required with no silent defaults, and the script sanity-checks
// your two liquidity amounts against your stated price before sending anything.
//
// IMPORTANT: UNISWAP_V3_POSITION_MANAGER_ADDRESS must be an address YOU
// personally verified (e.g. by reading it out of your own wallet's transaction
// preview when using the real app.uniswap.org on this chain), not copied from
// a doc page or a third-party "contract addresses" site. Web research for this
// project could not independently confirm Robinhood Chain's Uniswap contract
// addresses from more than one source.
//
// Required env vars:
//   ONLYONE_TOKEN_ADDRESS              - the token to pool (a testnet deployment from deploy-onlyone-token.js)
//   ONLYONE_POOL_QUOTE_ADDRESS         - the token to pair against (WETH or USDG address on the target chain)
//   UNISWAP_V3_POSITION_MANAGER_ADDRESS - NonfungiblePositionManager on the target chain (verify yourself, see above)
//   ONLYONE_INITIAL_PRICE              - quote-token amount per 1 $ONLYONE, e.g. "0.002"
//   ONLYONE_LIQUIDITY_AMOUNT           - $ONLYONE tokens to seed (whole units, e.g. "5000000")
//   ONLYONE_LIQUIDITY_QUOTE_AMOUNT     - quote tokens to seed (whole units) -- must match ONLYONE_INITIAL_PRICE within 1%
// Optional:
//   ONLYONE_POOL_FEE                   - V3 fee tier in hundredths of a bip, defaults to 3000 (0.3%), same var the
//                                         price oracle (server/src/lib/price.ts) and treasury-hedge worker read

const erc20Abi = [
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
const positionManagerAbi = [
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} in the environment before running this script.`);
  return v;
}

async function main() {
  const onlyOneAddress = requireEnv('ONLYONE_TOKEN_ADDRESS');
  const quoteAddress = requireEnv('ONLYONE_POOL_QUOTE_ADDRESS');
  const positionManagerAddress = requireEnv('UNISWAP_V3_POSITION_MANAGER_ADDRESS');
  const initialPrice = requireEnv('ONLYONE_INITIAL_PRICE'); // quote per 1 $ONLYONE
  const onlyOneAmountHuman = requireEnv('ONLYONE_LIQUIDITY_AMOUNT');
  const quoteAmountHuman = requireEnv('ONLYONE_LIQUIDITY_QUOTE_AMOUNT');
  const fee = Number(process.env.ONLYONE_POOL_FEE ?? 3000);
  const tickSpacing = TICK_SPACING_BY_FEE[fee];
  if (!tickSpacing) throw new Error(`Unsupported fee tier ${fee}. Use one of: ${Object.keys(TICK_SPACING_BY_FEE).join(', ')}`);

  // Sanity-check the two amounts against the stated price before sending anything --
  // this is the one place a typo turns into "the opening price is off by 100x forever".
  const impliedPrice = Number(quoteAmountHuman) / Number(onlyOneAmountHuman);
  const statedPrice = Number(initialPrice);
  const driftPct = Math.abs(impliedPrice - statedPrice) / statedPrice;
  if (driftPct > 0.01) {
    throw new Error(
      `ONLYONE_LIQUIDITY_QUOTE_AMOUNT / ONLYONE_LIQUIDITY_AMOUNT = ${impliedPrice} but ONLYONE_INITIAL_PRICE = ${statedPrice} ` +
      `(${(driftPct * 100).toFixed(2)}% apart, over the 1% tolerance). Fix one of the three before running this for real.`
    );
  }

  await refuseLiveTokenRelaunch(ethers, 'seed a new $ONLYONE pool');
  const [deployer] = await ethers.getSigners();
  const onlyOne = new ethers.Contract(onlyOneAddress, erc20Abi, deployer);
  const quote = new ethers.Contract(quoteAddress, erc20Abi, deployer);
  const positionManager = new ethers.Contract(positionManagerAddress, positionManagerAbi, deployer);

  const onlyOneDecimals = 18; // OnlyOneToken.sol is a plain OZ ERC20, always 18
  const quoteDecimals = await quote.decimals();

  const { token0, token1, swapped } = sortTokens(onlyOneAddress, quoteAddress);
  const decimals0 = swapped ? Number(quoteDecimals) : onlyOneDecimals;
  const decimals1 = swapped ? onlyOneDecimals : Number(quoteDecimals);
  // V3 price is always "token1 per token0". If ONLYONE ended up as token1, invert the human price we were given.
  const priceForV3 = swapped ? String(1 / statedPrice) : initialPrice;
  const sqrtPriceX96 = sqrtPriceX96FromPrice(priceForV3, decimals0, decimals1);

  const onlyOneAmount = ethers.parseEther(onlyOneAmountHuman);
  const quoteAmount = ethers.parseUnits(quoteAmountHuman, quoteDecimals);
  const amount0Desired = swapped ? quoteAmount : onlyOneAmount;
  const amount1Desired = swapped ? onlyOneAmount : quoteAmount;

  console.log('Pool:', token0, '/', token1, `(fee ${fee})`);
  console.log('sqrtPriceX96:', sqrtPriceX96.toString());

  console.log('Creating and initializing pool...');
  const poolAddress = await positionManager.createAndInitializePoolIfNecessary.staticCall(token0, token1, fee, sqrtPriceX96);
  let tx = await positionManager.createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96);
  await tx.wait();

  console.log('Approving position manager to pull liquidity...');
  tx = await onlyOne.approve(positionManagerAddress, onlyOneAmount);
  await tx.wait();
  tx = await quote.approve(positionManagerAddress, quoteAmount);
  await tx.wait();

  const { tickLower, tickUpper } = fullRangeTicks(tickSpacing);
  const deadline = Math.floor(Date.now() / 1000) + 1800; // 30 minutes

  console.log('Minting the initial full-range liquidity position...');
  tx = await positionManager.mint({
    token0, token1, fee, tickLower, tickUpper,
    amount0Desired, amount1Desired,
    amount0Min: (amount0Desired * 99n) / 100n,
    amount1Min: (amount1Desired * 99n) / 100n,
    recipient: deployer.address,
    deadline,
  });
  const receipt = await tx.wait();

  console.log('\nPool is live.');
  console.log('tx:', receipt.hash);
  console.log('\nSet these in server/.env (they feed price.ts and the treasury-hedge worker):');
  console.log('  ONLYONE_POOL =', poolAddress);
  console.log('  ONLYONE_IS_TOKEN0 =', swapped ? 'false' : 'true');
  console.log('  ONLYONE_POOL_TOKEN0_DECIMALS =', decimals0);
  console.log('  ONLYONE_POOL_TOKEN1_DECIMALS =', decimals1);
  console.log('  ONLYONE_POOL_FEE =', fee);
  console.log('  ONLYONE_POOL_QUOTE = "WETH" if', quoteAddress, 'is WETH, otherwise "USDG" (price.ts only checks for the literal string "WETH")');
  console.log('  ONLYONE_POOL_VERSION = v3');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
