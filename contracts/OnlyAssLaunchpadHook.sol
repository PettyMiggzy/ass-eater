// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title OnlyAssLaunchpadHook
/// @notice The one and only hook contract attached to every pool this launchpad
/// creates. It has exactly two permissions -- afterSwap and afterSwapReturnDelta
/// -- and does exactly one thing: on every swap, it takes a fixed 1% platform
/// fee plus the launching creator's own (capped) trading tax, in the swap's
/// output currency, and routes both cuts directly out of the PoolManager to
/// their final destination (`platformWallet` / that pool's `creatorWallet`).
/// It never itself holds a token balance -- `PoolManager.take()` can send to
/// any address, so there's nothing sitting in this contract for a bug (or a
/// compromised owner key) to steal.
///
/// @dev This hook's address is deployed via CREATE2 through `HookDeployer.sol`
/// with a salt mined by `scripts/mine-hook-salt.js` so its low bits encode
/// exactly `AFTER_SWAP_FLAG | AFTER_SWAP_RETURNS_DELTA_FLAG` -- see that
/// script for why, and Hooks.sol's own top-of-file comment for the mechanism.
///
/// SECURITY NOTE (read before mainnet use): this file was written against the
/// real `uniswap/v4-core` interfaces (fee-taking pattern modeled directly on
/// Uniswap's own reference `src/test/FeeTakingHook.sol`). Unlike most V4
/// integrations, this one IS exercised against a real, locally-compiled
/// `PoolManager` (not a mock) -- see
/// `test/OnlyAssLaunchpadV4.integration.test.js`, which deploys real
/// PoolManager/PositionManager/Permit2/PoolSwapTest contracts (forced into
/// Hardhat's compile graph via `contracts/test/V4TestDeployment.sol` +
/// `PermitTestDeployment.sol`, since `uniswap/v4-core` ships Foundry-only
/// build artifacts, not prebuilt Hardhat-compatible bytecode) and runs a real
/// swap through a real pool with this hook attached, asserting the fee split
/// lands correctly in both wallets' actual balances. That covers the
/// happy path end-to-end, but it is still: (a) a handful of directed test
/// cases, not the fuzzing/invariant testing a real V4 hook audit expects
/// (Foundry-native, e.g. via v4-core's own `Fuzzers.sol`), and (b) run only
/// on Hardhat's local EVM, never against Robinhood Chain itself. Get a
/// Foundry-based fuzz/invariant suite and a professional audit before
/// pointing this at mainnet funds -- this is still the highest-risk contract
/// in this codebase, just no longer an untested one.
contract OnlyAssLaunchpadHook is IHooks, Ownable {
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Fixed, non-adjustable protocol fee taken on every swap, in the
    /// output currency. There is no setter for this -- "fixed" means fixed,
    /// even for the owner.
    uint256 public constant PLATFORM_FEE_BPS = 100; // 1%
    /// @notice Hard ceiling on a creator's own configurable trading tax, so a
    /// launch can never become a near-100%-tax honeypot. Creators can set
    /// anything from 0 up to this.
    uint256 public constant MAX_CREATOR_TAX_BPS = 1_000; // 10%

    IPoolManager public immutable poolManager;
    address public platformWallet;
    /// @notice Only this address may register new pools. Settable once by the
    /// owner (not immutable) purely to break the deploy-order circular
    /// dependency -- the launchpad's constructor needs this hook's address,
    /// so the hook can't know the launchpad's address until after the
    /// launchpad itself is deployed.
    address public launchpad;

    struct PoolFeeConfig {
        address creatorWallet;
        uint96 creatorTaxBps;
        bool registered;
        /// @dev Which side of this pool is $ONLYASS, pinned once at
        /// registration so the volume counter below can only ever measure
        /// the $ONLYASS leg of a swap. See afterSwap.
        bool onlyAssIsCurrency0;
    }

    mapping(PoolId => PoolFeeConfig) public poolConfig;
    /// @notice Cumulative volume of $ONLYASS traded through each pool, tracked
    /// purely as a milestone signal for the launchpad's graduation bonus (see
    /// OnlyAssLaunchpadV4.triggerGraduationBonus). This hook never moves ETH
    /// itself -- it only counts.
    mapping(PoolId => uint256) public cumulativeOnlyAssVolume;

    event LaunchpadSet(address indexed launchpad);
    event PlatformWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event PoolRegistered(PoolId indexed poolId, address indexed creatorWallet, uint256 creatorTaxBps);
    event FeeTaken(PoolId indexed poolId, uint256 platformFee, uint256 creatorFee);

    error ZeroAddress();
    error NotLaunchpad();
    error NotPoolManager();
    error LaunchpadAlreadySet();
    error CreatorTaxTooHigh();
    error PoolNotOnlyAss();
    error PoolAlreadyRegistered();
    error PoolNotRegistered();
    error HookNotImplemented();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert NotLaunchpad();
        _;
    }

    constructor(IPoolManager _poolManager, address _platformWallet, address initialOwner) Ownable(initialOwner) {
        if (address(_poolManager) == address(0) || _platformWallet == address(0)) revert ZeroAddress();
        poolManager = _poolManager;
        platformWallet = _platformWallet;

        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    /// @notice The exact set of hook callbacks this contract uses. Deploying
    /// to an address whose low bits don't match this exactly is rejected --
    /// see HookDeployer.sol / mine-hook-salt.js.
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: false,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice One-time wiring of the launchpad address, called by the owner
    /// right after the launchpad contract is deployed.
    function setLaunchpad(address newLaunchpad) external onlyOwner {
        if (newLaunchpad == address(0)) revert ZeroAddress();
        if (launchpad != address(0)) revert LaunchpadAlreadySet();
        launchpad = newLaunchpad;
        emit LaunchpadSet(newLaunchpad);
    }

    function setPlatformWallet(address newWallet) external onlyOwner {
        if (newWallet == address(0)) revert ZeroAddress();
        emit PlatformWalletUpdated(platformWallet, newWallet);
        platformWallet = newWallet;
    }

    /// @notice Called by the launchpad, atomically as part of launching a
    /// token, before the pool is initialized. Locks in the creator's chosen
    /// tax rate (capped) and where their cut of every future swap goes.
    /// @param onlyAssToken Address of $ONLYASS, so this can refuse to register
    /// a pool that doesn't actually pair against it -- this hook only ever
    /// exists to tax launchpad pools, all of which are TOKEN/$ONLYASS.
    function registerPool(PoolKey calldata key, address onlyAssToken, address creatorWallet, uint256 creatorTaxBps)
        external
        onlyLaunchpad
    {
        if (creatorWallet == address(0)) revert ZeroAddress();
        if (creatorTaxBps > MAX_CREATOR_TAX_BPS) revert CreatorTaxTooHigh();
        bool onlyAssIsCurrency0 = Currency.unwrap(key.currency0) == onlyAssToken;
        if (!onlyAssIsCurrency0 && Currency.unwrap(key.currency1) != onlyAssToken) {
            revert PoolNotOnlyAss();
        }

        PoolId id = key.toId();
        if (poolConfig[id].registered) revert PoolAlreadyRegistered();

        poolConfig[id] = PoolFeeConfig({
            creatorWallet: creatorWallet,
            creatorTaxBps: uint96(creatorTaxBps),
            registered: true,
            onlyAssIsCurrency0: onlyAssIsCurrency0
        });
        emit PoolRegistered(id, creatorWallet, creatorTaxBps);
    }

    /// @dev Fee-taking pattern matches Uniswap's own reference
    /// `src/test/FeeTakingHook.sol` almost exactly: the fee is taken from the
    /// swap's *unspecified* (output) currency, and `PoolManager.take()` sends
    /// it straight to its final recipient rather than to this contract --
    /// this hook never holds a balance of anything.
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        PoolFeeConfig memory cfg = poolConfig[id];
        if (!cfg.registered) revert PoolNotRegistered();

        bool specifiedTokenIs0 = (params.amountSpecified < 0 == params.zeroForOne);
        (Currency feeCurrency, int128 swapAmount) =
            specifiedTokenIs0 ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        if (swapAmount < 0) swapAmount = -swapAmount;

        uint256 outputAmount = uint128(swapAmount);
        uint256 platformFee = (outputAmount * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 creatorFee = (outputAmount * cfg.creatorTaxBps) / BPS_DENOMINATOR;

        if (platformFee > 0) poolManager.take(feeCurrency, platformWallet, platformFee);
        if (creatorFee > 0) poolManager.take(feeCurrency, cfg.creatorWallet, creatorFee);

        // Volume counter for the graduation-bonus milestone. It counts the
        // $ONLYASS leg of the swap specifically -- deliberately NOT the
        // larger of the two legs, which is what a "direction-agnostic" proxy
        // would do. The launched token's total supply is a number its own
        // creator picks out of thin air, so the token leg of a swap is
        // denominated in units that cost the creator nothing to create:
        // launch a token with an absurd supply and a swap moving a few cents
        // of real value registers astronomically on the token side, letting
        // the creator clear the graduation threshold and collect the bonus
        // without any real trading ever happening. The $ONLYASS side can't be
        // inflated that way -- reaching the threshold means actually pushing
        // that much $ONLYASS through the pool, which costs real money in
        // price impact and in this hook's own fee. Which side is $ONLYASS is
        // pinned at registerPool time, so it can't be spoofed per swap
        // either.
        int128 onlyAssLeg = cfg.onlyAssIsCurrency0 ? delta.amount0() : delta.amount1();
        cumulativeOnlyAssVolume[id] += onlyAssLeg < 0 ? uint256(uint128(-onlyAssLeg)) : uint256(uint128(onlyAssLeg));

        uint256 totalFee = platformFee + creatorFee;
        emit FeeTaken(id, platformFee, creatorFee);
        return (IHooks.afterSwap.selector, totalFee.toInt128());
    }

    // --- Unused IHooks callbacks: permission bits are all false for these,
    // so PoolManager will never actually call them. They exist only to
    // satisfy the interface. ---

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure override returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert HookNotImplemented();
    }
}
