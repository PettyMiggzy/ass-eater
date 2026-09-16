const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const WETHArtifact = require('@uniswap/v2-periphery/build/WETH9.json');
const { mineHookSalt } = require('../scripts/lib/hook-miner');
const { computePoolId } = require('../scripts/lib/v4-pool-math');

// Real Uniswap V4 core/periphery/permit2, compiled locally (not mocked) --
// see contracts/test/V4TestDeployment.sol + PermitTestDeployment.sol for why
// this is possible despite v4-core shipping Foundry-only build artifacts.
// This is the actual end-to-end path: deploy token -> init V4 pool -> seed
// full-range liquidity via PositionManager -> swap through the pool -> the
// hook takes its fee -- nothing here is a mock of V4 itself.

const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const PLATFORM_FEE_BPS = 100n; // must match OnlyAssLaunchpadHook.PLATFORM_FEE_BPS

const SUPPLY = ethers.parseEther('1000000');
const ONLYASS_LIQUIDITY = ethers.parseEther('5000');
const LAUNCH_FEE = ethers.parseEther('0.01');
const CREATOR_TAX_BPS = 300n; // 3% -- 3x the fixed 1% platform fee, for a clean ratio check

function launchParams(overrides = {}) {
  return {
    name: 'Creator Coin',
    symbol: 'CREATOR',
    totalSupply: SUPPLY,
    tokenLiquidityBps: 8_000,
    onlyAssForLiquidity: ONLYASS_LIQUIDITY,
    creatorTaxBps: CREATOR_TAX_BPS,
    ...overrides,
  };
}

describe('OnlyAssLaunchpadV4 (real V4 core/periphery, local deployment)', function () {
  this.timeout(120_000);

  let owner, platformWallet, creator, trader;
  let poolManager, positionManager, permit2, hookDeployer, poolSwapTest;
  let hook, launchpad, onlyAssToken;

  beforeEach(async () => {
    [owner, platformWallet, creator, trader] = await ethers.getSigners();

    const weth = await new ethers.ContractFactory(WETHArtifact.abi, WETHArtifact.bytecode, owner).deploy();
    await weth.waitForDeployment();

    poolManager = await (await ethers.getContractFactory('PoolManager')).deploy(owner.address);
    await poolManager.waitForDeployment();

    permit2 = await (await ethers.getContractFactory('Permit2')).deploy();
    await permit2.waitForDeployment();

    positionManager = await (await ethers.getContractFactory('PositionManager')).deploy(
      await poolManager.getAddress(),
      await permit2.getAddress(),
      300_000,
      ethers.ZeroAddress,
      await weth.getAddress(),
    );
    await positionManager.waitForDeployment();

    poolSwapTest = await (await ethers.getContractFactory('PoolSwapTest')).deploy(await poolManager.getAddress());
    await poolSwapTest.waitForDeployment();

    hookDeployer = await (await ethers.getContractFactory('HookDeployer')).deploy();
    await hookDeployer.waitForDeployment();

    onlyAssToken = await (
      await ethers.getContractFactory('MockOnlyAssToken')
    ).deploy('OnlyAss', 'ONLYASS', ethers.parseEther('10000000'));
    await onlyAssToken.waitForDeployment();

    // --- Mine + deploy the hook to an address whose low bits encode exactly
    // afterSwap + afterSwapReturnDelta ---
    const hookFactory = await ethers.getContractFactory('OnlyAssLaunchpadHook');
    const constructorArgs = [await poolManager.getAddress(), platformWallet.address, owner.address];
    const { salt, address: minedAddress, initCode } = mineHookSalt({
      deployerAddress: await hookDeployer.getAddress(),
      creationBytecode: hookFactory.bytecode,
      constructorArgTypes: ['address', 'address', 'address'],
      constructorArgValues: constructorArgs,
    });

    await (await hookDeployer.deploy(salt, initCode)).wait();
    expect(await ethers.provider.getCode(minedAddress)).to.not.equal('0x');
    hook = await ethers.getContractAt('OnlyAssLaunchpadHook', minedAddress);

    launchpad = await (
      await ethers.getContractFactory('OnlyAssLaunchpadV4')
    ).deploy(
      owner.address,
      platformWallet.address,
      await onlyAssToken.getAddress(),
      await poolManager.getAddress(),
      await positionManager.getAddress(),
      await permit2.getAddress(),
      minedAddress,
    );
    await launchpad.waitForDeployment();

    await hook.connect(owner).setLaunchpad(await launchpad.getAddress());

    await onlyAssToken.connect(owner).transfer(creator.address, ONLYASS_LIQUIDITY * 10n);
    await onlyAssToken.connect(creator).approve(await launchpad.getAddress(), ethers.MaxUint256);
  });

  async function launch(overrides = {}) {
    const tx = await launchpad.connect(creator).launchToken(launchParams(overrides), { value: LAUNCH_FEE });
    const receipt = await tx.wait();
    const event = receipt.logs.map((log) => {
      try {
        return launchpad.interface.parseLog(log);
      } catch {
        return null;
      }
    }).find((e) => e && e.name === 'TokenLaunched');
    return { receipt, event };
  }

  function sortedKey(tokenAddress, onlyAssAddress, hookAddress) {
    const [currency0, currency1] =
      tokenAddress.toLowerCase() < onlyAssAddress.toLowerCase() ? [tokenAddress, onlyAssAddress] : [onlyAssAddress, tokenAddress];
    return { currency0, currency1, fee: 0, tickSpacing: 60, hooks: hookAddress };
  }

  it('atomically deploys the token, initializes the V4 pool, and mints a full-range position held in escrow', async () => {
    const { event } = await launch();
    expect(event).to.exist;
    const { token: tokenAddress, positionTokenId, totalSupply, platformSupplyCut, tokensToLiquidity } = event.args;

    const token = await ethers.getContractAt('LaunchedToken', tokenAddress);
    expect(await token.balanceOf(platformWallet.address)).to.equal(platformSupplyCut);
    expect(await token.balanceOf(creator.address)).to.equal(totalSupply - platformSupplyCut - tokensToLiquidity);

    // The position NFT is escrowed by the launchpad, not the creator.
    expect(await positionManager.ownerOf(positionTokenId)).to.equal(await launchpad.getAddress());

    const key = sortedKey(tokenAddress, await onlyAssToken.getAddress(), await hook.getAddress());
    const poolId = computePoolId(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks);
    const cfg = await hook.poolConfig(poolId);
    expect(cfg.registered).to.equal(true);
    expect(cfg.creatorWallet).to.equal(creator.address);
    expect(cfg.creatorTaxBps).to.equal(CREATOR_TAX_BPS);
    expect(await hook.cumulativeOnlyAssVolume(poolId)).to.equal(0n);
  });

  it('rejects a creator tax above the hard cap', async () => {
    await expect(launch({ creatorTaxBps: 1_001 })).to.be.reverted;
  });

  it("takes the platform's fixed 1% + the creator's tax on a real swap, in the correct ratio, and counts volume", async () => {
    const { event } = await launch();
    const tokenAddress = event.args.token;
    const onlyAssAddress = await onlyAssToken.getAddress();
    const key = sortedKey(tokenAddress, onlyAssAddress, await hook.getAddress());
    const poolId = computePoolId(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks);

    const token = await ethers.getContractAt('LaunchedToken', tokenAddress);
    const traderInput = ethers.parseEther('1000');
    await token.connect(creator).transfer(trader.address, traderInput);
    await token.connect(trader).approve(await poolSwapTest.getAddress(), traderInput);

    const tokenIsCurrency0 = tokenAddress.toLowerCase() === key.currency0.toLowerCase();
    const zeroForOne = tokenIsCurrency0; // trader sells the launched token for $ONLYASS either way

    const platformWalletOnlyAssBefore = await onlyAssToken.balanceOf(platformWallet.address);
    const creatorOnlyAssBefore = await onlyAssToken.balanceOf(creator.address);

    const tx = await poolSwapTest.connect(trader).swap(
      key,
      {
        zeroForOne,
        amountSpecified: -traderInput, // exact input
        sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
      },
      { takeClaims: false, settleUsingBurn: false },
      '0x',
    );
    const receipt = await tx.wait();

    const feeEvent = receipt.logs
      .map((log) => {
        try {
          return hook.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === 'FeeTaken');
    expect(feeEvent).to.exist;
    const { platformFee, creatorFee } = feeEvent.args;
    expect(platformFee).to.be.gt(0n);
    expect(creatorFee).to.be.gt(0n);
    // Both fees are independent floor(outputAmount * bps / 10000)
    // computations off the same outputAmount, so their ratio matches the bps
    // ratio only up to each side's own rounding -- not to the exact wei, but
    // the two independent roundings can never diverge by more than a few bps
    // worth of dust either way.
    const diff = creatorFee * PLATFORM_FEE_BPS > platformFee * CREATOR_TAX_BPS
      ? creatorFee * PLATFORM_FEE_BPS - platformFee * CREATOR_TAX_BPS
      : platformFee * CREATOR_TAX_BPS - creatorFee * PLATFORM_FEE_BPS;
    expect(diff).to.be.lte(CREATOR_TAX_BPS + PLATFORM_FEE_BPS);

    // The output currency here is $ONLYASS (currency1 if the token is
    // currency0, since the trader is selling the token) -- confirm the fee
    // actually landed in both wallets' real balances, not just the event.
    expect(await onlyAssToken.balanceOf(platformWallet.address)).to.equal(platformWalletOnlyAssBefore + platformFee);
    expect(await onlyAssToken.balanceOf(creator.address)).to.equal(creatorOnlyAssBefore + creatorFee);

    expect(await hook.cumulativeOnlyAssVolume(poolId)).to.be.gt(0n);
  });

  it('locks the LP position for LOCK_DURATION and only releases it to the creator', async () => {
    const { event } = await launch();
    const { positionTokenId } = event.args;
    const launchId = 0n;

    await expect(launchpad.connect(creator).withdrawLiquidity(launchId)).to.be.revertedWithCustomError(launchpad, 'StillLocked');
    await expect(launchpad.connect(trader).withdrawLiquidity(launchId)).to.be.reverted; // not the creator, still locked either way

    await time.increase(180 * 24 * 60 * 60 + 1);

    await expect(launchpad.connect(trader).withdrawLiquidity(launchId)).to.be.revertedWithCustomError(launchpad, 'NotLaunchCreator');

    await launchpad.connect(creator).withdrawLiquidity(launchId);
    expect(await positionManager.ownerOf(positionTokenId)).to.equal(creator.address);

    await expect(launchpad.connect(creator).withdrawLiquidity(launchId)).to.be.revertedWithCustomError(launchpad, 'AlreadyWithdrawn');
  });

  it('pays the graduation bonus once the $ONLYASS volume threshold is met and funds are available', async () => {
    await launchpad.connect(owner).setGraduationParams(ethers.parseEther('1'), ethers.parseEther('0.5'), ethers.parseEther('0.5'));
    await launchpad.fundGraduationPool({ value: ethers.parseEther('1') });

    const { event } = await launch();
    const tokenAddress = event.args.token;
    const launchId = 0n;

    await expect(launchpad.triggerGraduationBonus(launchId)).to.be.revertedWithCustomError(launchpad, 'GraduationThresholdNotMet');

    const token = await ethers.getContractAt('LaunchedToken', tokenAddress);
    const key = sortedKey(tokenAddress, await onlyAssToken.getAddress(), await hook.getAddress());
    const traderInput = ethers.parseEther('50000'); // large enough to push cumulative $ONLYASS volume past 1 ether
    await token.connect(creator).transfer(trader.address, traderInput);
    await token.connect(trader).approve(await poolSwapTest.getAddress(), traderInput);
    const zeroForOne = tokenAddress.toLowerCase() === key.currency0.toLowerCase();
    await poolSwapTest.connect(trader).swap(
      key,
      { zeroForOne, amountSpecified: -traderInput, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n },
      { takeClaims: false, settleUsingBurn: false },
      '0x',
    );

    const creatorEthBefore = await ethers.provider.getBalance(creator.address);
    const platformEthBefore = await ethers.provider.getBalance(platformWallet.address);

    await launchpad.triggerGraduationBonus(launchId);

    expect(await ethers.provider.getBalance(creator.address)).to.equal(creatorEthBefore + ethers.parseEther('0.5'));
    expect(await ethers.provider.getBalance(platformWallet.address)).to.equal(platformEthBefore + ethers.parseEther('0.5'));

    await expect(launchpad.triggerGraduationBonus(launchId)).to.be.revertedWithCustomError(launchpad, 'GraduationAlreadyPaid');
  });
});
