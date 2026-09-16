const { ethers } = require('hardhat');
const { sqrtPriceX96FromPrice, sortTokens, fullRangeTicks, TICK_SPACING_BY_FEE } = require('./lib/v3-pool-math');

// Creates $ONLYASS's first Uniswap V3 market and seeds it with the initial
// liquidity you choose. This is the transaction that sets $ONLYASS's opening
// price -- there's no way to "fix a typo" after real trading starts, so every
// input below is required with no silent defaults, and the script sanity-checks
// your two liquidity amounts against your stated price before sending anything.
//
// IMPORTANT: UNISWAP_V3_POSITION_MANAGER_ADDRESS must be an address YOU
// personally verified (e.g. by reading it out of your own wallet's transaction
// preview when using the real app.uniswap.org on this chain), not copied from
// a doc page or a third-party "contract addresses" site. Web research for this
// project could not independently confirm Robinhood Chain's Uniswap contract
// addresses from more than one source -- see contracts/ONLYASS_LAUNCH.md.
//
// Required env vars:
//   ONLYASS_TOKEN_ADDRESS              - your deployed $ONLYASS contract (run deploy-onlyass-token.js first)
//   ONLYASS_POOL_QUOTE_ADDRESS         - the token to pair against (WETH or USDG address on the target chain)
//   UNISWAP_V3_POSITION_MANAGER_ADDRESS - NonfungiblePositionManager on the target chain (verify yourself, see above)
//   ONLYASS_INITIAL_PRICE              - quote-token amount per 1 $ONLYASS, e.g. "0.002"
//   ONLYASS_LIQUIDITY_AMOUNT           - $ONLYASS tokens to seed (whole units, e.g. "5000000")
//   ONLYASS_LIQUIDITY_QUOTE_AMOUNT     - quote tokens to seed (whole units) -- must match ONLYASS_INITIAL_PRICE within 1%
// Optional:
//   ONLYASS_POOL_FEE                   - V3 fee tier in hundredths of a bip, defaults to 3000 (0.3%), same var the
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
  const onlyAssAddress = requireEnv('ONLYASS_TOKEN_ADDRESS');
  const quoteAddress = requireEnv('ONLYASS_POOL_QUOTE_ADDRESS');
  const positionManagerAddress = requireEnv('UNISWAP_V3_POSITION_MANAGER_ADDRESS');
  const initialPrice = requireEnv('ONLYASS_INITIAL_PRICE'); // quote per 1 $ONLYASS
  const onlyAssAmountHuman = requireEnv('ONLYASS_LIQUIDITY_AMOUNT');
  const quoteAmountHuman = requireEnv('ONLYASS_LIQUIDITY_QUOTE_AMOUNT');
  const fee = Number(process.env.ONLYASS_POOL_FEE ?? 3000);
  const tickSpacing = TICK_SPACING_BY_FEE[fee];
  if (!tickSpacing) throw new Error(`Unsupported fee tier ${fee}. Use one of: ${Object.keys(TICK_SPACING_BY_FEE).join(', ')}`);

  // Sanity-check the two amounts against the stated price before sending anything --
  // this is the one place a typo turns into "the opening price is off by 100x forever".
  const impliedPrice = Number(quoteAmountHuman) / Number(onlyAssAmountHuman);
  const statedPrice = Number(initialPrice);
  const driftPct = Math.abs(impliedPrice - statedPrice) / statedPrice;
  if (driftPct > 0.01) {
    throw new Error(
      `ONLYASS_LIQUIDITY_QUOTE_AMOUNT / ONLYASS_LIQUIDITY_AMOUNT = ${impliedPrice} but ONLYASS_INITIAL_PRICE = ${statedPrice} ` +
      `(${(driftPct * 100).toFixed(2)}% apart, over the 1% tolerance). Fix one of the three before running this for real.`
    );
  }

  const [deployer] = await ethers.getSigners();
  const onlyAss = new ethers.Contract(onlyAssAddress, erc20Abi, deployer);
  const quote = new ethers.Contract(quoteAddress, erc20Abi, deployer);
  const positionManager = new ethers.Contract(positionManagerAddress, positionManagerAbi, deployer);

  const onlyAssDecimals = 18; // OnlyAssToken.sol is a plain OZ ERC20, always 18
  const quoteDecimals = await quote.decimals();

  const { token0, token1, swapped } = sortTokens(onlyAssAddress, quoteAddress);
  const decimals0 = swapped ? Number(quoteDecimals) : onlyAssDecimals;
  const decimals1 = swapped ? onlyAssDecimals : Number(quoteDecimals);
  // V3 price is always "token1 per token0". If ONLYASS ended up as token1, invert the human price we were given.
  const priceForV3 = swapped ? String(1 / statedPrice) : initialPrice;
  const sqrtPriceX96 = sqrtPriceX96FromPrice(priceForV3, decimals0, decimals1);

  const onlyAssAmount = ethers.parseEther(onlyAssAmountHuman);
  const quoteAmount = ethers.parseUnits(quoteAmountHuman, quoteDecimals);
  const amount0Desired = swapped ? quoteAmount : onlyAssAmount;
  const amount1Desired = swapped ? onlyAssAmount : quoteAmount;

  console.log('Pool:', token0, '/', token1, `(fee ${fee})`);
  console.log('sqrtPriceX96:', sqrtPriceX96.toString());

  console.log('Creating and initializing pool...');
  const poolAddress = await positionManager.createAndInitializePoolIfNecessary.staticCall(token0, token1, fee, sqrtPriceX96);
  let tx = await positionManager.createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96);
  await tx.wait();

  console.log('Approving position manager to pull liquidity...');
  tx = await onlyAss.approve(positionManagerAddress, onlyAssAmount);
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

  console.log('\n$ONLYASS pool is live.');
  console.log('tx:', receipt.hash);
  console.log('\nSet these in server/.env (they feed price.ts and the treasury-hedge worker):');
  console.log('  ONLYASS_POOL =', poolAddress);
  console.log('  ONLYASS_IS_TOKEN0 =', swapped ? 'false' : 'true');
  console.log('  ONLYASS_POOL_TOKEN0_DECIMALS =', decimals0);
  console.log('  ONLYASS_POOL_TOKEN1_DECIMALS =', decimals1);
  console.log('  ONLYASS_POOL_FEE =', fee);
  console.log('  ONLYASS_POOL_QUOTE = "WETH" if', quoteAddress, 'is WETH, otherwise "USDC" (price.ts only checks for the literal string "WETH")');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
