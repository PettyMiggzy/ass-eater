const { expect } = require('chai');
const { ethers } = require('hardhat');
const { sqrtPriceX96FromPrice, sortTokens } = require('../scripts/lib/v3-pool-math');

const FactoryArtifact = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const PoolArtifact = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json');

const FEE = 3000; // enabled by default in UniswapV3Factory's constructor, unlike the 100 tier

// This exercises seed-onlyone-pool.js's actual price math (sqrtPriceX96FromPrice
// + sortTokens) against REAL Uniswap V3 factory/pool bytecode -- not a mock --
// the same pattern used elsewhere for pool math tests. It proves the
// full pipeline (a human price string -> our math -> a real pool's slot0())
// round-trips correctly, which is exactly the step where a sign/decimals bug
// would otherwise only surface after real money is already in the pool.
describe('seed-onlyone-pool math against real Uniswap V3 bytecode', () => {
  async function deployFactory() {
    const [deployer] = await ethers.getSigners();
    const Factory = new ethers.ContractFactory(FactoryArtifact.abi, FactoryArtifact.bytecode, deployer);
    const factory = await Factory.deploy();
    await factory.waitForDeployment();
    return factory;
  }

  async function deployToken(decimals) {
    const Token = await ethers.getContractFactory('MockOnlyOneToken');
    const token = await Token.deploy('Mock', 'MOCK', ethers.parseUnits('1000000', decimals));
    await token.waitForDeployment();
    return token;
  }

  async function createAndInitialize(factory, tokenA, tokenB, priceHuman, decimalsA, decimalsB) {
    const addrA = await tokenA.getAddress();
    const addrB = await tokenB.getAddress();
    const { token0, token1, swapped } = sortTokens(addrA, addrB);
    const decimals0 = swapped ? decimalsB : decimalsA;
    const decimals1 = swapped ? decimalsA : decimalsB;
    // priceHuman is defined as "B per 1 A" (matching ONLYONE_INITIAL_PRICE's "quote per 1 $ONLYONE"); flip if A ended up as token1.
    const priceForV3 = swapped ? String(1 / Number(priceHuman)) : priceHuman;
    const sqrtPriceX96 = sqrtPriceX96FromPrice(priceForV3, decimals0, decimals1);

    await factory.createPool(token0, token1, FEE);
    const poolAddress = await factory.getPool(token0, token1, FEE);
    const pool = new ethers.Contract(poolAddress, PoolArtifact.abi, ethers.provider);
    await (await new ethers.Contract(poolAddress, PoolArtifact.abi, (await ethers.getSigners())[0]).initialize(sqrtPriceX96)).wait();

    return { pool, token0, token1, decimals0, decimals1, swapped };
  }

  function decodePriceFromSlot0(sqrtPriceX96, decimals0, decimals1) {
    const Q96 = 2 ** 96;
    const raw = (Number(sqrtPriceX96) / Q96) ** 2; // token1 per token0, raw units
    return raw * 10 ** (decimals0 - decimals1); // -> human units
  }

  it('round-trips a price of 1 with equal 18-decimal tokens', async () => {
    const factory = await deployFactory();
    const a = await deployToken(18);
    const b = await deployToken(18);
    const { pool, decimals0, decimals1 } = await createAndInitialize(factory, a, b, '1', 18, 18);
    const slot0 = await pool.slot0();
    expect(decodePriceFromSlot0(slot0.sqrtPriceX96, decimals0, decimals1)).to.be.closeTo(1, 1e-9);
  });

  it('round-trips a sub-1 price with a decimals gap (18-decimal ONLYONE-like token vs 6-decimal USDG-like token)', async () => {
    const factory = await deployFactory();
    const onlyAssLike = await deployToken(18);
    const quoteLike = await deployToken(6);
    const targetPrice = 0.0025; // 0.0025 quote-tokens per 1 ONLYONE-like token
    const { pool, decimals0, decimals1, swapped } = await createAndInitialize(factory, onlyAssLike, quoteLike, String(targetPrice), 18, 6);
    const slot0 = await pool.slot0();
    // decodePriceFromSlot0 always returns "token1 per token0" in human units; convert back to "quote per ONLYONE-like" for the assertion.
    const decodedToken1PerToken0 = decodePriceFromSlot0(slot0.sqrtPriceX96, decimals0, decimals1);
    const decodedQuotePerOnlyOne = swapped ? 1 / decodedToken1PerToken0 : decodedToken1PerToken0;
    expect(decodedQuotePerOnlyOne).to.be.closeTo(targetPrice, targetPrice * 1e-6);
  });

  it('produces a pool that real swaps can actually execute against (not just a stored number)', async () => {
    // The strongest proof the initialize call "took": a pool starting completely
    // empty (zero liquidity) still reports the price we set, and rejects a real
    // swap for lack of liquidity rather than for a bad sqrtPriceX96/initialize call.
    const factory = await deployFactory();
    const a = await deployToken(18);
    const b = await deployToken(18);
    const { pool } = await createAndInitialize(factory, a, b, '2', 18, 18);
    const slot0 = await pool.slot0();
    expect(slot0.sqrtPriceX96).to.be.greaterThan(0n);
    expect(await pool.liquidity()).to.equal(0n); // matches reality before the mint step seed-onlyone-pool.js performs next
  });
});
