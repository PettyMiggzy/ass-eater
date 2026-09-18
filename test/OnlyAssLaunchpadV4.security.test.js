const { expect } = require('chai');
const { ethers, network } = require('hardhat');

const WETHArtifact = require('@uniswap/v2-periphery/build/WETH9.json');
const { mineHookSalt } = require('../scripts/lib/hook-miner');
const { computePoolId, poolStateSlot, decodeSlot0 } = require('../scripts/lib/v4-pool-math');

// Regression suite for the audit findings fixed in OnlyAssLaunchpadV4 /
// OnlyAssLaunchpadHook: token-address squatting (a permanent, one-cheap-
// transaction DoS), PositionManager.initializePool's swallowed failure, the
// graduation milestone being gameable with a huge token supply, and
// rescueERC20 not actually enforcing the guarantee its own comment makes.
//
// Same real (not mocked) V4 deployment as
// test/OnlyAssLaunchpadV4.integration.test.js -- see that file's header for
// why compiling v4-core/v4-periphery/Permit2 locally is possible at all.

const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const Q96 = 2n ** 96n;

const SUPPLY = ethers.parseEther('1000000');
const ONLYASS_LIQUIDITY = ethers.parseEther('5000');
const LAUNCH_FEE = ethers.parseEther('0.01');
const CREATOR_TAX_BPS = 300n;

// Independent JS re-implementation of OnlyAssSqrtPriceMath.toSqrtPriceX96,
// same style as test/onlyass-sqrt-price-math.test.js -- so the "seeded at the
// validated price" assertion isn't just the contract agreeing with itself.
function isqrt(n) {
  if (n < 2n) return n;
  let x0 = n;
  let x1 = (n >> 1n) + 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) >> 1n;
  }
  return x0;
}

function expectedSqrtPriceX96(amount0, amount1) {
  return isqrt((amount1 * (Q96 * Q96)) / amount0);
}

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

describe('OnlyAssLaunchpadV4 (security regressions)', function () {
  this.timeout(120_000);

  let owner, platformWallet, creator, trader, other;
  let poolManager, positionManager, permit2, hookDeployer, poolSwapTest;
  let hook, launchpad, onlyAssToken;

  beforeEach(async () => {
    [owner, platformWallet, creator, trader, other] = await ethers.getSigners();

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

    const hookFactory = await ethers.getContractFactory('OnlyAssLaunchpadHook');
    const { salt, address: minedAddress, initCode } = mineHookSalt({
      deployerAddress: await hookDeployer.getAddress(),
      creationBytecode: hookFactory.bytecode,
      constructorArgTypes: ['address', 'address', 'address'],
      constructorArgValues: [await poolManager.getAddress(), platformWallet.address, owner.address],
    });
    await (await hookDeployer.deploy(salt, initCode)).wait();
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
    const event = receipt.logs
      .map((log) => {
        try {
          return launchpad.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === 'TokenLaunched');
    return { receipt, event };
  }

  function sortedKey(tokenAddress, onlyAssAddress, hookAddress) {
    const [currency0, currency1] =
      tokenAddress.toLowerCase() < onlyAssAddress.toLowerCase()
        ? [tokenAddress, onlyAssAddress]
        : [onlyAssAddress, tokenAddress];
    return { currency0, currency1, fee: 0, tickSpacing: 60, hooks: hookAddress };
  }

  async function readSlot0(poolId) {
    // extsload is overloaded on PoolManager, so ethers needs the exact signature.
    return decodeSlot0(await poolManager['extsload(bytes32)'](poolStateSlot(poolId)));
  }

  describe('token-address squatting (permanent-DoS finding)', function () {
    it('still launches when the plain-CREATE address\'s pool was pre-initialized by an attacker', async () => {
      // The attack this defends against: with a plain `new LaunchedToken(...)`
      // the next launch's token address is just keccak(rlp(launchpad, nonce)),
      // which anyone can compute. A V4 pool's identity is only its PoolKey and
      // PoolManager.initialize is permissionless, so an attacker initializes
      // that pool first, at a price of their choosing. The launch then either
      // seeds all its liquidity at the attacker's price (initializePool
      // swallows the "already initialized" error) or reverts -- and a reverted
      // launch never advances the launchpad's nonce, so every future launch
      // deploys to that same squatted address. One cheap transaction, bricked
      // forever.
      const launchpadAddress = await launchpad.getAddress();
      const onlyAssAddress = await onlyAssToken.getAddress();
      // A contract account's nonce starts at 1, and this launchpad has not
      // deployed anything yet, so this is exactly where a plain CREATE would
      // have put the first launched token.
      const squatted = ethers.getCreateAddress({ from: launchpadAddress, nonce: 1 });
      const squattedKey = sortedKey(squatted, onlyAssAddress, await hook.getAddress());
      const squattedPoolId = computePoolId(
        squattedKey.currency0,
        squattedKey.currency1,
        squattedKey.fee,
        squattedKey.tickSpacing,
        squattedKey.hooks,
      );

      // Attacker initializes the pool at a 1:1 price, nothing like the price
      // this launch's own token/$ONLYASS ratio implies.
      await poolManager.connect(other).initialize(squattedKey, Q96);
      expect((await readSlot0(squattedPoolId)).sqrtPriceX96).to.equal(Q96);

      const { event } = await launch();
      expect(event).to.exist;
      expect(event.args.token.toLowerCase()).to.not.equal(squatted.toLowerCase());
      expect(await launchpad.launchCount()).to.equal(1n);

      // And the launch's own pool is a different one, at its own real price.
      const key = sortedKey(event.args.token, onlyAssAddress, await hook.getAddress());
      const poolId = computePoolId(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks);
      expect(poolId).to.not.equal(squattedPoolId);
      expect((await readSlot0(poolId)).sqrtPriceX96).to.not.equal(Q96);
    });

    it('derives a different token address for every launch, even with identical params', async () => {
      const first = await launch();
      const second = await launch();
      expect(first.event.args.token.toLowerCase()).to.not.equal(second.event.args.token.toLowerCase());
    });
  });

  describe('pool initialization must fail loudly, never silently', function () {
    it('seeds liquidity at exactly the starting price it validated', async () => {
      const { event } = await launch();
      const onlyAssAddress = await onlyAssToken.getAddress();
      const key = sortedKey(event.args.token, onlyAssAddress, await hook.getAddress());
      const poolId = computePoolId(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks);

      const tokenIsCurrency0 = event.args.token.toLowerCase() === key.currency0.toLowerCase();
      const [amount0, amount1] = tokenIsCurrency0
        ? [event.args.tokensToLiquidity, event.args.onlyAssToLiquidity]
        : [event.args.onlyAssToLiquidity, event.args.tokensToLiquidity];

      expect((await readSlot0(poolId)).sqrtPriceX96).to.equal(expectedSqrtPriceX96(amount0, amount1));
    });

    it('reverts instead of seeding against a price PoolManager never accepted', async () => {
      // A token supply this large against 1 wei of $ONLYASS implies a starting
      // price below V4's own MIN_SQRT_PRICE, so PoolManager.initialize
      // rejects it -- and PositionManager.initializePool swallows that
      // rejection and returns type(int24).max instead of reverting. Before the
      // fix the launch carried straight on to seeding liquidity into a pool
      // that was never initialized at all.
      //
      // Which of the two loud errors fires depends on whether the (now
      // unpredictable) token address sorts below $ONLYASS: as currency0 the
      // price itself is out of range (PoolInitializationFailed), as currency1
      // the inverted ratio trips OnlyAssSqrtPriceMath's own RatioOutOfRange
      // guard first. Both are hard reverts, so retry across fresh blocks --
      // each one re-rolls the salt, and so the sort order -- until the
      // PoolInitializationFailed path is the one exercised.
      const params = launchParams({ totalSupply: 10n ** 40n, onlyAssForLiquidity: 1n });
      let sawPoolInitializationFailed = false;

      for (let attempt = 0; attempt < 16 && !sawPoolInitializationFailed; attempt++) {
        let reverted = false;
        let message = '';
        try {
          await launchpad.connect(creator).launchToken(params, { value: LAUNCH_FEE });
        } catch (err) {
          reverted = true;
          message = [err?.message, err?.shortMessage, err?.info && JSON.stringify(err.info)].filter(Boolean).join(' ');
        }
        expect(reverted, 'a launch at an unvalidated price must never succeed').to.equal(true);
        if (message.includes('PoolInitializationFailed')) {
          sawPoolInitializationFailed = true;
        } else {
          expect(message).to.include('RatioOutOfRange');
        }
        await network.provider.send('evm_mine');
      }

      expect(sawPoolInitializationFailed, 'never hit the PoolInitializationFailed path in 16 tries').to.equal(true);
      expect(await launchpad.launchCount()).to.equal(0n);
    });
  });

  describe('graduation milestone measures real $ONLYASS, not the creator\'s own supply', function () {
    it('counts exactly the $ONLYASS leg of a swap', async () => {
      const { event } = await launch();
      const onlyAssAddress = await onlyAssToken.getAddress();
      const key = sortedKey(event.args.token, onlyAssAddress, await hook.getAddress());
      const poolId = computePoolId(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks);

      const token = await ethers.getContractAt('LaunchedToken', event.args.token);
      const traderInput = ethers.parseEther('1000');
      await token.connect(creator).transfer(trader.address, traderInput);
      await token.connect(trader).approve(await poolSwapTest.getAddress(), traderInput);

      const zeroForOne = event.args.token.toLowerCase() === key.currency0.toLowerCase();
      const traderBefore = await onlyAssToken.balanceOf(trader.address);
      const platformBefore = await onlyAssToken.balanceOf(platformWallet.address);
      const creatorBefore = await onlyAssToken.balanceOf(creator.address);

      await poolSwapTest.connect(trader).swap(
        key,
        {
          zeroForOne,
          amountSpecified: -traderInput,
          sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
        },
        { takeClaims: false, settleUsingBurn: false },
        '0x',
      );

      // Gross $ONLYASS that left the pool = what the trader kept + both cuts
      // the hook took out of the same output currency.
      const grossOnlyAssOut =
        (await onlyAssToken.balanceOf(trader.address)) - traderBefore +
        ((await onlyAssToken.balanceOf(platformWallet.address)) - platformBefore) +
        ((await onlyAssToken.balanceOf(creator.address)) - creatorBefore);

      expect(await hook.cumulativeOnlyAssVolume(poolId)).to.equal(grossOnlyAssOut);
      // The token leg of this same swap was 1000e18; counting the larger leg
      // (the old behavior) would have recorded that instead.
      expect(await hook.cumulativeOnlyAssVolume(poolId)).to.be.lt(traderInput);
      expect(await hook.cumulativeOnlyAssVolume(poolId)).to.be.lt(ONLYASS_LIQUIDITY);
    });

    it('cannot be reached by launching an absurd supply and swapping a sliver of $ONLYASS', async () => {
      // The gaming vector: the creator picks totalSupply themselves, so a leg
      // denominated in their own token is free to inflate. 1e12 tokens paired
      // against the same 5,000 $ONLYASS means one swap can move ~1e29 wei of
      // token while moving a few hundred $ONLYASS at most.
      const hugeSupply = ethers.parseEther('1000000000000');
      await launchpad.connect(owner).setGraduationParams(ONLYASS_LIQUIDITY, ethers.parseEther('0.5'), ethers.parseEther('0.5'));
      await launchpad.fundGraduationPool({ value: ethers.parseEther('1') });

      const { event } = await launch({ totalSupply: hugeSupply });
      const onlyAssAddress = await onlyAssToken.getAddress();
      const key = sortedKey(event.args.token, onlyAssAddress, await hook.getAddress());
      const poolId = computePoolId(key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks);

      const token = await ethers.getContractAt('LaunchedToken', event.args.token);
      const traderInput = (await token.balanceOf(creator.address)) / 2n;
      await token.connect(creator).transfer(trader.address, traderInput);
      await token.connect(trader).approve(await poolSwapTest.getAddress(), traderInput);

      const zeroForOne = event.args.token.toLowerCase() === key.currency0.toLowerCase();
      await poolSwapTest.connect(trader).swap(
        key,
        {
          zeroForOne,
          amountSpecified: -traderInput,
          sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
        },
        { takeClaims: false, settleUsingBurn: false },
        '0x',
      );

      // The token leg dwarfs the threshold; the $ONLYASS leg cannot, because
      // the pool only ever held ONLYASS_LIQUIDITY of it in the first place.
      expect(traderInput).to.be.gt(ONLYASS_LIQUIDITY);
      expect(await hook.cumulativeOnlyAssVolume(poolId)).to.be.lt(ONLYASS_LIQUIDITY);
      await expect(launchpad.triggerGraduationBonus(0)).to.be.revertedWithCustomError(
        launchpad,
        'GraduationThresholdNotMet',
      );
    });
  });

  describe('rescueERC20', function () {
    it('refuses $ONLYASS and the position manager, but still rescues an unrelated token', async () => {
      const launchpadAddress = await launchpad.getAddress();
      const stuck = ethers.parseEther('1');

      await onlyAssToken.connect(owner).transfer(launchpadAddress, stuck);
      await expect(
        launchpad.connect(owner).rescueERC20(await onlyAssToken.getAddress(), owner.address, stuck),
      ).to.be.revertedWithCustomError(launchpad, 'CannotRescueProtectedToken');
      await expect(
        launchpad.connect(owner).rescueERC20(await positionManager.getAddress(), owner.address, 1),
      ).to.be.revertedWithCustomError(launchpad, 'CannotRescueProtectedToken');

      const random = await (await ethers.getContractFactory('TestERC20')).deploy('Random', 'RND', stuck, owner.address);
      await random.waitForDeployment();
      await random.connect(owner).transfer(launchpadAddress, stuck);

      await launchpad.connect(owner).rescueERC20(await random.getAddress(), other.address, stuck);
      expect(await random.balanceOf(other.address)).to.equal(stuck);
    });
  });
});
