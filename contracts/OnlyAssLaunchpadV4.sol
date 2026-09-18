// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {LaunchedToken} from "./LaunchedToken.sol";
import {IOnlyAssLaunchpadHook} from "./interfaces/IOnlyAssLaunchpadHook.sol";
import {OnlyAssSqrtPriceMath} from "./libraries/OnlyAssSqrtPriceMath.sol";

/// @title OnlyAssLaunchpadV4
/// @notice Uniswap V4 rebuild of the creator token launchpad: a creator pays a
/// flat ETH fee, deploys a brand-new fixed-supply ERC20, and this contract
/// atomically initializes its V4 pool against $ONLYASS (never ETH/WETH) and
/// seeds it with full-range liquidity via the canonical `PositionManager`,
/// all in the same transaction -- no separate, non-atomic "seed it later"
/// step, so there is never a window where the token exists but the pool
/// doesn't. The resulting LP position (an ERC-721 from PositionManager, not
/// an ERC-20 like V2's pairs) is held in escrow by this contract for
/// LOCK_DURATION, after which only the launching creator can claim it.
///
/// Every launch also gets its own row in `OnlyAssLaunchpadHook`: a fixed,
/// non-adjustable 1% platform fee plus the creator's own (capped) trading tax
/// is taken out of every swap on their pool automatically -- see that
/// contract's own header for how.
///
/// @dev `poolManager` / `positionManager` / `permit2` are constructor-injected
/// addresses, exactly like V2's `uniswapFactory`/`uniswapRouter` -- this
/// contract deploys none of Uniswap's own infrastructure and trusts nothing
/// about those addresses beyond what's passed in. Per this repo's existing
/// methodology (see contracts/ONLYASS_LAUNCH.md), verify them yourself via a
/// real wallet's transaction preview on Robinhood Chain before deploying --
/// do not take them from a doc page or a "verified address list" site.
///
/// SECURITY NOTE: same disclosure as OnlyAssLaunchpadHook.sol -- this was
/// written against the real `uniswap/v4-core` / `uniswap/v4-periphery`
/// interfaces, and `test/OnlyAssLaunchpadV4.integration.test.js` exercises
/// the full path end-to-end against a real, locally-compiled
/// PoolManager/PositionManager/Permit2 (deploy token, init pool, seed
/// full-range liquidity via PositionManager, swap through PoolSwapTest,
/// withdraw the escrowed LP position after LOCK_DURATION, pay the graduation
/// bonus) -- this is not mocked out. It is still a handful of directed
/// happy-path/revert-path cases on Hardhat's local EVM, not Foundry-based
/// fuzzing/invariant testing, and never against Robinhood Chain itself.
/// Needs a Foundry-based fuzz/invariant suite and a professional audit before
/// mainnet use.
contract OnlyAssLaunchpadV4 is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;
    using StateLibrary for IPoolManager;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_PLATFORM_SUPPLY_BPS = 2_000; // 20%
    uint256 public constant MIN_LIQUIDITY_BPS = 5_000; // 50%
    uint256 public constant LOCK_DURATION = 180 days;
    /// @dev Same tick spacing pools.trade's own V4 graduations use per
    /// contracts/ONLYASS_LAUNCH.md's research; full-range liquidity either
    /// way, so this only affects price granularity, not what a creator/LP
    /// can express.
    int24 public constant TICK_SPACING = 60;
    /// @dev Native V4 pool fee is always 0 -- 100% of the trading fee is
    /// taken by the hook (platform's fixed cut + creator's tax) instead of a
    /// pool-native LP fee, so there's exactly one fee mechanism to reason
    /// about, not two.
    uint24 public constant POOL_FEE = 0;
    /// @dev How long PositionManager's Permit2 allowance for a freshly
    /// launched pair stays valid. One-shot use immediately after granting it,
    /// so this only needs to outlive the current transaction.
    uint48 public constant PERMIT2_EXPIRATION_BUFFER = 900;
    /// @notice How many candidate token addresses a single launch will try
    /// before giving up. See _deployTokenForFreshPool for why more than one
    /// is needed, and why this is 16x the V2 launchpad's own 8: squatting a
    /// candidate costs an attacker one cheap `PoolManager.initialize` here,
    /// versus a whole pair-contract deployment on V2, so the candidate set
    /// has to be correspondingly wider to keep the grief uneconomical. Costs
    /// nothing on the happy path -- an unsquatted launch still returns on
    /// attempt 0.
    uint256 public constant MAX_ADDRESS_ATTEMPTS = 128;

    address public immutable onlyAssToken;
    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    IOnlyAssLaunchpadHook public immutable hook;

    address public platformWallet;
    uint256 public launchFeeWei = 0.01 ether;
    uint256 public platformSupplyBps = 1_000; // 10%

    /// @notice Cumulative-$ONLYASS-volume milestone (read from the hook) that
    /// unlocks a launch's one-time graduation bonus. A business knob, not a
    /// protocol constant -- same as launchFeeWei/platformSupplyBps.
    uint256 public graduationOnlyAssVolumeThreshold = 500_000 ether;
    uint256 public graduationCreatorBonusWei = 0.5 ether;
    uint256 public graduationPlatformBonusWei = 0.5 ether;

    struct Launch {
        address token;
        address creator;
        PoolId poolId;
        uint256 positionTokenId;
        uint256 unlockTime;
        bool liquidityWithdrawn;
        bool graduationPaid;
    }

    Launch[] public launches;
    mapping(address => uint256[]) public launchesByCreator;

    event TokenLaunched(
        uint256 indexed launchId,
        address indexed creator,
        address indexed token,
        PoolId poolId,
        uint256 totalSupply,
        uint256 platformSupplyCut,
        uint256 tokensToLiquidity,
        uint256 onlyAssToLiquidity,
        uint256 creatorTaxBps,
        uint256 positionTokenId,
        uint256 unlockTime
    );
    event LiquidityPositionWithdrawn(uint256 indexed launchId, address indexed creator, uint256 positionTokenId);
    event GraduationBonusPaid(uint256 indexed launchId, address indexed creator, uint256 creatorBonusWei, uint256 platformBonusWei);
    event PlatformWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event LaunchFeeUpdated(uint256 oldFeeWei, uint256 newFeeWei);
    event PlatformSupplyBpsUpdated(uint256 oldBps, uint256 newBps);
    event GraduationParamsUpdated(uint256 onlyAssVolumeThreshold, uint256 creatorBonusWei, uint256 platformBonusWei);
    event GraduationPoolFunded(address indexed from, uint256 amount);
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientFee();
    error SupplyBpsTooHigh();
    error LiquidityBpsOutOfRange();
    error InvalidLaunchId();
    error NotLaunchCreator();
    error StillLocked();
    error AlreadyWithdrawn();
    error TransferFailed();
    error GraduationAlreadyPaid();
    error GraduationThresholdNotMet();
    error GraduationPoolUnderfunded();
    error NoAvailableTokenAddress();
    error PoolInitializationFailed();
    error CannotRescueProtectedToken();

    struct LaunchParams {
        string name;
        string symbol;
        uint256 totalSupply;
        uint256 tokenLiquidityBps;
        uint256 onlyAssForLiquidity;
        uint256 creatorTaxBps;
    }

    constructor(
        address initialOwner,
        address initialPlatformWallet,
        address _onlyAssToken,
        IPoolManager _poolManager,
        IPositionManager _positionManager,
        IAllowanceTransfer _permit2,
        IOnlyAssLaunchpadHook _hook
    ) Ownable(initialOwner) {
        if (
            initialPlatformWallet == address(0) || _onlyAssToken == address(0) || address(_poolManager) == address(0)
                || address(_positionManager) == address(0) || address(_permit2) == address(0) || address(_hook) == address(0)
        ) revert ZeroAddress();
        platformWallet = initialPlatformWallet;
        onlyAssToken = _onlyAssToken;
        poolManager = _poolManager;
        positionManager = _positionManager;
        permit2 = _permit2;
        hook = _hook;
    }

    /// @notice Deploy a new token and atomically create + seed its
    /// TOKEN/$ONLYASS V4 pool in one call. Caller must have approved this
    /// contract for at least `p.onlyAssForLiquidity` of $ONLYASS beforehand.
    function launchToken(LaunchParams calldata p) external payable nonReentrant whenNotPaused returns (uint256 launchId) {
        if (msg.value < launchFeeWei) revert InsufficientFee();
        if (p.totalSupply == 0 || p.onlyAssForLiquidity == 0) revert ZeroAmount();
        if (p.tokenLiquidityBps < MIN_LIQUIDITY_BPS || p.tokenLiquidityBps > BPS_DENOMINATOR - platformSupplyBps) {
            revert LiquidityBpsOutOfRange();
        }

        (bool feeOk,) = platformWallet.call{value: msg.value}("");
        if (!feeOk) revert TransferFailed();

        Launch memory l = _deployAndSeed(p);

        launchId = launches.length;
        launches.push(l);
        launchesByCreator[msg.sender].push(launchId);

        emit TokenLaunched(
            launchId, l.creator, l.token, l.poolId, p.totalSupply,
            (p.totalSupply * platformSupplyBps) / BPS_DENOMINATOR,
            (p.totalSupply * p.tokenLiquidityBps) / BPS_DENOMINATOR,
            p.onlyAssForLiquidity, p.creatorTaxBps, l.positionTokenId, l.unlockTime
        );
    }

    /// @dev Split out of launchToken purely to keep stack depth manageable
    /// (same rationale as V2's own `_deployAndSeed` split).
    function _deployAndSeed(LaunchParams calldata p) private returns (Launch memory) {
        IERC20(onlyAssToken).safeTransferFrom(msg.sender, address(this), p.onlyAssForLiquidity);

        uint256 platformCut = (p.totalSupply * platformSupplyBps) / BPS_DENOMINATOR;
        uint256 liquidityTokens = (p.totalSupply * p.tokenLiquidityBps) / BPS_DENOMINATOR;
        uint256 creatorCut = p.totalSupply - platformCut - liquidityTokens;

        (address token, PoolKey memory key, uint256 amount0, uint256 amount1) =
            _deployTokenForFreshPool(p, liquidityTokens);
        IERC20 tokenErc20 = IERC20(token);

        if (platformCut > 0) tokenErc20.safeTransfer(platformWallet, platformCut);
        if (creatorCut > 0) tokenErc20.safeTransfer(msg.sender, creatorCut);

        hook.registerPool(key, onlyAssToken, msg.sender, p.creatorTaxBps);

        uint256 tokenId = _seedLiquidity(key, amount0, amount1);

        return Launch({
            token: token,
            creator: msg.sender,
            poolId: key.toId(),
            positionTokenId: tokenId,
            unlockTime: block.timestamp + LOCK_DURATION,
            liquidityWithdrawn: false,
            graduationPaid: false
        });
    }

    /// @dev Deploys this launch's ERC20 at an address nobody could have
    /// computed before this transaction, and never at one whose V4 pool has
    /// already been initialized by somebody else. Returns the token plus the
    /// PoolKey/amounts derived from it, since the key depends on the address
    /// this picks.
    ///
    /// Why this is not just `new LaunchedToken(...)`: a plain CREATE puts the
    /// token at an address derived solely from (this contract, this
    /// contract's nonce), which anyone can compute in advance. A V4 pool's
    /// identity is just the hash of its PoolKey, and `PoolManager.initialize`
    /// is permissionless (this hook declares no beforeInitialize permission,
    /// so nothing gates it) -- so an attacker could initialize the next
    /// launch's pool themselves, at a price of their own choosing, for the
    /// price of one cheap transaction. What happens then is worse than a
    /// plain failure, because `PositionManager.initializePool` SWALLOWS the
    /// "already initialized" error (see _seedLiquidity): the launch would
    /// either seed its entire liquidity against the attacker's price, or
    /// revert on the resulting slippage. A reverted launch never increments
    /// this contract's nonce, so the *next* launch would deploy to the same
    /// squatted address and hit the same pool -- the launchpad would be
    /// bricked permanently, for every creator, with no way to recover it.
    ///
    /// Two independent defenses, either of which alone closes the permanent
    /// brick: (1) CREATE2 with a salt mixing in `block.prevrandao` and the
    /// previous blockhash, so the address can't be known before the block
    /// this launch actually lands in -- whatever an attacker squats is stale
    /// again in the next block; and (2) a bounded retry, so a pool that IS
    /// already initialized is skipped rather than fatal. Do not "simplify"
    /// this back to `new LaunchedToken(...)`.
    ///
    /// `block.number`/`block.timestamp` are in the salt as well, not because
    /// they're unpredictable (they aren't) but because they're guaranteed to
    /// differ from one block to the next on any chain. This repo has never
    /// verified what Robinhood Chain's EVM actually returns for prevrandao or
    /// blockhash; if both turned out to be constants there, those two alone
    /// still keep every block's candidate addresses different, which is the
    /// property that makes "permanently bricked" impossible.
    ///
    /// WHAT THIS DOES NOT CLOSE, and the reason MAX_ADDRESS_ATTEMPTS is much
    /// larger here than on the V2 launchpad: none of the salt inputs are
    /// secret from a transaction earlier in the SAME block. `msg.sender` and
    /// `creationCodeHash` are both recoverable from the victim's own pending
    /// calldata, `launches.length` is public via launchCount(), the block
    /// fields are shared by every transaction in the block, and `attempt`
    /// just enumerates MAX_ADDRESS_ATTEMPTS. So a searcher watching the
    /// mempool can compute every candidate, initialize each of their pools
    /// first, and force this launch to revert with NoAvailableTokenAddress --
    /// a live, repeatable, same-block grief, not a theoretical one.
    ///
    /// Do NOT copy V2's cost framing onto this: there, squatting one
    /// candidate means `UniswapV2Factory.createPair`, which deploys a whole
    /// pair contract (~2.5M gas), so squatting the full set is close to
    /// infeasible. Here it is one `PoolManager.initialize` per candidate
    /// (~35k gas -- no contract is deployed, and this hook declares no
    /// beforeInitialize permission, so there isn't even a hook callback to
    /// pay for). The two are roughly two orders of magnitude apart.
    ///
    /// A wider candidate set is deliberate cost-scaling, not a cure. The
    /// attacker has to squat EVERY candidate to stop one launch, pay for all
    /// of them again in every block they want to keep the launchpad down, and
    /// win the ordering race each time; skipping a squatted candidate costs
    /// this loop only an EXTCODESIZE plus one extsload, roughly a sixth of
    /// what the squat cost. The actual cure is to make initializing a pool
    /// that carries this hook permissioned -- give the hook a
    /// `beforeInitialize` permission that accepts only a PoolKey the
    /// launchpad has already passed to registerPool, which an attacker can't
    /// reach (onlyLaunchpad). That is not a contract-local change: a V4
    /// hook's permissions live in the low bits of its own ADDRESS, so turning
    /// that bit on changes the salt the hook must be mined at, and
    /// scripts/lib/hook-miner.js pins the flag set to
    /// AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA. It needs the hook, the miner,
    /// the V4 deploy script and the V4 tests moved together. Tracked as the
    /// outstanding fix here; until it lands, this is cost-scaling only.
    function _deployTokenForFreshPool(LaunchParams calldata p, uint256 liquidityTokens)
        private
        returns (address token, PoolKey memory key, uint256 amount0, uint256 amount1)
    {
        bytes memory creationCode =
            abi.encodePacked(type(LaunchedToken).creationCode, abi.encode(p.name, p.symbol, p.totalSupply, address(this)));
        bytes32 creationCodeHash = keccak256(creationCode);

        for (uint256 attempt = 0; attempt < MAX_ADDRESS_ATTEMPTS; attempt++) {
            bytes32 salt = keccak256(
                abi.encode(
                    msg.sender,
                    launches.length,
                    attempt,
                    block.prevrandao,
                    blockhash(block.number - 1),
                    block.number,
                    block.timestamp,
                    creationCodeHash
                )
            );
            address predicted = Create2.computeAddress(salt, creationCodeHash);
            if (predicted.code.length != 0) continue;

            (key, amount0, amount1) = _buildPoolKey(predicted, liquidityTokens, p.onlyAssForLiquidity);
            (uint160 existingSqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
            if (existingSqrtPriceX96 != 0) continue;

            return (Create2.deploy(0, salt, creationCode), key, amount0, amount1);
        }
        revert NoAvailableTokenAddress();
    }

    function _buildPoolKey(address token, uint256 tokenAmount, uint256 onlyAssAmount)
        private
        view
        returns (PoolKey memory key, uint256 amount0, uint256 amount1)
    {
        (Currency currency0, Currency currency1, uint256 amt0, uint256 amt1) =
            token < onlyAssToken
                ? (Currency.wrap(token), Currency.wrap(onlyAssToken), tokenAmount, onlyAssAmount)
                : (Currency.wrap(onlyAssToken), Currency.wrap(token), onlyAssAmount, tokenAmount);

        key = PoolKey({currency0: currency0, currency1: currency1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: IHooks(address(hook))});
        amount0 = amt0;
        amount1 = amt1;
    }

    /// @dev Initializes the pool, grants PositionManager a one-shot Permit2
    /// allowance for both currencies, and mints a full-range position holding
    /// exactly (amount0, amount1) -- atomically, as part of the same
    /// `launchToken` transaction. Returns the minted position's ERC-721
    /// tokenId, which this contract holds in escrow (see withdrawLiquidity).
    function _seedLiquidity(PoolKey memory key, uint256 amount0, uint256 amount1) private returns (uint256 tokenId) {
        uint160 sqrtPriceX96 = OnlyAssSqrtPriceMath.toSqrtPriceX96(amount0, amount1);
        // PositionManager.initializePool swallows a failed
        // PoolManager.initialize and just returns type(int24).max instead of
        // reverting -- that is documented upstream behavior
        // (IPoolInitializer_v4), meant for a multicall that doesn't care
        // whether the pool already existed. Here it matters enormously:
        // continuing past a swallowed failure seeds this launch's entire
        // liquidity into a pool whose starting price was never the one
        // computed and validated above (either nobody set it, or somebody
        // else did). Treat the sentinel as fatal rather than silently
        // trusting whatever price is actually in the pool. No real pool can
        // report this tick -- V4's own max usable tick is ~887272 -- so this
        // can't false-positive on a legitimate initialization.
        int24 initTick = positionManager.initializePool(key, sqrtPriceX96);
        if (initTick == type(int24).max) revert PoolInitializationFailed();

        address token0 = Currency.unwrap(key.currency0);
        address token1 = Currency.unwrap(key.currency1);
        uint48 expiration = uint48(block.timestamp + PERMIT2_EXPIRATION_BUFFER);
        IERC20(token0).forceApprove(address(permit2), amount0);
        IERC20(token1).forceApprove(address(permit2), amount1);
        permit2.approve(token0, address(positionManager), amount0.toUint160(), expiration);
        permit2.approve(token1, address(positionManager), amount1.toUint160(), expiration);

        int24 tickLower = TickMath.minUsableTick(key.tickSpacing);
        int24 tickUpper = TickMath.maxUsableTick(key.tickSpacing);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), amount0, amount1
        );

        tokenId = positionManager.nextTokenId();

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] =
            abi.encode(key, tickLower, tickUpper, uint256(liquidity), amount0.toUint128(), amount1.toUint128(), address(this), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + PERMIT2_EXPIRATION_BUFFER);
    }

    /// @notice Once LOCK_DURATION has passed, the launching creator can claim
    /// their LP position NFT out of escrow. No one else can, ever -- not even
    /// the platform owner.
    function withdrawLiquidity(uint256 launchId) external nonReentrant {
        if (launchId >= launches.length) revert InvalidLaunchId();
        Launch storage l = launches[launchId];
        if (msg.sender != l.creator) revert NotLaunchCreator();
        if (block.timestamp < l.unlockTime) revert StillLocked();
        if (l.liquidityWithdrawn) revert AlreadyWithdrawn();

        l.liquidityWithdrawn = true;
        IERC721(address(positionManager)).transferFrom(address(this), l.creator, l.positionTokenId);

        emit LiquidityPositionWithdrawn(launchId, l.creator, l.positionTokenId);
    }

    /// @notice Permissionless: once a launch's pool has traded at least
    /// `graduationOnlyAssVolumeThreshold` of cumulative $ONLYASS volume (per
    /// the hook's own counter), pays the creator and platform their one-time
    /// bonus out of this contract's own ETH balance. This is NOT funded
    /// automatically by trading fees -- see fundGraduationPool -- it's a
    /// separate, explicitly pre-funded reserve so the highest-risk contract
    /// (the hook) never needs to custody or move ETH itself.
    function triggerGraduationBonus(uint256 launchId) external nonReentrant {
        if (launchId >= launches.length) revert InvalidLaunchId();
        Launch storage l = launches[launchId];
        if (l.graduationPaid) revert GraduationAlreadyPaid();
        if (hook.cumulativeOnlyAssVolume(l.poolId) < graduationOnlyAssVolumeThreshold) revert GraduationThresholdNotMet();

        uint256 creatorBonus = graduationCreatorBonusWei;
        uint256 platformBonus = graduationPlatformBonusWei;
        if (address(this).balance < creatorBonus + platformBonus) revert GraduationPoolUnderfunded();

        l.graduationPaid = true;

        (bool creatorOk,) = l.creator.call{value: creatorBonus}("");
        if (!creatorOk) revert TransferFailed();
        (bool platformOk,) = platformWallet.call{value: platformBonus}("");
        if (!platformOk) revert TransferFailed();

        emit GraduationBonusPaid(launchId, l.creator, creatorBonus, platformBonus);
    }

    /// @notice Tops up the shared graduation-bonus reserve. Open to anyone --
    /// funding a bonus pool other people's launches draw from isn't
    /// sensitive, same as tipping.
    function fundGraduationPool() external payable {
        emit GraduationPoolFunded(msg.sender, msg.value);
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    function launchesOf(address creator) external view returns (uint256[] memory) {
        return launchesByCreator[creator];
    }

    // --- Admin controls ---

    function setPlatformWallet(address newWallet) external onlyOwner {
        if (newWallet == address(0)) revert ZeroAddress();
        emit PlatformWalletUpdated(platformWallet, newWallet);
        platformWallet = newWallet;
    }

    function setLaunchFeeWei(uint256 newFeeWei) external onlyOwner {
        emit LaunchFeeUpdated(launchFeeWei, newFeeWei);
        launchFeeWei = newFeeWei;
    }

    function setPlatformSupplyBps(uint256 newBps) external onlyOwner {
        if (newBps > MAX_PLATFORM_SUPPLY_BPS) revert SupplyBpsTooHigh();
        emit PlatformSupplyBpsUpdated(platformSupplyBps, newBps);
        platformSupplyBps = newBps;
    }

    /// @notice Sets the graduation milestone and its two bonus amounts.
    /// @dev Size these against what the volume actually COSTS to produce, not
    /// against its face value. The hook's counter measures throughput in both
    /// directions with POOL_FEE at 0, and the creator-tax half of the hook's
    /// fee is paid back to the same creator who collects the bonus, so a
    /// creator can manufacture the threshold by round-tripping their own
    /// capital for roughly 1% of it -- see the long comment in
    /// OnlyAssLaunchpadHook.afterSwap. If creatorBonusWei is worth more than
    /// ~1% of onlyAssVolumeThreshold, wash-trading the milestone is
    /// profitable and drains the shared reserve fundGraduationPool fills.
    function setGraduationParams(uint256 onlyAssVolumeThreshold, uint256 creatorBonusWei, uint256 platformBonusWei)
        external
        onlyOwner
    {
        graduationOnlyAssVolumeThreshold = onlyAssVolumeThreshold;
        graduationCreatorBonusWei = creatorBonusWei;
        graduationPlatformBonusWei = platformBonusWei;
        emit GraduationParamsUpdated(onlyAssVolumeThreshold, creatorBonusWei, platformBonusWei);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover ERC-20 tokens sent to this contract by mistake.
    /// Cannot touch $ONLYASS or the position-manager's own ERC-721 escrow --
    /// there is no ERC-20 rescue path for the locked LP NFTs at all.
    /// @dev Both exclusions are enforced here, not merely documented.
    /// $ONLYASS is what every launch pairs its liquidity against and what
    /// this contract pulls from the creator mid-launch, so an unrestricted
    /// rescue is exactly the path a compromised owner key would use to take
    /// someone else's pairing capital -- the same reason V2's own rescueERC20
    /// refuses to touch a tracked LP pair. The cost is that $ONLYASS genuinely
    /// sent here by mistake (or seeding dust left behind by rounding) is
    /// stuck forever: deliberate, since nothing on-chain can tell that apart
    /// from a launch's own funds.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token == onlyAssToken || token == address(positionManager)) revert CannotRescueProtectedToken();
        IERC20(token).safeTransfer(to, amount);
        emit ERC20Rescued(token, to, amount);
    }
}
