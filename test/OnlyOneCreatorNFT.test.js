const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('OnlyOneCreatorNFT', function () {
  const FEE_BPS = 1000n; // 10%

  async function deploy() {
    const [owner, platformWallet, creator, fan, fan2, other] = await ethers.getSigners();

    const OnlyOne = await ethers.getContractFactory('MockOnlyOneToken');
    const onlyOne = await OnlyOne.deploy('Only One', 'ONLYONE', ethers.parseEther('1000000'));
    await onlyOne.waitForDeployment();

    const NFT = await ethers.getContractFactory('OnlyOneCreatorNFT');
    const nft = await NFT.deploy(
      owner.address,
      platformWallet.address,
      FEE_BPS,
      await onlyOne.getAddress(),
      'https://joinonlyone.com/api/nft-contract-metadata',
    );
    await nft.waitForDeployment();

    await onlyOne.transfer(fan.address, ethers.parseEther('10000'));
    await onlyOne.transfer(fan2.address, ethers.parseEther('10000'));

    return { owner, platformWallet, creator, fan, fan2, other, onlyOne, nft };
  }

  async function createEthDrop(nft, creator, overrides = {}) {
    const tx = await nft.connect(creator).createDrop(
      overrides.payToken ?? ethers.ZeroAddress,
      overrides.price ?? ethers.parseEther('0.1'),
      overrides.editionSize ?? 10,
      overrides.metadataURI ?? 'https://joinonlyone.com/api/nft/1',
    );
    const receipt = await tx.wait();
    const event = receipt.logs.map((l) => { try { return nft.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'DropCreated');
    return event.args.dropId;
  }

  describe('createDrop', function () {
    it('creates an ETH-priced drop and emits DropCreated', async function () {
      const { nft, creator } = await deploy();
      await expect(nft.connect(creator).createDrop(ethers.ZeroAddress, ethers.parseEther('0.05'), 25, 'https://joinonlyone.com/api/nft/1'))
        .to.emit(nft, 'DropCreated')
        .withArgs(0, creator.address, ethers.ZeroAddress, ethers.parseEther('0.05'), 25, 'https://joinonlyone.com/api/nft/1');
    });

    it('allows $ONLYONE as the pay token', async function () {
      const { nft, creator, onlyOne } = await deploy();
      await expect(nft.connect(creator).createDrop(await onlyOne.getAddress(), ethers.parseEther('50'), 5, 'uri')).to.not.be.reverted;
    });

    // ETH and $ONLYONE are the only accepted pay tokens. A creator's own
    // launched token used to be a third option, verified against a
    // launchpad contract; that launchpad was removed from the repo, so an
    // arbitrary ERC-20 must now be rejected outright rather than accepted on
    // the strength of a launch record that can no longer exist.
    it('rejects any other ERC-20 as the pay token', async function () {
      const { nft, creator } = await deploy();
      const RandomToken = await ethers.getContractFactory('MockOnlyOneToken');
      const randomToken = await RandomToken.deploy('Random', 'RND', ethers.parseEther('1000'));

      await expect(
        nft.connect(creator).createDrop(await randomToken.getAddress(), ethers.parseEther('10'), 5, 'uri'),
      ).to.be.revertedWithCustomError(nft, 'InvalidPayToken');
    });

    it('rejects a zero or absurd edition size', async function () {
      const { nft, creator } = await deploy();
      await expect(nft.connect(creator).createDrop(ethers.ZeroAddress, ethers.parseEther('0.1'), 0, 'uri')).to.be.revertedWithCustomError(nft, 'InvalidEditionSize');
      await expect(nft.connect(creator).createDrop(ethers.ZeroAddress, ethers.parseEther('0.1'), 100_001, 'uri')).to.be.revertedWithCustomError(nft, 'InvalidEditionSize');
    });

    it('rejects a zero price', async function () {
      const { nft, creator } = await deploy();
      await expect(nft.connect(creator).createDrop(ethers.ZeroAddress, 0, 10, 'uri')).to.be.revertedWithCustomError(nft, 'ZeroAmount');
    });

    it('rejects an empty metadata URI', async function () {
      const { nft, creator } = await deploy();
      await expect(nft.connect(creator).createDrop(ethers.ZeroAddress, ethers.parseEther('0.1'), 10, '')).to.be.revertedWithCustomError(nft, 'EmptyMetadataURI');
    });

    it('a 1-of-1 drop is just editionSize 1 -- same mechanism, no special path', async function () {
      const { nft, creator } = await deploy();
      const dropId = await createEthDrop(nft, creator, { editionSize: 1 });
      expect((await nft.drops(dropId)).editionSize).to.equal(1n);
    });
  });

  describe('mintEdition (ETH)', function () {
    it('splits the payment 90/10 and mints one unit to the buyer', async function () {
      const { nft, creator, platformWallet, fan } = await deploy();
      const price = ethers.parseEther('0.1');
      const dropId = await createEthDrop(nft, creator, { price });

      const platformBefore = await ethers.provider.getBalance(platformWallet.address);
      const creatorBefore = await ethers.provider.getBalance(creator.address);

      await expect(nft.connect(fan).mintEdition(dropId, { value: price }))
        .to.emit(nft, 'Minted')
        .withArgs(dropId, fan.address, 1, price, price / 10n, price - price / 10n);

      expect(await ethers.provider.getBalance(platformWallet.address) - platformBefore).to.equal(price / 10n);
      expect(await ethers.provider.getBalance(creator.address) - creatorBefore).to.equal(price - price / 10n);
      expect(await nft.balanceOf(fan.address, dropId)).to.equal(1n);
      expect((await nft.drops(dropId)).minted).to.equal(1n);
    });

    it('numbers editions in mint order and lets the same fan buy multiple copies', async function () {
      const { nft, creator, fan } = await deploy();
      const price = ethers.parseEther('0.1');
      const dropId = await createEthDrop(nft, creator, { price, editionSize: 5 });

      await expect(nft.connect(fan).mintEdition(dropId, { value: price })).to.emit(nft, 'Minted').withArgs(dropId, fan.address, 1, price, price / 10n, price - price / 10n);
      await expect(nft.connect(fan).mintEdition(dropId, { value: price })).to.emit(nft, 'Minted').withArgs(dropId, fan.address, 2, price, price / 10n, price - price / 10n);

      expect(await nft.balanceOf(fan.address, dropId)).to.equal(2n);
    });

    it('rejects sending the wrong ETH amount', async function () {
      const { nft, creator, fan } = await deploy();
      const dropId = await createEthDrop(nft, creator, { price: ethers.parseEther('0.1') });
      await expect(nft.connect(fan).mintEdition(dropId, { value: ethers.parseEther('0.05') })).to.be.revertedWithCustomError(nft, 'WrongPaymentValue');
    });

    it('sells out after editionSize copies and rejects further mints', async function () {
      const { nft, creator, fan, fan2 } = await deploy();
      const price = ethers.parseEther('0.01');
      const dropId = await createEthDrop(nft, creator, { price, editionSize: 2 });

      await nft.connect(fan).mintEdition(dropId, { value: price });
      await nft.connect(fan2).mintEdition(dropId, { value: price });

      await expect(nft.connect(fan).mintEdition(dropId, { value: price })).to.be.revertedWithCustomError(nft, 'DropSoldOut');
    });

    it('rejects minting an invalid dropId', async function () {
      const { nft, fan } = await deploy();
      await expect(nft.connect(fan).mintEdition(99, { value: 1 })).to.be.revertedWithCustomError(nft, 'InvalidDropId');
    });

    it('lets only the creator close their own drop, blocking further mints', async function () {
      const { nft, creator, fan, other } = await deploy();
      const price = ethers.parseEther('0.1');
      const dropId = await createEthDrop(nft, creator, { price });

      await expect(nft.connect(other).closeDrop(dropId)).to.be.revertedWithCustomError(nft, 'NotDropCreator');

      await expect(nft.connect(creator).closeDrop(dropId)).to.emit(nft, 'DropClosed').withArgs(dropId);
      await expect(nft.connect(fan).mintEdition(dropId, { value: price })).to.be.revertedWithCustomError(nft, 'DropNotActive');
    });
  });

  describe('mintEdition (ERC-20: $ONLYONE)', function () {
    it('pulls $ONLYONE via approval and splits it the same way', async function () {
      const { nft, creator, platformWallet, fan, onlyOne } = await deploy();
      const price = ethers.parseEther('100');
      const dropId = await createEthDrop(nft, creator, { payToken: await onlyOne.getAddress(), price });

      await expect(nft.connect(fan).mintEdition(dropId)).to.be.reverted; // no approval yet
      await onlyOne.connect(fan).approve(await nft.getAddress(), price);

      await nft.connect(fan).mintEdition(dropId);

      expect(await onlyOne.balanceOf(platformWallet.address)).to.equal(price / 10n);
      expect(await onlyOne.balanceOf(creator.address)).to.equal(price - price / 10n);
      expect(await nft.balanceOf(fan.address, dropId)).to.equal(1n);
    });

    it('rejects sending ETH value on an ERC-20-priced drop', async function () {
      const { nft, creator, fan, onlyOne } = await deploy();
      const price = ethers.parseEther('100');
      const dropId = await createEthDrop(nft, creator, { payToken: await onlyOne.getAddress(), price });
      await onlyOne.connect(fan).approve(await nft.getAddress(), price);

      await expect(nft.connect(fan).mintEdition(dropId, { value: 1 })).to.be.revertedWithCustomError(nft, 'WrongPaymentValue');
    });
  });

  describe('uri', function () {
    it('returns the drop-specific metadata URI', async function () {
      const { nft, creator } = await deploy();
      const dropId = await createEthDrop(nft, creator, { metadataURI: 'https://joinonlyone.com/api/nft/42' });
      expect(await nft.uri(dropId)).to.equal('https://joinonlyone.com/api/nft/42');
    });

    it('reverts for an invalid drop id', async function () {
      const { nft } = await deploy();
      await expect(nft.uri(99)).to.be.revertedWithCustomError(nft, 'InvalidDropId');
    });
  });

  describe('admin controls', function () {
    it('only owner can change the platform wallet', async function () {
      const { nft, other, creator } = await deploy();
      await expect(nft.connect(other).setPlatformWallet(creator.address)).to.be.revertedWithCustomError(nft, 'OwnableUnauthorizedAccount');
    });

    it('rejects a fee above the hard cap', async function () {
      const { nft, owner } = await deploy();
      await expect(nft.connect(owner).setPlatformFeeBps(3001)).to.be.revertedWithCustomError(nft, 'FeeTooHigh');
    });

    it('applies a new fee to subsequent mints', async function () {
      const { nft, owner, creator, platformWallet, fan } = await deploy();
      await nft.connect(owner).setPlatformFeeBps(2000); // 20%
      const price = ethers.parseEther('1');
      const dropId = await createEthDrop(nft, creator, { price });

      const platformBefore = await ethers.provider.getBalance(platformWallet.address);
      await nft.connect(fan).mintEdition(dropId, { value: price });
      expect(await ethers.provider.getBalance(platformWallet.address) - platformBefore).to.equal((price * 2000n) / 10000n);
    });

    it('pauses new drops and mints', async function () {
      const { nft, owner, creator, fan } = await deploy();
      const dropId = await createEthDrop(nft, creator, { price: ethers.parseEther('0.1') });
      await nft.connect(owner).pause();

      await expect(nft.connect(creator).createDrop(ethers.ZeroAddress, ethers.parseEther('0.1'), 5, 'uri')).to.be.revertedWithCustomError(nft, 'EnforcedPause');
      await expect(nft.connect(fan).mintEdition(dropId, { value: ethers.parseEther('0.1') })).to.be.revertedWithCustomError(nft, 'EnforcedPause');
    });

    it('lets the owner rescue ERC-20 tokens sent to the contract by mistake', async function () {
      const { nft, owner, other, onlyOne } = await deploy();
      await onlyOne.transfer(await nft.getAddress(), ethers.parseEther('10'));
      const onlyOneAddress = await onlyOne.getAddress();
      await expect(() =>
        nft.connect(owner).rescueERC20(onlyOneAddress, other.address, ethers.parseEther('10')),
      ).to.changeTokenBalance(onlyOne, other, ethers.parseEther('10'));
    });
  });
});
