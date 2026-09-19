// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title OnlyOnePayments
/// @notice Non-custodial paywall payments for the OnlyOne platform. A fan pays
/// ETH or the $ONLYONE token in one transaction; the contract splits it
/// atomically between the creator's wallet and the platform fee wallet. The contract never holds funds between
/// transactions — every payment is pushed straight to its destination in the
/// same call that receives it.
contract OnlyOnePayments is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Hard ceiling on the platform fee so the owner can never set an
    /// abusive rate. 3000 bps = 30%.
    uint256 public constant MAX_FEE_BPS = 3_000;

    /// @notice Wallet that receives the platform's cut of every purchase.
    address public platformWallet;
    /// @notice Current platform fee, in basis points (1000 = 10%).
    uint256 public platformFeeBps;
    /// @notice ERC-20 contract address for the $ONLYONE token.
    address public onlyOneToken;

    event Purchase(
        address indexed fan,
        address indexed creatorWallet,
        uint256 indexed creatorId,
        address token, // address(0) means paid in ETH
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 creatorAmount,
        uint256 contentId
    );

    event PlatformWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event PlatformFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event OnlyOneTokenUpdated(address indexed oldToken, address indexed newToken);
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh();
    error TransferFailed();

    /// @dev `initialOwner` is passed in rather than taken from `msg.sender`,
    /// matching OnlyOneCreatorNFT: the address that runs the deploy script is
    /// not necessarily the address that should end up owning the contract,
    /// and silently making the deployer the owner is how a live contract ends
    /// up owned by a hot key that was only ever meant to broadcast a
    /// transaction.
    ///
    /// Watch the ORDER when calling this: `initialOwner` and
    /// `initialPlatformWallet` are adjacent and both plain `address`, so
    /// passing them the wrong way round compiles, deploys and reverts
    /// nothing -- it just hands ownership to the fee wallet (or the fee
    /// stream to the owner key). setPlatformWallet/setPlatformFeeBps are both
    /// onlyOwner, so that mistake is unfixable once it is live. Every caller
    /// must pass four arguments, owner first; see
    /// test/OnlyOnePayments.test.js's "takes its owner from the constructor"
    /// case, which pins the order.
    constructor(
        address initialOwner,
        address initialPlatformWallet,
        uint256 initialFeeBps,
        address initialOnlyOneToken
    ) Ownable(initialOwner) {
        if (initialPlatformWallet == address(0)) revert ZeroAddress();
        if (initialOnlyOneToken == address(0)) revert ZeroAddress();
        if (initialFeeBps > MAX_FEE_BPS) revert FeeTooHigh();

        platformWallet = initialPlatformWallet;
        platformFeeBps = initialFeeBps;
        onlyOneToken = initialOnlyOneToken;
    }

    /// @notice Pay a creator in ETH to unlock `contentId`. Splits the payment
    /// between the creator and the platform fee wallet in the same transaction.
    /// @param creatorId Off-chain id of the creator being paid (for indexing).
    /// @param contentId Off-chain id of the content/tier being unlocked (0 = generic/subscription).
    /// @param creatorWallet The creator's payout wallet, as set in their profile.
    function payWithETH(uint256 creatorId, uint256 contentId, address payable creatorWallet)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        if (msg.value == 0) revert ZeroAmount();
        if (creatorWallet == address(0)) revert ZeroAddress();

        (uint256 feeAmount, uint256 creatorAmount) = _split(msg.value);

        if (feeAmount > 0) {
            (bool feeOk,) = platformWallet.call{value: feeAmount}("");
            if (!feeOk) revert TransferFailed();
        }
        (bool creatorOk,) = creatorWallet.call{value: creatorAmount}("");
        if (!creatorOk) revert TransferFailed();

        emit Purchase(msg.sender, creatorWallet, creatorId, address(0), msg.value, feeAmount, creatorAmount, contentId);
    }

    /// @notice Pay a creator in $ONLYONE to unlock `contentId`. Caller must have
    /// approved this contract for at least `amount` beforehand.
    function payWithOnlyOne(uint256 creatorId, uint256 contentId, address creatorWallet, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        if (creatorWallet == address(0)) revert ZeroAddress();

        IERC20 token = IERC20(onlyOneToken);
        (uint256 feeAmount, uint256 creatorAmount) = _split(amount);

        if (feeAmount > 0) {
            token.safeTransferFrom(msg.sender, platformWallet, feeAmount);
        }
        token.safeTransferFrom(msg.sender, creatorWallet, creatorAmount);

        emit Purchase(msg.sender, creatorWallet, creatorId, onlyOneToken, amount, feeAmount, creatorAmount, contentId);
    }

    function _split(uint256 grossAmount) internal view returns (uint256 feeAmount, uint256 creatorAmount) {
        feeAmount = (grossAmount * platformFeeBps) / BPS_DENOMINATOR;
        creatorAmount = grossAmount - feeAmount;
    }

    // --- Admin controls ---

    function setPlatformWallet(address newWallet) external onlyOwner {
        if (newWallet == address(0)) revert ZeroAddress();
        emit PlatformWalletUpdated(platformWallet, newWallet);
        platformWallet = newWallet;
    }

    function setPlatformFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit PlatformFeeUpdated(platformFeeBps, newFeeBps);
        platformFeeBps = newFeeBps;
    }

    function setOnlyOneToken(address newToken) external onlyOwner {
        if (newToken == address(0)) revert ZeroAddress();
        emit OnlyOneTokenUpdated(onlyOneToken, newToken);
        onlyOneToken = newToken;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover ERC-20 tokens sent to this contract by mistake (this
    /// contract never intentionally holds a balance between transactions).
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit ERC20Rescued(token, to, amount);
    }
}
