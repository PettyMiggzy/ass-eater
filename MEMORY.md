# Persistent notes (business/product context, not code docs)

Read this at the start of a session for context that isn't obvious from the
code. Append to it -- don't let it go stale, but don't delete history that
might matter later either.

## Founder/creator token allocation

The platform owner will hold **40% of $ONLYASS's 1 billion total supply**,
unlocked over **30 days after deploy**, with a **daily cap on how much can be
collected/claimed** (exact vesting curve/cap not yet specified as of
2026-09-16). Relevant whenever touching:

- Public tokenomics disclosure/marketing copy for $ONLYASS -- a 40% founder
  allocation is the kind of thing that needs to be disclosed plainly, not
  discovered later, both for basic trust and because a large, presumably
  short-vested founder stake is exactly the pattern retail buyers get burned
  by when it isn't disclosed.
- Any future on-chain vesting/claim contract for this allocation -- nothing
  like that has been built yet. If asked to build it, the daily-cap +
  30-day-window mechanic needs the actual numbers first, not defaults guessed
  at.
- `treasury-hedge.ts` / price-impact modeling -- a wallet than can eventually
  move 40% of supply is a meaningful tail risk for pool depth/slippage
  assumptions once vesting completes.

**Decided (2026-09-16): no code/UI action needed on this right now.** The
allocation just sits unclaimed in the launch/deploy contract until the
30-day window is up -- deliberately not surfacing it on the site or in
marketing before then ("no reason to scare people right now" / "no reason to
jump the gun"). Once claimable, the plan is a **separate treasury wallet**
(not yet created) that the owner will withdraw into and use for marketing
spend. Don't build a vesting/claim contract or add any founder-allocation
UI/disclosure unless asked -- this is intentionally quiet until launch.

## Branding

**Decided (2026-09-16): no rename.** Considered changing the product name
while keeping the onlyass.fun domain (see rationale below, kept for
context), but concluded there's no clean way to do it and is keeping the
name as-is. Don't propose or build toward a rename unless the user brings it
back up.

Original reasoning, for context: explicit "Only Ass" branding is a real
problem for mainstream ad platforms (Google/Meta/TikTok Ads all prohibit
adult content ads regardless of brand name -- they review actual site
content, not just the name -- so a rename would mainly have helped with
stigma/press/App Store listing/word-of-mouth, not with unlocking those ad
platforms directly). Current plan either way: advertise primarily on adult
ad networks, since mainstream paid ads are blocked by the content itself.

## Fee structure & discounts (decided 2026-09-16)

Ground rule going forward: **a flat 10% platform fee on everything except
marketplace sales, which stay at 15% (10% platform + 5% listing fee) as a
deliberate special case.** Staking is meant to eventually be the *only*
fan-facing discount -- nothing else should auto-discount a charge.

The server/ backend (`server/src/core/ledger.ts`,
`server/src/modules/marketplace.ts`) already had two discount paths that
contradicted that, both now removed:
- `TOKEN_PAYMENT_DISCOUNT_BPS` (10% off any charge paid from an
  $ONLYASS-denominated balance) -- deleted from `ledger.ts`'s `charge()`.
  Paying in $ONLYASS still works, it just no longer discounts the price.
- `LOYALTY_DISCOUNT_BPS` (10% off a marketplace purchase for anyone with an
  active subscription OR an active per-creator `TokenLock`) -- deleted from
  `marketplace.ts`'s buy handler.

**Superseded (2026-09-16): "stake for a month" was replaced by "burn for
VIP" before staking was ever built.** A global stake-based discount was
offered and explicitly declined; instead, the actual discount mechanic that
got built is a **one-way $ONLYASS burn**: a fan permanently gives up tokens
(from their $ONLYASS balance) and once their cumulative burn crosses an
admin-adjustable threshold (10,000,000 tokens by default), they get the 10%
discount on everything, no expiry/renewal (framed as a "VIP club," not a
subscription). The threshold is intentionally adjustable so it can be
lowered as $ONLYASS's price rises, keeping the real-dollar cost of VIP from
floating upward forever. Full design in `server/VIP.md`; code in
`server/src/core/vip.ts` + `server/src/modules/vip.ts` +
`server/src/modules/admin.ts`'s `/vip-config`. It's a **ledger-side** burn
right now (destroys the value in the ledger, doesn't yet execute a real
on-chain burn transaction) -- see VIP.md for why that's a deliberate, later-
revisitable scope cut, not an oversight.

The pre-existing `server/src/modules/stake.ts` `TokenLock` (a *per-creator*
perk a fan pays into, priced by that creator) is unrelated to VIP and was
left as its own thing -- it still waives the creator's own 2% instant-payout
fee (`payouts.ts`, `stakePerkEnabled`), a creator-side payout-speed perk on
a different axis from the fan-side VIP discount.

Also raised, explicitly deferred rather than built: creators who launch
their own token via the launchpad will likely want to charge fans in that
token specifically ("let them decide what they want to do"). `payAsset`/
`payoutAsset` stay `USD | ONLYASS` only for now -- a third, per-creator
payment asset needs real per-token price oracles and balance pools, not a
small addition. Don't build it without asking first.

Every other rate already matches the flat-10% rule and didn't need
changing: `FEES.DEFAULT_BPS` (subscriptions, tips, message unlocks) is
already 10%. `FEES.TOKEN_PAYOUT_BPS` (8%, a *creator* payout-side rate for
creators who take payout in $ONLYASS) and `FEES.INSTANT_PAYOUT_BPS`/
`WITHDRAWAL_*` (payout-speed/withdrawal fees) are separate, creator-facing
knobs, not the fan-facing "10% on everything" this decision was about --
left alone.

## Chat / pay-per-message (decided 2026-09-16)

Creators can now price **any** message, not just ones with media attached
(`server/src/modules/messages.ts` -- the `!b.mediaIds.length` restriction on
`priceCents > 0` was removed; error renamed `only_creators_can_price_messages`).
The subscriber-only gate stayed: a fan can still only DM a creator they
subscribe to (and vice versa) -- cold-messaging a stranger for pay was
explicitly declined.

**Found and fixed a real paywall-bypass bug while making this change:** the
DM REST endpoint (`GET /with/:userId`) and both realtime push paths (single
DM in `modules/messages.ts`, mass PPV broadcast in `workers/broadcast.ts`)
only ever redacted a locked message's *media* preview, never its `text` --
harmless while pricing was restricted to media-attached messages (the text
was always just a free teaser caption), but a real paywall bypass once plain
text itself can be priced. All three now redact `text` the same way media
already was, until the fan unlocks it or it's free.

**Not changed, flagged for awareness:** subscription *price* is already
creator-set (`SubscriptionTier.priceCents`), but subscription *cadence* is
hardcoded to 30 days platform-wide (`PERIOD_MS` in `renewals.ts`, shared
with `TokenLock`'s renewal). Supporting a creator-chosen cadence (weekly,
annual, etc.) would be a real schema + renewal-worker change, not touched
since "monthly or whatever" wasn't confirmed as a hard requirement for
multiple cadences.

**Still greenfield, not yet built:** subscription/PPM/marketplace selling
all exist only on the server/ (Postgres/Fastify) stack, which isn't deployed
yet -- the live Next.js/Vercel-Blob site has none of this (no fee logic, no
subscriptions, no priced messages at all). Content-selling is marketplace-
only per this decision (a creator's own profile page already surfaces their
marketplace listings on the live site, so "sell in the marketplace, also
show it on their page" is already true there).

## Creators get paid in their own launched token (shipped 2026-09-16)

Explicitly un-deferred the same day it was flagged as "later" -- the user
pushed back hard on stopping to ask/defer things given launch is imminent,
so this got built same-session instead of staying on the roadmap.

`contracts/OnlyAssPayments.sol` (the direct wallet-to-wallet payment
contract, separate from server/'s ledger) got a third payment function,
`payWithCreatorToken`, alongside the existing ETH and $ONLYASS ones. It
checks **live, on-chain, every call** that the token being paid in was
actually launched by that creator through `OnlyAssLaunchpadV4` (loops that
creator's real launch records -- no admin allowlist, nothing cached, so
there's no separate "approve this token" step for anyone to forget). Same
90/10-style split as the other two payment methods. Full writeup in
`contracts/README.md`.

This is deliberately the **simple, real, ship-able-tonight version**, not
the full thing: it's a direct on-chain payment (fan's wallet -> creator's
wallet + platform's wallet, atomically, no platform balance involved), not
a new asset type inside `server/`'s ledger. The bigger version -- a creator
token as a real `payAsset` option inside the ledger, with its own price
oracle and deposit tracking like $ONLYASS has -- is still not built and
still a real chunk of work (flagged above, unchanged). This is the
"very minimum working" version of that idea, not a placeholder for it.

## Fan discovery: favorites shipped, category browsing still roadmap (2026-09-16)

Researched what OnlyFans actually does for fans before building anything
(don't guess at a competitor's real feature set): OnlyFans has **no public
fan profile page at all** -- fans just get a display name/bio/avatar that
only shows up to creators they've messaged or subscribed to, never a public
page anyone can browse, and most fans skip even that for privacy. So "fans
need their own profile page" (the earlier open item) was dropped as a
non-goal, not built.

What OnlyFans is actually bad at, and where "plus more" is real: in-app
discovery. No native browse/filter/category search at all -- fans either
already know a creator's name, or use third-party "finder" sites, which is
a well-known pain point.

Shipped tonight, live site only: a **favorites/save button** on a creator's
profile (heart icon) plus a `/favorites` page listing everyone a fan has
saved (`lib/favorites-store.js`, `pages/api/favorites/toggle.js`,
`pages/favorites.js`). This is the real "make it easier to find creators
you like" feature -- it doesn't need to be public, just useful.

**Not built, roadmap:** category/tag browsing and filters. Creators
(`data/creators.js` / `lib/creators-store.js`) have no tags/category field
at all yet -- adding real browse-by-category needs a taxonomy and a way for
creators to set their own tags first, which is more than a tonight-sized
add on top of everything else shipped this session. Basic keyword search
(name/bio/handle) already existed before tonight and still works
(`pages/search.js`).

## Fiat on-ramp (Stripe): a firm no, not just "later" (2026-09-16)

Idea floated: run card payments through Stripe via a DBA under the user's
*other*, unrelated business's existing Stripe account, since a new adult
platform likely couldn't get approved directly. Checked Stripe's actual
restricted-businesses policy rather than assume -- confirmed adult content
("pornography and other mature audience content... for the purpose of
sexual gratification") and adult services are **prohibited outright**, not
a "restricted, needs extra approval" category. There's no account structure
or DBA that makes that not true, and running it through a DBA specifically
means not disclosing to Stripe what the money is actually for -- if/when
caught, the realistic outcome is the account being shut down, funds frozen
(often 120+ days), and it puts the **other business's** Stripe account at
risk too, since it would be the same account. Don't build toward Stripe as
a payment path here under any structure, DBA included.

Fiat on-ramp is still a real, wanted roadmap item, just needs the right
target: adult-industry-specific processors (**CCBill, Segpay, Epoch,
Vendo**) are what actual OnlyFans-style platforms use for card payments --
that's the real "way later" on-ramp research item, not Stripe. Same
category of vendor-compliance problem this session already hit with
Transak/Circle's Arc (both confirmed to ban adult content too) -- pattern
to remember: mainstream/general-purpose payment rails reliably say no to
this vertical; the adult-industry-specific ones are the actual answer.

Checked ease of signup for those four: **Epoch is the easiest** -- it acts
as a payment facilitator, so a new merchant often doesn't need to secure
its own separate high-risk merchant account at all (lowest barrier for a
platform with no track record yet). Segpay/Vendo are a full KYC paperwork
packet + a working site, then roughly a-week-or-less approval. CCBill is
the most established/trusted name but the slowest (2-3 weeks) and most
expensive (10.8-14.5% per transaction + $500-1,000/yr registration fee).
**All four require a live, working site with real ToS/privacy
policy/age-verification/contact info already in place before they'll even
review an application** -- none pre-approve off a promise, so the actual
site needs to look and function like a real business first, regardless of
which processor gets picked later.

## Creator tags + browse-by-tag (shipped 2026-09-16)

Built the piece of "make it easier to find creators" that was flagged as
roadmap: creators can now set up to 8 tags on their own profile (dashboard
-> Tags field, comma-separated -- `lib/creators-store.js`'s `sanitizeTags`
normalizes/dedupes/lowercases them, wired into both `/api/me/profile` and
`/api/admin/profile`). A creator's tags show as clickable `#tag` chips on
their profile page. `/search` now supports `?tag=`, and when nobody's
searching for anything yet it shows a "Browse by tag" chip cloud built from
every tag any creator has set, instead of just a blank "type something"
prompt. Seed creators (`data/creators.js`) got real tags too so this isn't
empty at launch.

Still just simple exact-tag matching, no synonym/fuzzy matching, no
tag-combination filtering (AND/OR across multiple tags at once) -- fine for
launch, worth revisiting if the tag list grows large.

## Creator NFT drops (shipped 2026-09-16)

Someone ("Brad") floated selling blurred self-images as NFTs on the
marketplace. Talked through it first: the blur/one-buyer idea doesn't
actually need to be an NFT (the existing one-of-a-kind marketplace listing
already does that), and real NFTs are basically permanent once minted --
which is a genuine liability for adult content specifically if something
ever needs to come down (consent issue, legal complaint, creator changes
their mind). User heard that and decided to build it anyway, full creator
control: pick the image, how many copies, what to charge, and what asset to
charge it in -- platform takes 10%.

Built `contracts/OnlyAssCreatorNFT.sol` (ERC-1155 -- one token id per drop,
`editionSize` identical copies; a 1-of-1 is just `editionSize == 1`, same
mechanism as a print run). `createDrop`/`mintEdition` mint and pay
atomically in one call, no off-chain relayer. Payment asset is ETH,
$ONLYASS, or a token the creator actually launched on `OnlyAssLaunchpadV4`
-- verified live on-chain the same way `OnlyAssPayments.payWithCreatorToken`
already does (reuses that exact interface/pattern). 24 tests, Slither-clean
(one real reentrancy-eth finding fixed via reordering, not just
documented). Full writeup: `contracts/NFT.md`.

**The actual liability mitigation, load-bearing, not yet enforced in
code:** every drop's `metadataURI` MUST point at a URL the platform itself
controls (our own API), never raw IPFS/Arweave -- that's what makes (a) the
blur-until-purchased gating possible at all (has to check `balanceOf` per
request, server-side) and (b) a future takedown possible if one is ever
needed. The contract can't enforce this itself (`metadataURI` is just a
string) -- it's a hard requirement on whatever UI eventually calls
`createDrop`. **Don't build a creator-facing minting flow that lets someone
paste an arbitrary IPFS link into that field.**

**Not built:** the actual metadata/image-serving endpoint that checks
`balanceOf` and decides whether to serve the real image or a blurred
placeholder. This pass only covers minting/payment/ownership on-chain --
same scoping as the V4 launchpad (contract shipped, matching frontend not
built yet). No creator-facing UI for starting a drop exists yet either.
