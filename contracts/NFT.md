# OnlyOneCreatorNFT

Self-serve NFT drops: a creator picks an image, how many copies to mint,
what to charge, and what to charge it in. See `OnlyOneCreatorNFT.sol` for
the implementation, `test/OnlyOneCreatorNFT.test.js` for the test suite
(28 tests).

## What it does

`createDrop(payToken, price, editionSize, metadataURI)`: any address can
start a drop for itself (no allowlist, same as every other contract in this
repo) -- `msg.sender` is permanently that drop's creator and payout address.
`payToken` is `address(0)` for ETH or the deployed $ONLYONE token address --
those are the only two accepted payment methods. An earlier version also
accepted a token the creator had launched through a creator-token launchpad,
verified live on-chain against the launchpad's records; that launchpad was
removed from this repo (the founder is launching $ONLYONE from his own
launchpad instead), so `createDrop` now rejects any other ERC-20 outright
rather than accepting one on the strength of a launch record that can no
longer exist.

`mintEdition(dropId)`: a fan mints the next copy. Payment and mint happen
atomically in the same transaction -- there's no scenario where a fan pays
and doesn't get the token, or gets the token without paying. The platform
takes its cut (`platformFeeBps`, 10% by default) the same way
`OnlyOnePayments.sol` already does; the rest goes straight to the creator.

A drop is one ERC-1155 token id with `editionSize` identical copies. A
1-of-1 ("this is the one true original") is just `editionSize == 1` --
same mechanism as a 50-copy print run, no special-cased code path. A
creator can `closeDrop` early to stop selling before it sells out; already-
minted copies are unaffected.

## Why this needed a real ERC standard decision, and why ERC-1155 not ERC-721

"How many they want to mint" (the actual ask this was built for) means
multiple identical copies of the same image, sold individually -- that's
what ERC-1155 is for natively (one token id, N fungible units of it). ERC-721
is strictly one-token-per-unique-item; representing a 50-copy print run in
ERC-721 would mean minting 50 separate token ids for what's supposed to be
"the same thing," which is both awkward and loses the "copy #7 of 50"
framing entirely. ERC-1155 gives both cases (1-of-1s and print runs) the
same code path.

## The decision this contract's whole design depends on: where the image lives

**`metadataURI` must point at a URL the platform itself controls (this
repo's own API/CDN) -- never raw IPFS, Arweave, or on-chain-stored bytes.**
This isn't a style preference, it's load-bearing for two things this
contract cannot do on its own:

1. **The blur-until-purchased gating this whole feature exists for.**
   Whether to serve the real image or a blurred placeholder has to be
   decided per-request, server-side, by checking the requester's wallet
   against this contract's own `balanceOf(wallet, dropId)`. A file sitting
   on immutable storage can't do that -- anyone with the IPFS hash sees the
   real image regardless of whether they paid. The actual "serve blurred
   vs. real" endpoint is **not built in this pass** -- this contract only
   covers minting/payment/ownership; the metadata/image-serving API that
   reads `balanceOf` and decides what to return is the next piece, same
   shape as `canViewListing`/`canViewMedia` already gate marketplace/message
   content server-side.
2. **Content takedown.** If something ever needs to come down -- a
   creator's own request, a legal or consent issue, anything -- that's only
   possible if the platform actually controls where the bytes live. Once
   something is pinned to IPFS/Arweave or embedded on-chain, it is for all
   practical purposes permanent; there is no "delete" button. For adult
   content specifically this is a real liability, not a nice-to-have, and
   is the main reason this design doc exists at all -- see the "why not just
   a normal NFT" conversation this was built from.

The contract cannot enforce this at the Solidity level (`metadataURI` is
just a string) -- it's a hard requirement on whatever UI ends up calling
`createDrop`, documented here so it isn't lost. **Do not wire up a
creator-facing minting flow that lets a creator paste an arbitrary IPFS URL
into this field.**

## Design decisions for an auditor

- **Non-custodial, same as `OnlyOnePayments.sol`.** No escrow, no balance
  held between transactions -- every mint pays out immediately.
- **Checks-effects-interactions in `mintEdition`.** Drop state (`minted`
  count) and the actual `_mint` happen *before* the ETH/ERC-20 payment
  transfers, not after -- Slither's `reentrancy-eth` flagged the original
  ordering (state written after the external `.call`); this doesn't change
  atomicity (the whole transaction still reverts together on any failure)
  but it's the correct order regardless, and it's free to fix, so it was
  fixed rather than just documented as accepted.
- **`payToken` validation is a plain allowlist of two values** (`address(0)`
  for ETH, or the configured `onlyOneToken`), not a launchpad lookup -- see
  "What it does" above for why the launchpad-verification version was
  removed.
- **`MAX_EDITION_SIZE = 100_000`** is a sanity ceiling, not a real limit
  anyone would hit -- same "hard number that can never be raised past a
  point" philosophy as `MAX_FEE_BPS` elsewhere in this repo.
- **Explicit `InvalidDropId` bounds checks** on every function that indexes
  `drops[]` by an external caller-supplied id (`mintEdition`, `closeDrop`,
  `uri`), rather than relying on Solidity's implicit out-of-bounds panic.
- **Requires Cancun.** OpenZeppelin 5.6's `ERC1155` pulls in `Arrays.sol`,
  which uses the Cancun-only `MCOPY` opcode in a few of its helper
  functions -- solc can't compile the file at all under an older EVM
  target, even though `ERC1155` itself never calls those specific helpers.
  `hardhat.config.js` has a per-file override forcing this contract to
  compile at `evmVersion: "cancun"`. **Unverified assumption**: nothing in
  this repo has confirmed Robinhood Chain's EVM actually supports Cancun.
  Verify that before deploying this contract there.

## Slither findings (all accepted)

Ran `slither .` against the current contract -- 2 findings, both the same
already-accepted pattern: `low-level-calls` on the ETH payout `.call{value:
...}()` in `mintEdition`, matching every other ETH payout in this codebase
(`.transfer`'s 2300 gas stipend breaks payouts to smart-contract wallets;
`nonReentrant`-guarded).

## What still needs a human before mainnet

- **Payment asset.** Drops are priced in ETH or $ONLYONE only, and the
  platform's standing rule is that $ONLYONE is never a payment method
  (settlement is USDG credits). `scripts/deploy-creator-nft.js` refuses
  production chains until the contract is reworked to settle in the
  allowlisted stablecoin, or archived -- an owner decision. It also requires
  `OWNER_ADDRESS` (not the deploying key) and an explicit
  `NFT_CONTRACT_METADATA_URI`, since no route serves contract metadata yet.

- **The metadata/image-serving API isn't built.** This contract handles
  minting, payment, and on-chain ownership correctly and is tested, but
  there is currently nothing that actually serves a blurred-vs-real image
  based on `balanceOf`. Don't market "mint to unlock" until that exists.
- **Confirm Robinhood Chain supports Cancun** -- see above.
- **No deploy to mainnet from this session** -- same boundary as every
  other contract here: a real deployer private key never gets generated,
  accepted, or transmitted in this chat. Use `npm run
  creator-nft:deploy:robinhood-testnet` from your own machine with your own
  key (the mainnet script refuses, see above).

## Local dev

```
npm run contracts:compile
npm run contracts:test
```
