# OnlyAssCreatorNFT

Self-serve NFT drops: a creator picks an image, how many copies to mint,
what to charge, and what to charge it in. See `OnlyAssCreatorNFT.sol` for
the implementation, `test/OnlyAssCreatorNFT.test.js` for the test suite
(24 tests).

## What it does

`createDrop(payToken, price, editionSize, metadataURI)`: any address can
start a drop for itself (no allowlist, same as every other contract in this
repo) -- `msg.sender` is permanently that drop's creator and payout address.
`payToken` is `address(0)` for ETH, `$ONLYASS`, or a token that creator
actually launched through `OnlyAssLaunchpadV4` (checked live on-chain
against the launchpad's real records, same `_isLaunchedByCreator` pattern
`OnlyAssPayments.sol` already uses -- no admin allowlist, nothing cached).

`mintEdition(dropId)`: a fan mints the next copy. Payment and mint happen
atomically in the same transaction -- there's no scenario where a fan pays
and doesn't get the token, or gets the token without paying. The platform
takes its cut (`platformFeeBps`, 10% by default) the same way
`OnlyAssPayments.sol` already does; the rest goes straight to the creator.

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

- **Non-custodial, same as `OnlyAssPayments.sol`.** No escrow, no balance
  held between transactions -- every mint pays out immediately.
- **Checks-effects-interactions in `mintEdition`.** Drop state (`minted`
  count) and the actual `_mint` happen *before* the ETH/ERC-20 payment
  transfers, not after -- Slither's `reentrancy-eth` flagged the original
  ordering (state written after the external `.call`); this doesn't change
  atomicity (the whole transaction still reverts together on any failure)
  but it's the correct order regardless, and it's free to fix, so it was
  fixed rather than just documented as accepted.
- **`payToken` validation reuses `OnlyAssPayments.sol`'s exact trust model**:
  loop the creator's launchpad records (view-only, `STATICCALL`-compiled,
  can't reenter this contract's state regardless of what's deployed at
  `launchpad`), `launchpad` is an owner-set trusted address, and a real
  creator's launch count is realistically single digits, not
  attacker-inflatable. `IOnlyAssLaunchpadV4Views` is imported directly from
  `OnlyAssPayments.sol` rather than redeclared, so the two contracts can
  never drift apart on what that interface looks like.
- **`MAX_EDITION_SIZE = 100_000`** is a sanity ceiling, not a real limit
  anyone would hit -- same "hard number that can never be raised past a
  point" philosophy as `MAX_FEE_BPS`/`MAX_PLATFORM_SUPPLY_BPS` elsewhere in
  this repo.
- **Explicit `InvalidDropId` bounds checks** on every function that indexes
  `drops[]` by an external caller-supplied id (`mintEdition`, `closeDrop`,
  `uri`), rather than relying on Solidity's implicit out-of-bounds panic --
  matches `OnlyAssLaunchpadV4`'s existing `InvalidLaunchId` pattern.
- **Requires Cancun.** OpenZeppelin 5.6's `ERC1155` pulls in `Arrays.sol`,
  which uses the Cancun-only `MCOPY` opcode in a few of its helper
  functions -- solc can't compile the file at all under an older EVM
  target, even though `ERC1155` itself never calls those specific helpers.
  `hardhat.config.js` has a per-file override forcing this contract to
  compile at `evmVersion: "cancun"`. **Same unverified assumption as the V4
  launchpad work**: nothing in this repo has confirmed Robinhood Chain's
  EVM actually supports Cancun. Verify that before deploying this contract
  there, same as `LAUNCHPAD_V4.md` already says for the launchpad/hook.

## Slither findings (all accepted, none changed beyond the reentrancy fix above)

Ran `slither .` -- 3 remaining findings after the reentrancy-eth fix, all
reviewed:

- **`unused-return` / `calls-loop` on `_isLaunchedByCreator`**: identical
  findings, identical accepted reasoning, as `OnlyAssPayments.sol`'s own
  copy of this exact helper (see `contracts/README.md`).
- **`low-level-calls` on the ETH payout in `mintEdition`**: same `.call`
  pattern, same reasoning (`.transfer`'s 2300 gas stipend breaks payouts to
  smart-contract wallets; `nonReentrant`-guarded) as every other ETH payout
  in this codebase.

## What still needs a human before mainnet

- **The metadata/image-serving API isn't built.** This contract handles
  minting, payment, and on-chain ownership correctly and is tested, but
  there is currently nothing that actually serves a blurred-vs-real image
  based on `balanceOf`. Don't market "mint to unlock" until that exists.
- **Confirm Robinhood Chain supports Cancun** -- see above.
- **`LAUNCHPAD_V4_ADDRESS` can be left unset at deploy time** and wired up
  later via `setLaunchpad(...)` -- creators just can't price a drop in
  their own token until then (ETH and $ONLYASS still work immediately).
- **No deploy to mainnet from this session** -- same boundary as every
  other contract here: a real deployer private key never gets generated,
  accepted, or transmitted in this chat. Use `npm run
  creator-nft:deploy:robinhood-testnet` / `creator-nft:deploy:robinhood`
  from your own machine with your own key.

## Local dev

```
npm run contracts:compile
npm run contracts:test
```
