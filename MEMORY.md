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

**A real global "stake $ONLYASS platform-wide for a discount" feature does
NOT exist and was explicitly declined when offered** (asked whether to build
one; answer was no). The only "staking"-shaped thing in the codebase is
`server/src/modules/stake.ts`'s `TokenLock` -- a *per-creator* perk a fan
pays into (priced by that creator, in USD), unrelated to any site-wide
discount now. It still waives the creator's own 2% instant-payout fee
(`payouts.ts`, `stakePerkEnabled`) -- that's a creator-side payout-speed
perk, a different axis from the fan-side discount question, and was left
untouched. **Don't reintroduce either removed discount, and don't build a
global staking discount without asking first** -- if a real staking feature
gets greenlit later, it needs actual numbers (discount %, stake duration,
what "for a month" resets on) before building it, not defaults guessed at.

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
show it on their page" is already true there). Fan-facing public profiles
(fans need their own profile page, not just an account) are fully
greenfield on both stacks -- no model, route, or store exists for this yet.
