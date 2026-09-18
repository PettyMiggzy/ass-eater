const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('OnlyAssPayments', function () {
  const FEE_BPS = 1000n; // 10%
  const CREATOR_ID = 42n;
  const CONTENT_ID = 7n;

  async function deploy() {
    const [owner, platformWallet, creatorWallet, fan, other] = await ethers.getSigners();

    const Token = await ethers.getContractFactory('MockOnlyAssToken');
    const token = await Token.deploy('Only Ass', 'ONLYASS', ethers.parseEther('1000000'));
    await token.waitForDeployment();

    const MockLaunchpad = await ethers.getContractFactory('MockLaunchpadViews');
    const launchpad = await MockLaunchpad.deploy();
    await launchpad.waitForDeployment();

    const Payments = await ethers.getContractFactory('OnlyAssPayments');
    const payments = await Payments.deploy(
      owner.address,
      platformWallet.address,
      FEE_BPS,
      await token.getAddress(),
      await launchpad.getAddress()
    );
    await payments.waitForDeployment();

    await token.transfer(fan.address, ethers.parseEther('1000'));

    return { owner, platformWallet, creatorWallet, fan, other, token, payments, launchpad };
  }

  describe('ETH payments', function () {
    it('splits ETH 90/10 between creator and platform', async function () {
      const { payments, platformWallet, creatorWallet, fan } = await deploy();
      const amount = ethers.parseEther('1');

      const platformBefore = await ethers.provider.getBalance(platformWallet.address);
      const creatorBefore = await ethers.provider.getBalance(creatorWallet.address);

      await expect(
        payments.connect(fan).payWithETH(CREATOR_ID, CONTENT_ID, creatorWallet.address, { value: amount })
      )
        .to.emit(payments, 'Purchase')
        .withArgs(
          fan.address,
          creatorWallet.address,
          CREATOR_ID,
          ethers.ZeroAddress,
          amount,
          amount / 10n,
          amount - amount / 10n,
          CONTENT_ID
        );

      const platformAfter = await ethers.provider.getBalance(platformWallet.address);
      const creatorAfter = await ethers.provider.getBalance(creatorWallet.address);

      expect(platformAfter - platformBefore).to.equal(amount / 10n);
      expect(creatorAfter - creatorBefore).to.equal(amount - amount / 10n);
    });

    it('reverts on zero-value payment', async function () {
      const { payments, creatorWallet, fan } = await deploy();
      await expect(
        payments.connect(fan).payWithETH(CREATOR_ID, CONTENT_ID, creatorWallet.address, { value: 0 })
      ).to.be.revertedWithCustomError(payments, 'ZeroAmount');
    });

    it('reverts when creator wallet is the zero address', async function () {
      const { payments, fan } = await deploy();
      await expect(
        payments.connect(fan).payWithETH(CREATOR_ID, CONTENT_ID, ethers.ZeroAddress, { value: ethers.parseEther('1') })
      ).to.be.revertedWithCustomError(payments, 'ZeroAddress');
    });

    it('reverts while paused', async function () {
      const { payments, owner, creatorWallet, fan } = await deploy();
      await payments.connect(owner).pause();
      await expect(
        payments.connect(fan).payWithETH(CREATOR_ID, CONTENT_ID, creatorWallet.address, { value: ethers.parseEther('1') })
      ).to.be.revertedWithCustomError(payments, 'EnforcedPause');
    });
  });

  describe('$ONLYASS token payments', function () {
    it('splits token payment 90/10 and requires prior approval', async function () {
      const { payments, platformWallet, creatorWallet, fan, token } = await deploy();
      const amount = ethers.parseEther('100');

      await expect(
        payments.connect(fan).payWithOnlyAss(CREATOR_ID, CONTENT_ID, creatorWallet.address, amount)
      ).to.be.reverted; // no approval yet

      await token.connect(fan).approve(await payments.getAddress(), amount);

      await expect(payments.connect(fan).payWithOnlyAss(CREATOR_ID, CONTENT_ID, creatorWallet.address, amount))
        .to.emit(payments, 'Purchase')
        .withArgs(
          fan.address,
          creatorWallet.address,
          CREATOR_ID,
          await token.getAddress(),
          amount,
          amount / 10n,
          amount - amount / 10n,
          CONTENT_ID
        );

      expect(await token.balanceOf(platformWallet.address)).to.equal(amount / 10n);
      expect(await token.balanceOf(creatorWallet.address)).to.equal(amount - amount / 10n);
    });

    it('leaves no token balance stuck in the contract', async function () {
      const { payments, fan, creatorWallet, token } = await deploy();
      const amount = ethers.parseEther('50');
      await token.connect(fan).approve(await payments.getAddress(), amount);
      await payments.connect(fan).payWithOnlyAss(CREATOR_ID, CONTENT_ID, creatorWallet.address, amount);

      expect(await token.balanceOf(await payments.getAddress())).to.equal(0);
    });
  });

  describe('creator-token payments', function () {
    it('pays a creator in their own token, split the same way as $ONLYASS, once the launchpad confirms they launched it', async function () {
      const { payments, platformWallet, creatorWallet, fan, launchpad } = await deploy();

      const CreatorToken = await ethers.getContractFactory('MockOnlyAssToken');
      const creatorToken = await CreatorToken.deploy('Creator Coin', 'CREATOR', ethers.parseEther('1000000'));
      await creatorToken.waitForDeployment();
      const creatorTokenAddress = await creatorToken.getAddress();
      await creatorToken.transfer(fan.address, ethers.parseEther('100'));
      await launchpad.addLaunch(creatorWallet.address, creatorTokenAddress);

      const amount = ethers.parseEther('100');
      await creatorToken.connect(fan).approve(await payments.getAddress(), amount);

      await expect(
        payments.connect(fan).payWithCreatorToken(CREATOR_ID, CONTENT_ID, creatorWallet.address, creatorTokenAddress, amount)
      )
        .to.emit(payments, 'Purchase')
        .withArgs(fan.address, creatorWallet.address, CREATOR_ID, creatorTokenAddress, amount, amount / 10n, amount - amount / 10n, CONTENT_ID);

      expect(await creatorToken.balanceOf(platformWallet.address)).to.equal(amount / 10n);
      expect(await creatorToken.balanceOf(creatorWallet.address)).to.equal(amount - amount / 10n);
    });

    it('rejects a token that creator never launched on the launchpad', async function () {
      const { payments, creatorWallet, fan } = await deploy();

      const RandomToken = await ethers.getContractFactory('MockOnlyAssToken');
      const randomToken = await RandomToken.deploy('Random', 'RND', ethers.parseEther('1000'));
      await randomToken.waitForDeployment();
      await randomToken.transfer(fan.address, ethers.parseEther('10'));
      await randomToken.connect(fan).approve(await payments.getAddress(), ethers.parseEther('10'));

      await expect(
        payments.connect(fan).payWithCreatorToken(CREATOR_ID, CONTENT_ID, creatorWallet.address, await randomToken.getAddress(), ethers.parseEther('10'))
      ).to.be.revertedWithCustomError(payments, 'TokenNotLaunchedByCreator');
    });

    it('rejects someone else\'s launched token when claiming a different creator wallet', async function () {
      const { payments, creatorWallet, fan, other, launchpad } = await deploy();

      const CreatorToken = await ethers.getContractFactory('MockOnlyAssToken');
      const creatorToken = await CreatorToken.deploy('Creator Coin', 'CREATOR', ethers.parseEther('1000'));
      await creatorToken.waitForDeployment();
      await creatorToken.transfer(fan.address, ethers.parseEther('10'));
      await creatorToken.connect(fan).approve(await payments.getAddress(), ethers.parseEther('10'));
      // "other" launched this token, not "creatorWallet"
      await launchpad.addLaunch(other.address, await creatorToken.getAddress());

      await expect(
        payments.connect(fan).payWithCreatorToken(CREATOR_ID, CONTENT_ID, creatorWallet.address, await creatorToken.getAddress(), ethers.parseEther('10'))
      ).to.be.revertedWithCustomError(payments, 'TokenNotLaunchedByCreator');
    });

    it('reverts with LaunchpadNotSet when no launchpad has been configured', async function () {
      const [owner, platformWallet, creatorWallet, fan] = await ethers.getSigners();
      const Token = await ethers.getContractFactory('MockOnlyAssToken');
      const token = await Token.deploy('Only Ass', 'ONLYASS', ethers.parseEther('1000'));
      await token.waitForDeployment();
      const Payments = await ethers.getContractFactory('OnlyAssPayments');
      const paymentsNoLaunchpad = await Payments.deploy(
        owner.address,
        platformWallet.address,
        FEE_BPS,
        await token.getAddress(),
        ethers.ZeroAddress
      );
      await paymentsNoLaunchpad.waitForDeployment();

      await expect(
        paymentsNoLaunchpad.connect(fan).payWithCreatorToken(CREATOR_ID, CONTENT_ID, creatorWallet.address, await token.getAddress(), ethers.parseEther('1'))
      ).to.be.revertedWithCustomError(paymentsNoLaunchpad, 'LaunchpadNotSet');
    });
  });

  describe('admin controls', function () {
    it('takes its owner from the constructor, not from whoever broadcast the deploy', async function () {
      // Matches every other contract in this repo (both launchpads, the hook,
      // the NFT drops contract): the deploying key and the intended owner are
      // not necessarily the same address.
      const [deployer, platformWallet, intendedOwner] = await ethers.getSigners();
      const Token = await ethers.getContractFactory('MockOnlyAssToken');
      const token = await Token.deploy('Only Ass', 'ONLYASS', ethers.parseEther('1000'));
      await token.waitForDeployment();

      const Payments = await ethers.getContractFactory('OnlyAssPayments');
      const payments = await Payments.connect(deployer).deploy(
        intendedOwner.address,
        platformWallet.address,
        FEE_BPS,
        await token.getAddress(),
        ethers.ZeroAddress
      );
      await payments.waitForDeployment();

      expect(await payments.owner()).to.equal(intendedOwner.address);
      await expect(payments.connect(deployer).setPlatformFeeBps(500)).to.be.revertedWithCustomError(
        payments,
        'OwnableUnauthorizedAccount'
      );
      await expect(payments.connect(intendedOwner).setPlatformFeeBps(500)).to.not.be.reverted;
    });

    it('only owner can change the platform wallet', async function () {
      const { payments, other, creatorWallet } = await deploy();
      await expect(payments.connect(other).setPlatformWallet(creatorWallet.address)).to.be.revertedWithCustomError(
        payments,
        'OwnableUnauthorizedAccount'
      );
    });

    it('rejects a fee above the hard cap', async function () {
      const { payments, owner } = await deploy();
      await expect(payments.connect(owner).setPlatformFeeBps(3001)).to.be.revertedWithCustomError(
        payments,
        'FeeTooHigh'
      );
    });

    it('applies a new fee to subsequent payments', async function () {
      const { payments, owner, platformWallet, creatorWallet, fan } = await deploy();
      await payments.connect(owner).setPlatformFeeBps(2000); // 20%

      const amount = ethers.parseEther('1');
      const platformBefore = await ethers.provider.getBalance(platformWallet.address);
      await payments.connect(fan).payWithETH(CREATOR_ID, CONTENT_ID, creatorWallet.address, { value: amount });
      const platformAfter = await ethers.provider.getBalance(platformWallet.address);

      expect(platformAfter - platformBefore).to.equal((amount * 2000n) / 10000n);
    });

    it('lets the owner rescue ERC-20 tokens sent to the contract by mistake', async function () {
      const { payments, owner, other, token } = await deploy();
      await token.transfer(await payments.getAddress(), ethers.parseEther('10'));

      const tokenAddress = await token.getAddress();
      await expect(() =>
        payments.connect(owner).rescueERC20(tokenAddress, other.address, ethers.parseEther('10'))
      ).to.changeTokenBalance(token, other, ethers.parseEther('10'));
    });
  });
});
