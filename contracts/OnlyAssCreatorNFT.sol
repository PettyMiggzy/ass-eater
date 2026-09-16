// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IOnlyAssLaunchpadV4Views} from "./OnlyAssPayments.sol";

/// @title OnlyAssCreatorNFT
/// @notice Self-serve NFT drops: a creator picks an image, how many copies to
/// mint, what to charge, and what to charge it in (ETH, $ONLYASS, or a token
/// they themselves launched through OnlyAssLaunchpadV4). A fan mints straight
/// from the drop; the mint and the payment split happen atomically in the
/// same transaction -- there is no separate "buy then wait for a mint" step
/// and no off-chain relayer with a privileged mint key.
///
/// @dev Each drop is one ERC-1155 token id, `editionSize` copies of it. A
/// 1-of-1 ("true" unique NFT) is just `editionSize == 1`; a limited-edition
/// print run is any larger number -- same mechanism either way.
///
/// IMPORTANT, non-code decision this contract's design depends on:
/// `metadataURI` should point at a URL the platform itself controls (its own
/// API/CDN), never raw immutable storage (IPFS, Arweave, on-chain SVG/bytes).
/// Two reasons: (1) the *image* needs to stay blurred/hidden until the
/// viewer's wallet actually holds a copy (checked via this contract's own
/// `balanceOf`) -- that gating has to happen at request time, server-side,
/// which a static immutable file can't do; (2) if content ever needs to come
/// down (a creator's own request, a legal/consent issue, anything), that's
/// only possible if the platform actually controls where the bytes live.
/// This contract cannot enforce that at the Solidity level -- `metadataURI`
/// is just a string -- so it's a hard requirement on whatever UI calls
/// `createDrop`, not something this code can guarantee by itself. Read this
/// before wiring up a creator-facing minting flow.
contract OnlyAssCreatorNFT is ERC1155, Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Hard ceiling on the platform fee so the owner can never set an
    /// abusive rate, same reasoning as OnlyAssPayments' identical constant.
    uint256 public constant MAX_FEE_BPS = 3_000;
    /// @notice Sanity ceiling, not a real-world limit anyone would hit --
    /// guards against a fat-fingered edition size doing something absurd.
    uint256 public constant MAX_EDITION_SIZE = 100_000;

    address public platformWallet;
    uint256 public platformFeeBps;
    address public onlyAssToken;
    /// @notice The launchpad this contract trusts to say "yes, this creator
    /// really did launch this token" -- same role as in OnlyAssPayments.
    IOnlyAssLaunchpadV4Views public launchpad;

    struct Drop {
        address creator;
        address payToken; // address(0) = ETH, else must be $ONLYASS or a token this creator launched
        uint256 price; // per-copy price, in wei (ETH) or the token's smallest unit
        uint256 editionSize;
        uint256 minted;
        string metadataURI;
        bool active;
    }

    Drop[] public drops;

    event DropCreated(
        uint256 indexed dropId, address indexed creator, address payToken, uint256 price, uint256 editionSize, string metadataURI
    );
    event DropClosed(uint256 indexed dropId);
    event Minted(
        uint256 indexed dropId, address indexed buyer, uint256 editionNumber, uint256 grossAmount, uint256 feeAmount, uint256 creatorAmount
    );
    event PlatformWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event PlatformFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event OnlyAssTokenUpdated(address indexed oldToken, address indexed newToken);
    event LaunchpadUpdated(address indexed oldLaunchpad, address indexed newLaunchpad);
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh();
    error TransferFailed();
    error InvalidEditionSize();
    error EmptyMetadataURI();
    error InvalidPayToken();
    error DropNotActive();
    error DropSoldOut();
    error NotDropCreator();
    error WrongPaymentValue();
    error LaunchpadNotSet();
    error InvalidDropId();

    constructor(
        address initialOwner,
        address initialPlatformWallet,
        uint256 initialFeeBps,
        address initialOnlyAssToken,
        address initialLaunchpad,
        string memory contractMetadataURI
    ) ERC1155(contractMetadataURI) Ownable(initialOwner) {
        if (initialPlatformWallet == address(0) || initialOnlyAssToken == address(0)) revert ZeroAddress();
        if (initialFeeBps > MAX_FEE_BPS) revert FeeTooHigh();

        platformWallet = initialPlatformWallet;
        platformFeeBps = initialFeeBps;
        onlyAssToken = initialOnlyAssToken;
        // Zero allowed -- payToken must then be address(0) (ETH) or
        // onlyAssToken until a launchpad is wired up (see OnlyAssPayments'
        // identical reasoning).
        launchpad = IOnlyAssLaunchpadV4Views(initialLaunchpad);
    }

    /// @notice Start a new drop. Anyone can call this for themselves (there's
    /// no creator allowlist on-chain, same as the rest of this platform's
    /// contracts) -- `msg.sender` is permanently the drop's creator and payout
    /// address.
    function createDrop(address payToken, uint256 price, uint256 editionSize, string calldata metadataURI)
        external
        whenNotPaused
        returns (uint256 dropId)
    {
        if (editionSize == 0 || editionSize > MAX_EDITION_SIZE) revert InvalidEditionSize();
        if (price == 0) revert ZeroAmount();
        if (bytes(metadataURI).length == 0) revert EmptyMetadataURI();
        if (payToken != address(0) && payToken != onlyAssToken && !_isLaunchedByCreator(msg.sender, payToken)) {
            revert InvalidPayToken();
        }

        dropId = drops.length;
        drops.push(
            Drop({
                creator: msg.sender,
                payToken: payToken,
                price: price,
                editionSize: editionSize,
                minted: 0,
                metadataURI: metadataURI,
                active: true
            })
        );

        emit DropCreated(dropId, msg.sender, payToken, price, editionSize, metadataURI);
    }

    /// @notice Stops a drop from selling further copies before its edition
    /// sells out. Copies already minted are unaffected -- this only closes
    /// off new mints.
    function closeDrop(uint256 dropId) external {
        if (dropId >= drops.length) revert InvalidDropId();
        Drop storage d = drops[dropId];
        if (msg.sender != d.creator) revert NotDropCreator();
        d.active = false;
        emit DropClosed(dropId);
    }

    /// @notice Mint the next copy of a drop. Pays the creator + platform fee
    /// and mints the ERC-1155 unit to the caller in the same transaction --
    /// there is no scenario where payment succeeds but the mint doesn't, or
    /// vice versa.
    function mintEdition(uint256 dropId) external payable nonReentrant whenNotPaused returns (uint256 editionNumber) {
        if (dropId >= drops.length) revert InvalidDropId();
        Drop storage d = drops[dropId];
        if (!d.active) revert DropNotActive();
        if (d.minted >= d.editionSize) revert DropSoldOut();

        address payToken = d.payToken;
        uint256 price = d.price;
        address creator = d.creator;
        (uint256 feeAmount, uint256 creatorAmount) = _split(price);
        if (payToken == address(0) ? msg.value != price : msg.value != 0) revert WrongPaymentValue();

        // Checks-effects-interactions: finalize this drop's own state (and
        // mint the ERC-1155 unit) before any external call -- the payment
        // calls below are still guaranteed to run in the same transaction as
        // everything above, so this doesn't change atomicity, just the order
        // Slither (correctly) wants state settled relative to external calls.
        d.minted += 1;
        editionNumber = d.minted;
        _mint(msg.sender, dropId, 1, "");
        emit Minted(dropId, msg.sender, editionNumber, price, feeAmount, creatorAmount);

        if (payToken == address(0)) {
            if (feeAmount > 0) {
                (bool feeOk,) = platformWallet.call{value: feeAmount}("");
                if (!feeOk) revert TransferFailed();
            }
            (bool creatorOk,) = creator.call{value: creatorAmount}("");
            if (!creatorOk) revert TransferFailed();
        } else {
            IERC20 t = IERC20(payToken);
            if (feeAmount > 0) t.safeTransferFrom(msg.sender, platformWallet, feeAmount);
            t.safeTransferFrom(msg.sender, creator, creatorAmount);
        }
    }

    function dropCount() external view returns (uint256) {
        return drops.length;
    }

    /// @dev Loops the creator's launches -- same trust model and reasoning as
    /// OnlyAssPayments._isLaunchedByCreator (view-only calls, launchpad is an
    /// owner-set trusted address, a real creator's launch count is small).
    function _isLaunchedByCreator(address creatorWallet, address token) internal view returns (bool) {
        if (address(launchpad) == address(0)) revert LaunchpadNotSet();
        uint256[] memory ids = launchpad.launchesOf(creatorWallet);
        for (uint256 i = 0; i < ids.length; i++) {
            (address launchedToken,,,,,,) = launchpad.launches(ids[i]);
            if (launchedToken == token) return true;
        }
        return false;
    }

    function _split(uint256 grossAmount) internal view returns (uint256 feeAmount, uint256 creatorAmount) {
        feeAmount = (grossAmount * platformFeeBps) / BPS_DENOMINATOR;
        creatorAmount = grossAmount - feeAmount;
    }

    /// @notice Per-drop metadata URI -- see this contract's header for why
    /// this must point at a platform-controlled URL, never raw IPFS/Arweave.
    function uri(uint256 id) public view override returns (string memory) {
        if (id >= drops.length) revert InvalidDropId();
        return drops[id].metadataURI;
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

    function setOnlyAssToken(address newToken) external onlyOwner {
        if (newToken == address(0)) revert ZeroAddress();
        emit OnlyAssTokenUpdated(onlyAssToken, newToken);
        onlyAssToken = newToken;
    }

    function setLaunchpad(address newLaunchpad) external onlyOwner {
        emit LaunchpadUpdated(address(launchpad), newLaunchpad);
        launchpad = IOnlyAssLaunchpadV4Views(newLaunchpad);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover ERC-20 tokens sent to this contract by mistake (this
    /// contract never intentionally holds a balance between transactions --
    /// every mint pays out immediately, same as OnlyAssPayments).
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit ERC20Rescued(token, to, amount);
    }
}
