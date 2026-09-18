const { expect } = require('chai');
const { ethers } = require('hardhat');

// Regression guard for the token-address-squatting DoS on both launchpads.
//
// Neither contract can make its CREATE2 salt secret from a transaction earlier
// in the same block -- every input is either in the victim's own pending
// calldata or is a public block/state value -- so the only lever either one has
// against a same-block squatter is how many candidate addresses it will try.
// That number is therefore load-bearing, and the two contracts DELIBERATELY do
// not share it: squatting a V2 candidate costs a whole UniswapV2Pair
// deployment, squatting a V4 candidate costs a bare PoolManager.initialize
// (~2 orders of magnitude cheaper), so V4 needs a correspondingly wider set to
// keep the grief uneconomical. Pinned here so "harmonize these two constants"
// can't quietly land as a cleanup -- see the long comments on
// OnlyAssLaunchpad._deployLaunchedToken and
// OnlyAssLaunchpadV4._deployTokenForFreshPool.
//
// Both constructors only null-check their addresses, so this deploys with
// arbitrary non-zero ones rather than standing up a real Uniswap V2 factory or
// a whole V4 PoolManager/PositionManager/Permit2 stack -- nothing here calls
// into any of them.
describe('launchpad candidate-address budget', function () {
  it('OnlyAssLaunchpad (V2) tries 8 candidates', async () => {
    const [owner, platformWallet, onlyAssToken, uniswapFactory, uniswapRouter] = await ethers.getSigners();

    const Launchpad = await ethers.getContractFactory('OnlyAssLaunchpad');
    const launchpad = await Launchpad.deploy(
      owner.address,
      platformWallet.address,
      onlyAssToken.address,
      uniswapFactory.address,
      uniswapRouter.address
    );
    await launchpad.waitForDeployment();

    expect(await launchpad.MAX_ADDRESS_ATTEMPTS()).to.equal(8n);
  });

  it('OnlyAssLaunchpadV4 tries far more, because squatting a V4 pool is far cheaper', async () => {
    const [owner, platformWallet, onlyAssToken, poolManager, positionManager, permit2, hook] =
      await ethers.getSigners();

    const Launchpad = await ethers.getContractFactory('OnlyAssLaunchpadV4');
    const launchpad = await Launchpad.deploy(
      owner.address,
      platformWallet.address,
      onlyAssToken.address,
      poolManager.address,
      positionManager.address,
      permit2.address,
      hook.address
    );
    await launchpad.waitForDeployment();

    const v4Attempts = await launchpad.MAX_ADDRESS_ATTEMPTS();
    expect(v4Attempts).to.equal(128n);
    // The point of the number is the ratio, not the number: an attacker pays
    // roughly 35k gas per squatted candidate and has to cover all of them,
    // every block, in a transaction that lands before the creator's.
    expect(v4Attempts).to.be.gte(64n);
  });
});
