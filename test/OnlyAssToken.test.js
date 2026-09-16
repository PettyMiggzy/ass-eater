const { expect } = require('chai');
const { ethers } = require('hardhat');

const SUPPLY = ethers.parseEther('1000000000'); // 1B $ONLYASS, 18 decimals

describe('OnlyAssToken', () => {
  it('mints the entire supply to the deployer and nowhere else', async () => {
    const [deployer, other] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('OnlyAssToken');
    const token = await Token.deploy('Only Ass', 'ONLYASS', SUPPLY);
    await token.waitForDeployment();

    expect(await token.totalSupply()).to.equal(SUPPLY);
    expect(await token.balanceOf(deployer.address)).to.equal(SUPPLY);
    expect(await token.balanceOf(other.address)).to.equal(0n);
    expect(await token.name()).to.equal('Only Ass');
    expect(await token.symbol()).to.equal('ONLYASS');
    expect(await token.decimals()).to.equal(18);
  });

  it('exposes no mint function -- supply is fixed forever after deploy', async () => {
    const Token = await ethers.getContractFactory('OnlyAssToken');
    const token = await Token.deploy('Only Ass', 'ONLYASS', SUPPLY);
    await token.waitForDeployment();
    expect(token.mint).to.equal(undefined);
  });

  it('supports standard transfers', async () => {
    const [deployer, recipient] = await ethers.getSigners();
    const Token = await ethers.getContractFactory('OnlyAssToken');
    const token = await Token.deploy('Only Ass', 'ONLYASS', SUPPLY);
    await token.waitForDeployment();

    await token.transfer(recipient.address, ethers.parseEther('100'));
    expect(await token.balanceOf(recipient.address)).to.equal(ethers.parseEther('100'));
    expect(await token.balanceOf(deployer.address)).to.equal(SUPPLY - ethers.parseEther('100'));
  });
});
