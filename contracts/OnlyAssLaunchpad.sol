// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {LaunchedToken} from "./LaunchedToken.sol";
import {IUniswapV2Factory} from "./interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2Router02.sol";

/// @title OnlyAssLaunchpad
/// @notice Self-serve token launchpad: a creator pays a flat ETH fee, deploys a
/// brand-new fixed-supply ERC20, and the launchpad seeds its Uniswap V2 pool
/// paired against $ONLYASS (never ETH/WETH) in the same transaction. The LP
/// position is held in escrow by this contract and locked for LOCK_DURATION,
/// after which only the launching creator can withdraw it.
contract OnlyAssLaunchpad is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Hard ceiling on the platform's supply cut, so the owner can never
    /// set an abusive rate even if the owner key were compromised.
    uint256 public constant MAX_PLATFORM_SUPPLY_BPS = 2_000; // 20%
    /// @notice A launch must commit at least this fraction of its supply to the
    /// $ONLYASS pool, so a creator can't take ~100% of supply and seed the pool
    /// with dust.
    uint256 public constant MIN_LIQUIDITY_BPS = 5_000; // 50%
    /// @notice LP tokens are held in escrow by this contract for this long
    /// after launch, immutable regardless of any later admin action.
    uint256 public constant LOCK_DURATION = 180 days;

    /// @notice The $ONLYASS token every launch is paired against.
    address public immutable onlyAssToken;
    IUniswapV2Factory public immutable uniswapFactory;
    IUniswapV2Router02 public immutable uniswapRouter;

    address public platformWallet;
    uint256 public launchFeeWei = 0.01 ether;
    uint256 public platformSupplyBps = 1_000; // 10%

    struct Launch {
        address token;
        address creator;
        address pair;
        uint256 lpAmount;
        uint256 unlockTime;
        bool withdrawn;
    }

    struct LaunchParams {
        string name;
        string symbol;
        uint256 totalSupply;
        uint256 tokenLiquidityBps;
        uint256 onlyAssForLiquidity;
        uint256 minTokenLiquidity;
        uint256 minOnlyAssLiquidity;
    }

    Launch[] public launches;
    mapping(address => uint256[]) public launchesByCreator;
    /// @notice Pair tokens created by this contract can never be pulled out via
    /// rescueERC20 -- closes off the one path a compromised owner key could use
    /// to steal a creator's still-locked liquidity.
    mapping(address => bool) public isTrackedPair;

    event TokenLaunched(
        uint256 indexed launchId,
        address indexed creator,
        address indexed token,
        address pair,
        uint256 totalSupply,
        uint256 platformSupplyCut,
        uint256 tokensToLiquidity,
        uint256 onlyAssToLiquidity,
        uint256 lpAmount,
        uint256 unlockTime
    );
    event LiquidityWithdrawn(uint256 indexed launchId, address indexed creator, address pair, uint256 lpAmount);
    event PlatformWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event LaunchFeeUpdated(uint256 oldFeeWei, uint256 newFeeWei);
    event PlatformSupplyBpsUpdated(uint256 oldBps, uint256 newBps);
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
    error CannotRescueTrackedPair();
    error TransferFailed();

    constructor(
        address initialOwner,
        address initialPlatformWallet,
        address _onlyAssToken,
        address _uniswapFactory,
        address _uniswapRouter
    ) Ownable(initialOwner) {
        if (
            initialPlatformWallet == address(0) || _onlyAssToken == address(0) || _uniswapFactory == address(0)
                || _uniswapRouter == address(0)
        ) revert ZeroAddress();
        platformWallet = initialPlatformWallet;
        onlyAssToken = _onlyAssToken;
        uniswapFactory = IUniswapV2Factory(_uniswapFactory);
        uniswapRouter = IUniswapV2Router02(_uniswapRouter);
    }

    /// @notice Deploy a new token and seed its TOKEN/$ONLYASS pool in one call.
    /// Caller must have approved this contract for at least
    /// `p.onlyAssForLiquidity` of $ONLYASS beforehand. Params are passed as a
    /// struct (rather than individually) purely to keep this function's stack
    /// shallow enough for the compiler.
    /// @param p.totalSupply Fixed total supply of the new token (18 decimals).
    /// @param p.tokenLiquidityBps Share of totalSupply (in bps) committed to
    /// the pool; must be between MIN_LIQUIDITY_BPS and (10000 - platformSupplyBps).
    /// The rest, after the platform's cut, goes straight to the creator.
    /// @param p.onlyAssForLiquidity Amount of $ONLYASS the creator is pairing in.
    /// @param p.minTokenLiquidity / p.minOnlyAssLiquidity Slippage floors passed
    /// to Uniswap's addLiquidity (matters if this token's pair somehow already
    /// has reserves; harmless on a genuinely fresh pool).
    function launchToken(LaunchParams calldata p) external payable nonReentrant whenNotPaused returns (uint256 launchId) {
        if (msg.value < launchFeeWei) revert InsufficientFee();
        if (p.totalSupply == 0 || p.onlyAssForLiquidity == 0) revert ZeroAmount();
        if (p.tokenLiquidityBps < MIN_LIQUIDITY_BPS || p.tokenLiquidityBps > BPS_DENOMINATOR - platformSupplyBps) {
            revert LiquidityBpsOutOfRange();
        }

        Launch memory l = _deployAndSeed(p);

        (bool feeOk,) = platformWallet.call{value: msg.value}("");
        if (!feeOk) revert TransferFailed();

        launchId = launches.length;
        launches.push(l);
        launchesByCreator[msg.sender].push(launchId);

        emit TokenLaunched(
            launchId, l.creator, l.token, l.pair, p.totalSupply,
            (p.totalSupply * platformSupplyBps) / BPS_DENOMINATOR,
            (p.totalSupply * p.tokenLiquidityBps) / BPS_DENOMINATOR,
            p.onlyAssForLiquidity, l.lpAmount, l.unlockTime
        );
    }

    /// @dev Split out of launchToken purely to keep that function's stack
    /// shallow enough to compile -- no behavioral difference from having it
    /// inline. Deploys the token, distributes supply, creates the pair, and
    /// seeds liquidity.
    function _deployAndSeed(LaunchParams calldata p) private returns (Launch memory) {
        IERC20(onlyAssToken).safeTransferFrom(msg.sender, address(this), p.onlyAssForLiquidity);

        LaunchedToken token = new LaunchedToken(p.name, p.symbol, p.totalSupply, address(this));
        IERC20 tokenErc20 = IERC20(address(token));

        uint256 platformCut = (p.totalSupply * platformSupplyBps) / BPS_DENOMINATOR;
        uint256 liquidityTokens = (p.totalSupply * p.tokenLiquidityBps) / BPS_DENOMINATOR;
        uint256 creatorCut = p.totalSupply - platformCut - liquidityTokens;

        if (platformCut > 0) tokenErc20.safeTransfer(platformWallet, platformCut);
        if (creatorCut > 0) tokenErc20.safeTransfer(msg.sender, creatorCut);

        // token was just deployed above, so its pair can never already exist.
        address pair = uniswapFactory.createPair(address(token), onlyAssToken);
        isTrackedPair[pair] = true;

        tokenErc20.forceApprove(address(uniswapRouter), liquidityTokens);
        IERC20(onlyAssToken).forceApprove(address(uniswapRouter), p.onlyAssForLiquidity);

        (,, uint256 lpAmount) = uniswapRouter.addLiquidity(
            address(token), onlyAssToken, liquidityTokens, p.onlyAssForLiquidity,
            p.minTokenLiquidity, p.minOnlyAssLiquidity, address(this), block.timestamp + 900
        );

        return Launch({
            token: address(token),
            creator: msg.sender,
            pair: pair,
            lpAmount: lpAmount,
            unlockTime: block.timestamp + LOCK_DURATION,
            withdrawn: false
        });
    }

    /// @notice Once LOCK_DURATION has passed, the launching creator can pull
    /// their LP position out of escrow. No one else can, ever -- not even the
    /// platform owner (see rescueERC20).
    function withdrawLiquidity(uint256 launchId) external nonReentrant {
        if (launchId >= launches.length) revert InvalidLaunchId();
        Launch storage l = launches[launchId];
        if (msg.sender != l.creator) revert NotLaunchCreator();
        if (block.timestamp < l.unlockTime) revert StillLocked();
        if (l.withdrawn) revert AlreadyWithdrawn();

        l.withdrawn = true;
        IERC20(l.pair).safeTransfer(l.creator, l.lpAmount);

        emit LiquidityWithdrawn(launchId, l.creator, l.pair, l.lpAmount);
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

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover ERC-20 tokens sent to this contract by mistake. Can
    /// never touch a tracked LP pair token -- that would let a compromised
    /// owner key steal creators' still-locked liquidity.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (isTrackedPair[token]) revert CannotRescueTrackedPair();
        IERC20(token).safeTransfer(to, amount);
        emit ERC20Rescued(token, to, amount);
    }
}
