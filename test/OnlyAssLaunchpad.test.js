const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

const FactoryArtifact = require('@uniswap/v2-core/build/UniswapV2Factory.json');
const RouterArtifact = require('@uniswap/v2-periphery/build/UniswapV2Router02.json');
const WETHArtifact = require('@uniswap/v2-periphery/build/WETH9.json');
const PairArtifact = require('@uniswap/v2-core/build/IUniswapV2Pair.json');

const ONE_ETH = ethers.parseEther('1');
const LAUNCH_FEE = ethers.parseEther('0.01');
const SUPPLY = ethers.parseEther('1000000'); // 1,000,000 tokens, 18 decimals
const ONLYASS_LIQUIDITY = ethers.parseEther('5000');

async function deployUniswap(deployer) {
  const Factory = new ethers.ContractFactory(FactoryArtifact.abi, FactoryArtifact.bytecode, deployer);
  const factory = await Factory.deploy(deployer.address);
  await factory.waitForDeployment();

  const WETH = new ethers.ContractFactory(WETHArtifact.abi, WETHArtifact.bytecode, deployer);
  const weth = await WETH.deploy();
  await weth.waitForDeployment();

  const Router = new ethers.ContractFactory(RouterArtifact.abi, RouterArtifact.bytecode, deployer);
  const router = await Router.deploy(await factory.getAddress(), await weth.getAddress());
  await router.waitForDeployment();

  return { factory, router, weth };
}

function launchParams(overrides = {}) {
  return {
    name: 'Creator Coin',
    symbol: 'CREATOR',
    totalSupply: SUPPLY,
    tokenLiquidityBps: 8_000, // 80%
    onlyAssForLiquidity: ONLYASS_LIQUIDITY,
    minTokenLiquidity: 0,
    minOnlyAssLiquidity: 0,
    ...overrides,
  };
}

describe('OnlyAssLaunchpad', function () {
  let owner, platformWallet, creator, other;
  let launchpad, onlyAssToken, factory, router;

  beforeEach(async () => {
    [owner, platformWallet, creator, other] = await ethers.getSigners();

    ({ factory, router } = await deployUniswap(owner));

    const TestERC20 = await ethers.getContractFactory('TestERC20');
    onlyAssToken = await TestERC20.deploy('OnlyAss', 'ONLYASS', ethers.parseEther('1000000000'), owner.address);
    await onlyAssToken.waitForDeployment();
    await onlyAssToken.transfer(creator.address, ethers.parseEther('1000000'));

    const Launchpad = await ethers.getContractFactory('OnlyAssLaunchpad');
    launchpad = await Launchpad.deploy(
      owner.address,
      platformWallet.address,
      await onlyAssToken.getAddress(),
      await factory.getAddress(),
      await router.getAddress()
    );
    await launchpad.waitForDeployment();

    await onlyAssToken.connect(creator).approve(await launchpad.getAddress(), ethers.MaxUint256);
  });

  it('rejects a launch with insufficient ETH fee', async () => {
    await expect(
      launchpad.connect(creator).launchToken(launchParams(), { value: LAUNCH_FEE - 1n })
    ).to.be.revertedWithCustomError(launchpad, 'InsufficientFee');
  });

  it('rejects tokenLiquidityBps below the minimum', async () => {
    await expect(
      launchpad.connect(creator).launchToken(launchParams({ tokenLiquidityBps: 4_999 }), { value: LAUNCH_FEE })
    ).to.be.revertedWithCustomError(launchpad, 'LiquidityBpsOutOfRange');
  });

  it('rejects tokenLiquidityBps that would leave nothing for the platform cut', async () => {
    // platformSupplyBps defaults to 1000 (10%), so max allowed is 9000
    await expect(
      launchpad.connect(creator).launchToken(launchParams({ tokenLiquidityBps: 9_001 }), { value: LAUNCH_FEE })
    ).to.be.revertedWithCustomError(launchpad, 'LiquidityBpsOutOfRange');
  });

  it('rejects a zero total supply or zero liquidity contribution', async () => {
    await expect(
      launchpad.connect(creator).launchToken(launchParams({ totalSupply: 0 }), { value: LAUNCH_FEE })
    ).to.be.revertedWithCustomError(launchpad, 'ZeroAmount');
    await expect(
      launchpad.connect(creator).launchToken(launchParams({ onlyAssForLiquidity: 0 }), { value: LAUNCH_FEE })
    ).to.be.revertedWithCustomError(launchpad, 'ZeroAmount');
  });

  it('reverts if the creator never approved $ONLYASS', async () => {
    await onlyAssToken.connect(creator).approve(await launchpad.getAddress(), 0);
    await expect(
      launchpad.connect(creator).launchToken(launchParams(), { value: LAUNCH_FEE })
    ).to.be.reverted;
  });

  describe('a successful launch', function () {
    let tx, receipt, launchId, tokenAddress, pairAddress;

    beforeEach(async () => {
      const platformBalBefore = await ethers.provider.getBalance(platformWallet.address);
      tx = await launchpad.connect(creator).launchToken(launchParams(), { value: LAUNCH_FEE });
      receipt = await tx.wait();
      const event = receipt.logs
        .map((log) => { try { return launchpad.interface.parseLog(log); } catch { return null; } })
        .find((e) => e && e.name === 'TokenLaunched');
      launchId = event.args.launchId;
      tokenAddress = event.args.token;
      pairAddress = event.args.pair;
      this.platformBalBefore = platformBalBefore;
    });

    it('mints the platform its 10% cut', async () => {
      const token = await ethers.getContractAt('LaunchedToken', tokenAddress);
      expect(await token.balanceOf(platformWallet.address)).to.equal(SUPPLY / 10n);
    });

    it('sends the creator whatever is left after platform + liquidity', async () => {
      const token = await ethers.getContractAt('LaunchedToken', tokenAddress);
      const platformCut = SUPPLY / 10n; // 10%
      const liquidityTokens = (SUPPLY * 8000n) / 10000n; // 80%
      const expectedCreatorCut = SUPPLY - platformCut - liquidityTokens; // 10%
      expect(await token.balanceOf(creator.address)).to.equal(expectedCreatorCut);
    });

    it('seeds a real Uniswap pool paired with $ONLYASS, not ETH/WETH', async () => {
      const pair = new ethers.Contract(pairAddress, PairArtifact.abi, ethers.provider);
      const token0 = await pair.token0();
      const token1 = await pair.token1();
      const wethAddr = (await router.WETH()).toLowerCase();
      expect(token0.toLowerCase()).to.not.equal(wethAddr);
      expect(token1.toLowerCase()).to.not.equal(wethAddr);
      const onlyAssAddr = (await onlyAssToken.getAddress()).toLowerCase();
      expect([token0.toLowerCase(), token1.toLowerCase()]).to.include(onlyAssAddr);
      expect([token0.toLowerCase(), token1.toLowerCase()]).to.include(tokenAddress.toLowerCase());

      const [reserve0, reserve1] = await pair.getReserves();
      const totalReserve = reserve0 + reserve1;
      expect(totalReserve).to.be.gt(0);
    });

    it('holds the LP tokens in escrow, not sent to the creator', async () => {
      const pair = new ethers.Contract(pairAddress, PairArtifact.abi, ethers.provider);
      expect(await pair.balanceOf(creator.address)).to.equal(0n);
      expect(await pair.balanceOf(await launchpad.getAddress())).to.be.gt(0n);
    });

    it('forwards the ETH launch fee to the platform wallet', async () => {
      const platformBalAfter = await ethers.provider.getBalance(platformWallet.address);
      expect(platformBalAfter - this.platformBalBefore).to.equal(LAUNCH_FEE);
    });

    it('records the launch and locks it for LOCK_DURATION', async () => {
      const launch = await launchpad.launches(launchId);
      expect(launch.creator).to.equal(creator.address);
      expect(launch.withdrawn).to.equal(false);
      const lockDuration = await launchpad.LOCK_DURATION();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      expect(launch.unlockTime).to.equal(BigInt(block.timestamp) + lockDuration);
    });

    it('rejects withdrawing liquidity before the lock expires', async () => {
      await expect(launchpad.connect(creator).withdrawLiquidity(launchId)).to.be.revertedWithCustomError(
        launchpad,
        'StillLocked'
      );
    });

    it('rejects withdrawal by anyone other than the launching creator', async () => {
      await time.increase(180 * 24 * 60 * 60 + 1);
      await expect(launchpad.connect(other).withdrawLiquidity(launchId)).to.be.revertedWithCustomError(
        launchpad,
        'NotLaunchCreator'
      );
    });

    it('lets the creator withdraw their LP position after the lock expires, once', async () => {
      await time.increase(180 * 24 * 60 * 60 + 1);
      const pair = new ethers.Contract(pairAddress, PairArtifact.abi, ethers.provider);
      const lpBalanceLocked = await pair.balanceOf(await launchpad.getAddress());

      await launchpad.connect(creator).withdrawLiquidity(launchId);
      expect(await pair.balanceOf(creator.address)).to.equal(lpBalanceLocked);

      await expect(launchpad.connect(creator).withdrawLiquidity(launchId)).to.be.revertedWithCustomError(
        launchpad,
        'AlreadyWithdrawn'
      );
    });

    it('never lets the owner rescue a tracked pair token, even after it is withdrawable', async () => {
      await time.increase(180 * 24 * 60 * 60 + 1);
      await expect(launchpad.connect(owner).rescueERC20(pairAddress, owner.address, 1)).to.be.revertedWithCustomError(
        launchpad,
        'CannotRescueTrackedPair'
      );
    });
  });

  it('lets the owner rescue an unrelated token sent by mistake', async () => {
    const TestERC20 = await ethers.getContractFactory('TestERC20');
    const randomToken = await TestERC20.deploy('Random', 'RND', ONE_ETH, owner.address);
    await randomToken.waitForDeployment();
    await randomToken.transfer(await launchpad.getAddress(), ONE_ETH);

    await launchpad.connect(owner).rescueERC20(await randomToken.getAddress(), other.address, ONE_ETH);
    expect(await randomToken.balanceOf(other.address)).to.equal(ONE_ETH);
  });

  it('enforces the hard ceiling on platform supply bps even for the owner', async () => {
    await expect(launchpad.connect(owner).setPlatformSupplyBps(2_001)).to.be.revertedWithCustomError(
      launchpad,
      'SupplyBpsTooHigh'
    );
    await expect(launchpad.connect(owner).setPlatformSupplyBps(2_000)).to.not.be.reverted;
  });

  it('restricts admin functions to the owner', async () => {
    await expect(launchpad.connect(other).setPlatformSupplyBps(500)).to.be.revertedWithCustomError(
      launchpad,
      'OwnableUnauthorizedAccount'
    );
    await expect(launchpad.connect(other).setLaunchFeeWei(0)).to.be.revertedWithCustomError(
      launchpad,
      'OwnableUnauthorizedAccount'
    );
    await expect(launchpad.connect(other).setPlatformWallet(other.address)).to.be.revertedWithCustomError(
      launchpad,
      'OwnableUnauthorizedAccount'
    );
    await expect(launchpad.connect(other).pause()).to.be.revertedWithCustomError(
      launchpad,
      'OwnableUnauthorizedAccount'
    );
  });

  describe('token-address squatting (permanent-DoS finding)', function () {
    async function launchAndGetToken() {
      const receipt = await (await launchpad.connect(creator).launchToken(launchParams(), { value: LAUNCH_FEE })).wait();
      const event = receipt.logs
        .map((log) => { try { return launchpad.interface.parseLog(log); } catch { return null; } })
        .find((e) => e && e.name === 'TokenLaunched');
      return event.args.token;
    }

    it("still launches when the plain-CREATE address's pair has already been squatted", async () => {
      // The attack this defends against: with a plain `new LaunchedToken(...)`
      // the next launch's token address is just keccak(rlp(launchpad, nonce)),
      // which anyone can compute, and createPair is permissionless -- so an
      // attacker creates that pair first and launchToken reverts with
      // PAIR_EXISTS. A reverted launch never advances the launchpad's nonce,
      // so every later launch deploys to the same squatted address and
      // reverts too. One cheap transaction, bricked forever, for everyone.
      const onlyAssAddress = await onlyAssToken.getAddress();
      // A contract account's nonce starts at 1, and this launchpad has not
      // deployed anything yet, so this is exactly where a plain CREATE would
      // have put the first launched token.
      const squatted = ethers.getCreateAddress({ from: await launchpad.getAddress(), nonce: 1 });

      await factory.connect(other).createPair(squatted, onlyAssAddress);
      expect(await factory.getPair(squatted, onlyAssAddress)).to.not.equal(ethers.ZeroAddress);

      const tokenAddress = await launchAndGetToken();
      expect(tokenAddress.toLowerCase()).to.not.equal(squatted.toLowerCase());
      expect(await launchpad.launchCount()).to.equal(1n);
    });

    it('deploys to a different token address on every launch, even with identical params', async () => {
      const first = await launchAndGetToken();
      const second = await launchAndGetToken();
      expect(first.toLowerCase()).to.not.equal(second.toLowerCase());
    });
  });

  it('blocks new launches while paused', async () => {
    await launchpad.connect(owner).pause();
    await expect(
      launchpad.connect(creator).launchToken(launchParams(), { value: LAUNCH_FEE })
    ).to.be.revertedWithCustomError(launchpad, 'EnforcedPause');
    await launchpad.connect(owner).unpause();
    await expect(launchpad.connect(creator).launchToken(launchParams(), { value: LAUNCH_FEE })).to.not.be.reverted;
  });
});
