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

**Explicit reminder from the user (2026-09-16): none of this -- the NFT
contract, the V4 launchpad, the VIP burn feature -- is expected to be live
for tomorrow's launch.** It's being built now so it exists and is ready for
audit/deployment on the platform's own timeline, not because it's part of
day-one scope. Don't treat anything in this file as "must ship tomorrow"
unless it's explicitly said to be.

## Privacy Policy + anonymous fan signup (shipped 2026-09-16)

Two real gaps, both fixed:

- **No Privacy Policy existed at all** (only Terms of Service). Added
  `pages/privacy.js`, same structure/tone as `pages/terms.js`, same
  "template, not legal advice, get an attorney" disclaimer at the bottom.
  Fixed the footer link on `pages/index.js` that was pointing "Privacy
  Policy" at `/terms` (leftover placeholder), and `pages/token.js`'s
  roadmap line that still said this was "planned."
- **Signup had no Terms/Privacy acceptance checkbox at all** -- only the
  marketplace's buy flow gated on explicit agreement. Added one to
  `pages/signup.js` (age + both docs, one combined checkbox, submit
  disabled until checked) so account creation itself is covered too, not
  just marketplace purchases.
- **Fans can now sign up with just a username, no real email required**
  (`pages/signup.js`'s email field becomes a plain text "Email or Username"
  input for the Fan role specifically, with a line explaining why; the
  login page accepts either too). This was a direct, explicit ask: a lot of
  fans on an adult platform don't want a real email on file that a
  spouse/partner could ever see. Creators still require a real
  `type="email"`-validated address (they need a real contact channel;
  their identity is already verified separately for KYC anyway).
  Server-side, the field was always just a loose "unique login identifier"
  with no format enforcement and nothing anywhere actually sends real
  email to it, so this needed a UI change more than a backend one --
  `lib/users-store.js` now has a comment making that explicit so it isn't
  "fixed" back to requiring email format later by accident.

**Flagged, not acted on:** in the same conversation, content scope was
described as open to "guys and women, and animated stuff, nothing's off
limits I guess." Worth being deliberate about before that becomes a real
policy: animated/drawn content that depicts what could read as a minor is
illegal in a number of jurisdictions regardless of it being fictional, and
is something payment processors and ad networks explicitly screen for
separately from real-person adult content. Not a decision to make silently
-- if/when actual content-moderation rules get written, this needs its own
explicit line, not an assumption either way.

## Referral system: now pays for inviting fans, not just creators (shipped 2026-09-16)

Direct ask: "Def need get referral system so ppl invite creators and get
some of something lol and fans." The referral *plumbing* already existed and
was already role-agnostic on the signup side --
`server/src/modules/auth.ts`'s `POST /register` accepts a `referralCode`
(matched against username) and sets `referredById` on any new account, fan
or creator, and `GET /referral` already returns a generic
`{code, referrals, earningsCents}` for whoever's logged in. The actual gap
was entirely in `server/src/core/ledger.ts`'s `charge()`: it only ever
looked at the **creator's** `referredById` to decide whether to pay a
referral cut, so referring a fan produced zero reward no matter how much
that fan spent.

Fixed by having `charge()` look up both sides' `referredById`/`createdAt`
and run the same "still inside `FEES.REFERRAL_MONTHS` of that person's
signup" check independently for each: whoever referred the **creator**
(payee) and whoever referred the **fan** (payer) each get their own
`FEES.REFERRAL_BPS` (5%) cut of the platform's fee on every transaction,
for 12 months after the referred person signed up. If both sides of a given
transaction were referred by different people, both get paid out of the
same transaction (still capped so combined referral payouts can never
exceed the platform's fee itself). No schema change needed -- `User` already
had a self-referential `referredById`. Tests added in
`server/src/core/ledger.test.ts` mirroring the existing creator-side ones
(pays a fan's referrer, referral expires after 12 months, both referrers
get paid when both sides were referred); full suite (56 tests) passes
against the real local Postgres+Redis, not just typecheck.

Not changed: the referral *rate* (5%) and *window* (12 months) stay the
same for both sides -- no ask to make fan-referrals pay differently than
creator-referrals. This is server/-only (the ledger stack, not yet
deployed) like every other money-logic feature in this file.

## Second mirror-brand domain: exploring names, decision not made (2026-09-16)

Founder is talking with a buddy about buying a **second domain under a
different, more mainstream-sounding name**, as a mirror of the same
platform -- **keeping onlyass.fun too**, not a rename/replacement (a true
rename was already declined earlier, see Branding section above; this is
a different idea: an *additional* front door). Reasoning discussed: this
won't unlock Google/Meta/TikTok ads by itself (they review actual site
content, not just the domain name -- same finding as the original
branding discussion), but it's still useful for press/App
Store/discretion (something safe to share that doesn't immediately out
what the platform is).

Brainstormed name candidates on request (both "Only___"-pattern and
totally-different one-word options -- OnlyVault, Flaunt, Crave, etc.) --
**no name has been picked yet**, founder's buddy is also throwing out
ideas. Nothing to build until a name + domain are actually chosen. When
one is: set up as a real mirror (same backend/data, second domain pointed
at the same deployment or a near-identical branded build), not a
from-scratch second product.

## MVP launch scope + audit (2026-09-16)

Explicit scope call for "tomorrow's" launch: **launchpad + creator
accounts + fan accounts + marketplace working, nothing else added.**
Everything else already built this session (VIP burn, referral, creator
NFT drops, V4 launchpad, chat pay-per-message, etc.) stays exactly where
it already was flagged -- roadmap/audit-track, not needed for tomorrow,
per the founder's own earlier explicit reminder. Audited all four areas
before touching code (three parallel research passes covering the
launchpad/contracts side, creator+fan account flows, and the
marketplace) rather than guessing at what needed fixing. Findings and
what came of them:

- **Launchpad isn't actually this repo's code.** The "Join Auction"
  button on the live site links out to a third-party platform,
  **Kekfun.xyz**, which is running $ONLYASS's real fair-launch auction --
  confirmed via `contracts/ONLYASS_LAUNCH.md`. There's no auction
  contract in this repo to build or fix; `OnlyAssLaunchpad`(V2)/`V4` are a
  *different* system (creators launching their own tokens), correctly
  already scoped as roadmap/audit-track, not this. What's actually
  outstanding is non-engineering: confirming Kekfun's auction genuinely
  closed and the pre-computed token address
  (`0x991F465b9852f55722EdFb947cD1D130974c785b`, already sitting in
  `NEXT_PUBLIC_CONTRACT_ADDRESS`/`NEXT_PUBLIC_LAUNCHPAD_URL` in
  `.env.local`) really has code on it --
  `scripts/verify-onlyass-deployment.js` does this in ten seconds, but
  needs `ROBINHOOD_RPC_URL` (a real RPC endpoint for Robinhood Chain,
  chain 4663) which isn't set anywhere in this repo and wasn't guessed
  at/fabricated (couldn't find an official public one on
  docs.robinhood.com/chain either) -- **founder needs to supply this, or
  just confirm the address directly on a block explorer.** Also confirm
  the same `NEXT_PUBLIC_*` values are actually set in the real Vercel
  production env, not just local `.env.local`.
- **Marketplace: browse/list side is real and works, buying does not
  exist yet.** Listing creation, photo/video upload (real Vercel Blob),
  browsing, and search all function end-to-end against real persisted
  data. The "Buy" button is an intentional, honestly-labeled no-op --
  clicking it just shows a "check back soon" toast, there is no payment
  processing of any kind wired up (no Stripe, no crypto rails) for
  marketplace purchases. This is not a bug to patch by tomorrow, it's an
  entire unbuilt payment integration -- **decision needed from founder:
  ship marketplace as browse/list-only tomorrow** (matches what the UI
  already honestly says) **or explicitly pull it from tomorrow's
  scope.** Not treated as silently "working" either way.
- **Creator/fan accounts: signup, login, session, dashboard, profiles,
  favorites, search all genuinely work end to end** -- traced, no broken
  references found. **One real bug, now fixed** (see commit
  "Fix launch-blocking bug: seed creators could permanently merge with
  real ones"): `lib/creators-store.js`'s `getCreators()` falls back to
  the hardcoded demo roster (`data/creators.js`) whenever the Vercel Blob
  manifest doesn't exist yet, and every creator-mutating call persists
  that whole fallback list back to the blob on the very first write --
  so the first real signup/edit would have permanently merged fake demo
  creators into live production data with no way to separate them
  afterward except wiping everyone via `/api/admin/delete-all`. Fixed by
  tagging every seed creator with `seed: true` and splitting delete-all
  into "delete real creators" (default) vs. an explicit
  `includeSeed=true` full wipe.
  - **Two things founder/Vercel access needs to confirm, not
    code fixes**: (1) ~~set an explicit `SESSION_SECRET` env var in Vercel
    production~~ -- **DONE 2026-09-17, founder set it as a Secret and
    redeployed.** Before that it silently fell back to reusing
    `ADMIN_UPLOAD_KEY` (the admin-panel bearer key) as the session-signing
    secret, coupling two unrelated trust boundaries.
    (2) Confirm `BLOB_READ_WRITE_TOKEN` is actually set
    in the real Vercel production env -- every account/profile/upload/
    message/favorite/wall write silently depends on it and it's not
    visible from inside this repo checkout.
  - **Flagged, not changed:** `pages/become-creator.js` ->
    `/api/creator/submit.js` is a second, entirely separate
    creator-onboarding path that creates a pending creator profile with
    **no login-capable user account at all** -- disconnected from the
    real signup.js flow. Founder needs to say whether this page should
    even be live for tomorrow, since going through it doesn't get you an
    account you can log into.

## Payment-circumvention filter for chat/wall/bio (shipped 2026-09-16)

Direct ask: block creators from routing fans to Cash App/Venmo/Zelle/a
phone number/email to dodge the platform's cut -- a well-known real
problem on OnlyFans/Fansly, not hypothetical. Also asked, in the same
message: does OnlyFans charge creators anything (e.g. a premium-account
fee)? **No** -- OnlyFans is 100% commission-based (their standard 20% cut
of everything a creator earns), no account fee of any kind, so there's no
existing "pay for a perk" precedent to model this on.

**Explicitly decided: no paid bypass.** Floated whether a $20/month
premium tier should let a creator skip this filter -- decided against it:
a paid way around your own revenue-protection system just means anyone
can pay to freely dodge the 10% fee, which defeats the point of building
it. The filter (`lib/payment-circumvention-filter.js`) applies to every
creator and fan equally, no tier exemption, ever. Don't add one without
this being explicitly revisited.

Shipped on the live Next.js site (not server/, since this is a
content-moderation feature with no ledger dependency): flags Cash
App/Venmo/Zelle/PayPal/Apple Pay/Google Pay/Chime/Western
Union/MoneyGram mentions, Cash App-style `$cashtag` patterns, phone
numbers, and email addresses. **Deliberately does not flag crypto wallet
addresses** (`0x...`, `bc1...`) -- unlike a typical fiat-only OnlyFans
clone, this platform's own tipping is denominated in $ONLYASS, so wallet
addresses show up in completely legitimate on-platform conversations
here; flagging them would block real platform use, not stop
circumvention. Wired into every free-text surface a creator/fan writes
to that reaches another person or the public: DM sends
(`pages/api/messages/send.js`), wall comments
(`pages/api/wall/post.js`), and creator bios
(`pages/api/me/profile.js`) -- bio was added on top of what was asked
("chat features") since a creator's public bio is actually the most
visible, permanent place to drop a Cash App handle, not just DMs.

A match blocks the send outright (not a silent redact -- the sender gets
a clear reason) and logs it to `lib/violations-store.js` (new, mirrors
the existing `reports-store.js` Vercel Blob pattern) for admin review.
New **VIOLATIONS** tab in `/admin` lists flagged attempts with
dismiss-as-false-positive / confirm actions, mirroring the existing
REPORTS tab. Not built: any automatic consequence (mute/ban) after N
confirmed violations -- flagged attempts just sit in the admin queue for
a human to act on for now; automating escalation is a reasonable next
step but wasn't asked for.

## State age-verification laws: geoblock shipped as stopgap, real vendor in progress (2026-09-16)

Asked directly: does the existing "I am 18+" checkbox cover the state
laws requiring age verification for adult content? **No, and said so
plainly.** These laws exist specifically because self-attestation was
already the status quo being legislated against -- a checkbox asking
"are you in Texas?" has the identical defect as the age checkbox, and
arguably looks worse in enforcement (shows you knew about the law and
chose a method that doesn't work). Texas's version was upheld by SCOTUS
in *Free Speech Coalition v. Paxton* (June 2025, 6-3) -- not a gray area.

**27 states currently have an enacted, in-effect law** (cross-checked two
sources, both agreed exactly): AL, AR, AZ, FL, GA, ID, IN, IA, KS, KY,
LA, MS, MO, MT, NE, NC, ND, OH, OK, SC, SD, TN, TX, UT, VA, WV, WY. None
currently blocked by a court. This list grows regularly -- re-check it
periodically, don't treat it as permanently fixed.

**Shipped tonight: geoblock these 27 states outright** (`proxy.js` --
Next.js 16 renamed `middleware.js` to `proxy.js`/`export function
proxy()`, matches the "Proxy (Middleware)" line in build output). Uses
Vercel's free edge geo headers (`x-vercel-ip-country`/
`x-vercel-ip-country-region`) -- no third-party geo-IP vendor needed.
Blocked visitors get rewritten to `/blocked-region`, which explains why
and says identity verification is being worked on. Exempts
`onlyass.xyz` (crypto/token landing) and `onlyass.online` (the SFW
warning gateway) since neither shows adult content and blocking them
would cost token-marketing reach for zero compliance benefit --
everything else (main platform, marketplace, preview/vercel.app URLs,
any future custom domain) is blocked **by default**, not allowlisted, so
a new domain added later doesn't silently skip the check. Tested locally
by spoofing the Vercel geo headers against `next dev` (confirmed the
right page bundle serves per state, confirmed no redirect loop on
`/blocked-region` itself) since there's no way to trigger real
geo-headers outside actual Vercel edge infra.

**This is explicitly a stopgap**, not the fix -- lift each state's block
once real verification is live for it, don't leave the block list frozen
forever once a vendor's wired up.

**Vendor research for the real fix, in progress (founder starting the
process now):** Yoti -- the vendor originally being looked at -- does
**not publish pricing anywhere**; it's enterprise-sales-only, a call is
unavoidable to get a number. Two adult-industry-relevant alternatives do
publish real pricing, found so a comparison exists before that call:
**AgeChecker.Net** -- $25/mo base + $0.50 per *accepted* verification
(free if someone's declined or abandons), unlimited sites per account,
no contract, cancel anytime, volume discounts available.
**TrueCheck** -- $24.95-$49.95/mo "Business" tier (regional compliance
included) or custom Enterprise for high volume. VerifyMy (the other
adult-specific one flagged earlier) also doesn't publish pricing, same
enterprise-quote pattern as Yoti.

**Telegram: link received, added 2026-09-16** -- `https://t.me/creatorsfirst`,
in the homepage footer and on `/blocked-region` (a "join for updates" button
for geoblocked visitors instead of a dead end).

**Decided: going with AgeChecker.Net.** Founder pasted their customer ToS
before accepting -- reviewed it plainly (not a lawyer): it's a normal
boilerplate B2B SaaS contract, nothing predatory, but it explicitly does
**not** protect against the thing the founder is actually worried about --
Section 12.2 disclaims that verification results are "sufficient for
Customer's legal obligations," and Section 13.1/13.2 explicitly excludes
regulatory penalties from damages and caps AgeChecker's total liability at
fees paid in the last 12 months (likely a few hundred dollars/year at this
volume). If their check somehow fails and a state fines the platform, that
fine is entirely the platform's to eat -- true of every vendor in this
space at any price, not unique to AgeChecker, but worth being clear-eyed
about. Concrete follow-up flagged: get AgeChecker's support to confirm **in
writing** that their ID-upload + database-match methods satisfy the
specific named state statutes -- the contract itself won't give that
assurance (Section 4.8 explicitly puts that determination on the customer).

**Important, don't get this wrong later: AgeChecker.Net has a FREE "Age
Gate" product that is NOT real verification** -- confirmed directly on
their own site, it's the identical self-attestation popup/checkbox already
ruled insufficient earlier tonight, and their own marketing admits "an age
gate alone will not prevent underage sales." Only their **paid** Age
Verification API (the $25/mo + $0.50/check one) does real
verification (database cross-reference + photo ID fallback). Don't
integrate the free Age Gate thinking it covers the state-law requirement.

**Not yet built: the actual integration.** AgeChecker's real API docs
(endpoints, auth, request/response shape) are gated behind creating an
account -- their public marketing pages only show placeholder
screenshots, so nothing was guessed at. Waiting on the founder to create
the account and share either the real API docs or an API key + website ID
before writing integration code against `proxy.js`'s geoblock. Once that
lands: wire the actual verification flow in, then start lifting states off
`BLOCKED_STATE_CODES` in `proxy.js` as each one gets covered.

**Shipped now, doesn't need to wait on the API integration:** `pages/privacy.js`
Section 1 and Section 6 updated to disclose that fan age-verification data
goes to AgeChecker.Net for states that require it -- AgeChecker's own
contract (Section 4.3) requires this disclosure exist before data
collection starts, so it's in place ahead of the integration rather than
added after the fact.

## AgeChecker.Net integration: built for real against actual docs (2026-09-17)

Founder created and paid for an AgeChecker.Net account, then pasted both
the real Client API docs and Server API docs -- built the actual
integration against them, nothing guessed at:

- `pages/verify-age.js` -- loads AgeChecker's popup widget (documented for
  a checkout button, adapted here to a "Verify Age & Continue" button on a
  dedicated site-entry gate page) against `NEXT_PUBLIC_AGECHECKER_KEY`.
  Shows a "still being set up" message instead of a broken widget when
  that env var isn't set yet.
- `lib/age-verification.js` -- signed `oa_age_verified` cookie proving a
  visitor passed verification, written with the Web Crypto API (not
  Node's `crypto` module) so the identical code runs in both API routes
  (Node) and `proxy.js` (Edge runtime, can't use Node's crypto).
- `proxy.js` -- checks that cookie before applying the state geoblock; a
  valid signature lets the visitor through regardless of state, missing
  or forged ones still route to `/blocked-region` as before. Verified
  locally by forging both a garbage cookie (stayed blocked) and a
  correctly-signed one against the real local session secret (bypassed).
- `pages/api/age-verify/confirm.js` -- **the actual security-critical
  piece**: the client popup's "accepted" callback alone is bypassable
  (fakeable from devtools), so this calls AgeChecker's real
  `GET /v1/status/:uuid` endpoint server-side (authenticated with
  `AGECHECKER_SECRET_KEY`, never exposed client-side) and only sets the
  cookie if AgeChecker's own server confirms `status: "accepted"`. Also
  checks the verification's echoed domain key matches ours so a UUID
  minted for a different site/account can't be replayed here. Tested
  against AgeChecker's real (not mocked) API with placeholder credentials
  to confirm the request/error-handling path actually works end to end
  before real credentials existed.

**Still needed to go fully live:** set `NEXT_PUBLIC_AGECHECKER_KEY` (the
website/domain key) and `AGECHECKER_SECRET_KEY` (the account secret) in
Vercel's production env. Until both exist, `/verify-age` shows the
"still being set up" state and the confirm endpoint stays a clean 501 --
intentionally, so nothing broken shipped ahead of real credentials. Once
set: test the real flow end to end, then start removing states from
`proxy.js`'s `BLOCKED_STATE_CODES` one at a time as each is confirmed
working, rather than lifting the whole block at once.

Also learned along the way, worth remembering: AgeChecker has a
**separate free "Age Gate" product that is pure self-attestation** (their
own marketing admits "an age gate alone will not prevent underage
sales") -- only their paid Verification API (what's now wired in above)
does real verification. Don't ever route back to the free one thinking
it's equivalent.

Founder forwarded two PDFs AgeChecker emailed them (a "How It Works" brief
and a sales deck) -- two things from those worth keeping:

1. **Confirms the site-entry-gate approach (not just checkout) is a
   real, documented AgeChecker use case**, not a hack: their deck
   explicitly shows using it "as a qualifying step before new customer
   registration or account creation" with the same DOB/name/address
   flow. `pages/verify-age.js`'s approach is exactly this pattern.
2. **AgeChecker's dashboard has real per-state rule configuration** --
   block location, require photo ID, require e-signature, custom minimum
   age, down to county/zip in some states -- "industry-specific profiles,
   which we update as laws change so you don't have to." **Not yet
   configured on the founder's account.** Without it, every state gets
   the same generic instant-DOB-match check by default. Recommended the
   founder (or have me walk them through it) set explicit rules for the
   same 27-state list `proxy.js` blocks -- e.g. some of these state laws
   may warrant requiring photo ID outright rather than accepting the
   softer instant-database-match method. Not done yet, needs a decision
   on a per-state strictness level, not just a technical wire-up.

Still true, unchanged by these docs: no explicit written confirmation
anywhere that AgeChecker's method satisfies each specific named state
statute -- that's still worth asking their support directly, separate
from marketing material.

## AgeChecker.Net went fully live (2026-09-17)

Founder created the account, added `onlyass.fun` as the website, saved
both credentials to Vercel production
(`NEXT_PUBLIC_AGECHECKER_KEY` = the domain key,
`AGECHECKER_SECRET_KEY` = the account secret), redeployed, and confirmed
a real verification through the popup actually works end to end.
Verified from this session's side too: the real API key and widget
script are baked into the production JS bundle for `/verify-age`, and
`/api/age-verify/confirm` is live and actually reaching AgeChecker's API
(no longer the 501 "not configured" stub).

Along the way, fixed an unrelated but real security finding while in
the same Vercel settings page: `BLOB_READ_WRITE_TOKEN` had been saved as
the plain "Config" env var type instead of "Secret," making its value
visible in plaintext to anyone on the Vercel team -- founder rotated it
and re-saved as Secret. Not a public leak, just tightened internal
visibility.

**Decided: no selfie-with-ID for now, review again later.** Founder
noticed the flow only does the instant DB/name/address/DOB match plus a
photo-ID fallback if that fails -- no selfie-matching. Confirmed that's
correct: "Take Selfie with ID" is a separate opt-in toggle in
AgeChecker's dashboard (seen unchecked in earlier screenshots), off by
default. Decided to leave it off for now -- the account's already set to
a stricter-than-required 21+ default and the DB-match is a real check,
not self-attestation, so this is a reasonable starting point, not a
compliance gap. **Treating this first month as a trial** (AgeChecker has
no contract anyway, cancel anytime) -- worth revisiting whether to
enable selfie-matching once there's real usage data, not a permanent
decision made once and forgotten.

## Pre-launch security audit + fixes (2026-09-17)

With launch imminent ("goin live in few hours"), ran two comprehensive
Workflow-orchestrated audits (Ultracode on) -- one over the live site
(`pages/`, `lib/`, `proxy.js`), one over `server/`+`contracts/` -- each with
parallel dimension-finders, adversarial 3-vote verification per finding,
then a synthesis pass. Live site: 30 confirmed findings. Server/contracts:
14 confirmed findings (explicitly NOT launch-blocking, that stack isn't
deployed yet).

**All 4 live-site MUST-FIX items are now fixed, verified against a real
`next dev` server with spoofed Vercel geo headers/cookies (not just read
over)**:

1. **Creator payout/wallet data + pending applicants' private emails were
   leaking to every visitor via unfiltered SSR props.** `getServerSideProps`
   in `pages/index.js`, `search.js`, `onlyass.js`, `favorites.js`, and
   `creator/[id].js` were spreading the full internal creator record
   (including `walletAddress`, `payoutMethod`, and -- for pending
   applicants -- `contactEmail`) straight into `__NEXT_DATA__`, visible to
   anyone via page source, no login needed. Added `toPublicCreator()` in
   `lib/creators-store.js` (strips those 3 fields) and applied it at every
   public-facing prop return; `dashboard.js` (creator's own data) and
   `admin/*` (admin-key gated) intentionally keep full records. Also fixed
   `creator/[id].js` specifically lacking the `status !== 'pending'` filter
   the other pages had (any pending applicant's profile, including their
   email, was reachable by walking `/creator/<id>`) -- now hidden from the
   public, visible only to the applicant themselves once they've claimed a
   login.
2. **Two real ways to skip the state age-verification check, both in
   `proxy.js`, both fixed:**
   - `onlyass.online`/`onlyass.xyz` were exempted from the check for
     *every* path on those hostnames, not just the root (which is what
     actually gets rewritten to the SFW landing page) -- e.g.
     `onlyass.online/creator/5` served the real, ungated creator page since
     Next.js routes by pathname regardless of host. Narrowed the exemption
     to root-path-only for those hosts (`isSfwRoot`), and separately
     exempted `/gateway` and `/token` by path (so those two SFW pages stay
     reachable from any hostname, matching original intent) alongside the
     existing `/blocked-region`/`/verify-age` gate paths.
   - The proxy's `matcher` excluded `images/` and `videos/` entirely, but
     real creator content (seed demo photos/videos -- confirmed genuinely
     adult, e.g. `content_lingerie_*.jpg`) is served directly from those
     paths on the same domain with zero gating. Removed that blanket
     exclusion so those paths go through the age check like any other page;
     kept `icons/` excluded (pure UI chrome, confirmed no content in it) and
     added a narrow exemption for `/images/logo-final.png` specifically
     (the brand logo the gate pages themselves render, which would
     otherwise break on `/blocked-region`/`/verify-age`). Verified with
     curl against spoofed headers: a blocked state can no longer load
     `/images/content_lingerie_1.jpg` directly (now gets the blocked-region
     HTML instead of the raw file), the logo still loads, and a valid
     verification cookie still bypasses everywhere it should. Real
     creator-uploaded content lives on Vercel Blob (a different origin
     entirely) and can't be gated by this proxy at all -- that's a separate,
     harder, not-yet-built problem (same "needs its own serving/gating
     endpoint" shape as the NFT-drop blur-until-purchased gap noted
     earlier in this file), not something this fix covers.
3. **`SESSION_SECRET` was never actually set -- silently reusing
   `ADMIN_UPLOAD_KEY`** (the admin panel password) to sign both login
   sessions and the age-verification cookie, coupling two unrelated trust
   boundaries. Fixed locally by generating a real secret into `.env.local`
   (gitignored, never committed).
   **RESOLVED 2026-09-17: the founder set `SESSION_SECRET` in Vercel
   production as a Secret-type variable and redeployed.** Nothing further
   is needed here.

   **Do not re-raise this as an open item.** It was reported as still
   outstanding again on 2026-09-18 purely because this file said so, hours
   after the founder had already done it -- an audit agent read the stale
   note and repeated it as a live finding, and it was relayed without being
   checked against what the founder had already said. There is no tool
   access to Vercel env vars from here, so this file IS the record: if a
   future pass wants to flag it, confirm with the founder first rather than
   trusting the paragraph above.
4. **Marketplace listing titles/descriptions and creator display
   name/handle completely skipped the payment-circumvention filter**, even
   though the bio field right next to them was already checked -- the two
   most visible fields on the site, the first place someone would try to
   slip a Cash App handle through. Wired `detectPaymentCircumvention` into
   `pages/api/me/profile.js` (now checks `name`/`handle`/`bio`, was
   bio-only) and into `pages/api/marketplace/create.js` and `update.js`
   (now checks `title`/`description`), same pattern/violation-logging as
   the existing message/wall/bio checks.

**Not done, explicitly deferred as SHOULD-FIX-SOON not launch-blocking**
(full list relayed to founder, not re-litigated here): payment filter is
beatable via spacing/homoglyphs; admin profile editor and the old
become-a-creator form skip the filter entirely; social links aren't
filtered; a concurrent-upload race can silently drop a file; a failed
signup can leave a ghost pending application; deleting a creator via admin
doesn't clean up their login account; admin-key comparisons aren't
timing-safe; a handful of nav gaps. None of these expose data or let
anyone dodge a fee/age-check on their own -- lower urgency than the 4 above.

**Server/contracts findings (14 confirmed, not deployed, not launch
scope) intentionally NOT fixed in this pass** -- flagged to founder for
later prioritization: a referral-payout combo in `ledger.ts` that can mint
more than the platform's fee collected; a one-of-a-kind marketplace
listing sellable twice; a no-bid auction double-refund; paid message text
readable free from the inbox preview; VIP burn discount gameable via price
timing; a launchpad volume-gaming exploit on the graduation-bonus pool.
Tracked here so they don't get lost, not urgent since none of `server/` is
deployed yet.

## AI/deepfake content policy: fact-checked the wrong claim, found the real one (2026-09-17)

Asked to check whether OnlyFans really enforces a specific-sounding AI
content policy (mandatory per-post labeling with a warning-then-suspension
ladder; deepfakes get an immediate permanent ban + frozen payouts +
forfeited earnings + law enforcement referral). Ran a Workflow-orchestrated
research pass (4 parallel research agents against real sources, not
guessed at) before building anything, since this exact kind of
confident-sounding "here's what OnlyFans does" claim had already turned
out to be wrong once earlier this session (the age-verification-checkbox
question).

**The claim is fact-checked as false/exaggerated.** OnlyFans's real ToS
does require AI content labeling and does ban non-consensual deepfakes,
but the specific "warning then suspension" two-strike system doesn't
exist anywhere in their docs (their own terms say the opposite -- they can
act without warning for serious/repeated violations), and no OnlyFans
document states the specific "permanent ban + frozen payouts + forfeited
earnings + law enforcement referral" bundle. Traced the likely source to a
cluster of SEO/creator-management blog posts making the same
specific-sounding claim with zero citations to any real OnlyFans page.

**The actually important finding, unrelated to the OnlyFans claim: the
federal TAKE IT DOWN Act.** Signed into law May 2025. Requires any
platform hosting user-posted content -- no small-platform exception -- to
run a notice-and-removal process letting someone report non-consensual
intimate content (including AI-generated/deepfake) about themselves and
get it removed within 48 hours. The compliance deadline was **May 19,
2026, already four months past as of this research**, with active FTC
enforcement since (penalties up to ~$53k/violation). This platform had
*no* such process. Everything else researched (DEFIANCE Act, state
deepfake laws, AI-labeling laws like California's AB 3211 which never
actually passed) turned out to bind either the individual creator or
platforms far bigger than this one -- not a binding requirement here right
now.

**Built immediately, since this is overdue law rather than a policy
debate:**
- `pages/report-content.js` + `pages/api/report-content.js` -- a public,
  unauthenticated "I appear in this content and didn't consent" form
  (name, contact, where the content is, an explicit consent statement).
  Deliberately no login required -- someone reporting themselves as a
  victim shouldn't need a platform account to do it.
- `lib/ncii-reports-store.js` + `pages/api/admin/ncii-reports*.js` + a new
  **TAKEDOWN REQUESTS** tab in `/admin` (mirrors the existing
  Reports/Violations panels) -- sorted oldest-first (not newest-first like
  the others) since these carry a 48-hour legal clock, with a visual
  overdue flag at 36h/48h open.
- `pages/terms.js` Section 7/8 and `pages/privacy.js` -- plain-language AI
  labeling requirement, non-consensual-AI-content ban, and a real
  notice-and-removal section describing the 48-hour process and linking
  to the report form (the law requires this be posted "clearly and
  conspicuous," not just exist).
- `proxy.js` -- added `/report-content` to the paths exempt from the
  state age-verification geoblock. Caught this in testing: without the
  exemption, a visitor in a blocked state couldn't reach the takedown
  form without first passing age verification, which would have
  defeated the "freely accessible" requirement the law itself imposes.
- Footer links on `pages/index.js` and `pages/onlyass.js` (onlyass.js had
  no footer link list at all before this).
- An "AI-generated" checkbox at creator content upload
  (`pages/api/me/upload.js`, `pages/api/admin/upload.js`,
  `pages/dashboard.js`) and at marketplace listing creation
  (`pages/api/marketplace/create.js`/`update.js`,
  `lib/listings-store.js`, `pages/dashboard.js`) -- self-reported, not
  detected, matching what the report identified as realistic/cheap
  (automatic AI-content detection is neither reliable nor required).
  Shows a small "AI" badge wherever that content displays
  (`pages/creator/[id].js`, `pages/marketplace.js`).
- `pages/token.js` roadmap corrected: age verification was still marked
  "planned" there even though AgeChecker went fully live yesterday --
  fixed to "live," and the takedown-process line split into what's now
  actually live (NCII/TAKE IT DOWN reporting) vs. still not built (the
  18 U.S.C. §2257 statement, a separate requirement).

**Deliberately not decided/built, left as manual admin review:** the
exact enforcement ladder for repeat labeling violations (permanent ban on
first confirmed deepfake? does forfeiture claw back already-paid-out
money?) -- the research's own recommendation was that a human-reviewed
queue with logging satisfies the law without locking in specifics not yet
committed to. Also not built: automatic AI-content detection (unreliable,
not legally required).

**Incidental fixes made while in these files, unrelated to the above but
worth noting:** `pages/dashboard.js` and `pages/admin/index.js` were still
displaying the old 4/10 gallery-slot limit in the UI (a leftover from the
50/200 cap change earlier this session that only updated the actual
server-side enforcement in `pages/api/me/upload.js`, not these two
display-only labels) -- both now correctly show 50/200.

## Content-violation enforcement ladder decided and built (2026-09-17)

Direct decision on the one thing left open from the TAKE IT DOWN Act work
above: **first confirmed violation of the AI-labeling or non-consensual-
content rules = 30-day account suspension; second = permanent ban and
forfeiture of any money owed that hasn't already been paid out.**

Built into `lib/creators-store.js`: `applyContentViolation(creatorId)`
increments a `contentViolationCount` on the creator record and sets
`status`/`suspendedUntil` per the ladder; `effectiveCreatorStatus()`
auto-lifts a suspension once `suspendedUntil` passes (no cron needed,
every check just compares against the clock) so nobody has to remember to
manually reinstate someone; `isPubliclyVisible()` is the one place that
now decides whether a creator shows up anywhere public, replacing the
scattered `status !== 'pending'` checks across `index.js`, `search.js`,
`onlyass.js`, `favorites.js`, and `creator/[id].js` (all switched to it,
plus `creator/[id].js` also fully hides a banned creator's profile even
from themselves, unlike suspended/pending which the owner can still
preview).

**Enforcement is wired to the actual trigger, not automatic on every
report:** admin resolving a takedown request as "removed" in the new
TAKEDOWN REQUESTS panel can optionally attribute it to a specific creator
account first (a picker was added since NCII reports only capture a free-
text description of where the content is, not a structured creator link)
-- only when attributed does resolving it call `applyContentViolation`
and show the resulting suspension/ban in the admin UI. Left as a manual
per-report choice rather than automatic because not every valid report is
necessarily that account's own doing (a hijacked account, a comment vs. a
post, etc.) -- admin's call each time, not guessed at.

`lib/require-creator-owner.js` (the gate every creator-content-mutating
endpoint already goes through -- profile edits, uploads, listing create/
update) now rejects a suspended or banned creator outright with a clear
reason, so the restriction is enforced server-side regardless of what the
dashboard UI shows. Dashboard UI updated to match: a clear suspended/
banned notice with the reinstatement date, and the Save Profile/Upload/
Create Listing controls disabled client-side too (belt-and-suspenders,
not the actual security boundary -- that's server-side).

**The "forfeit funds" half is honest about what's actually enforceable
right now, not pretending otherwise:** this live Next.js site has no
custodial balance at all -- every payment is a direct wallet-to-wallet
on-chain transfer (per Terms of Service Section 5), settled and
irreversible the moment it confirms, so there is nothing here for a ban to
literally seize. A banned creator's consequence on *this* stack is
entirely the visibility/posting lockout above. Real fund forfeiture only
has something to act on once `server/`'s ledger (which does hold a real
balance) is the one actually taking payments -- not built there yet,
flagged as a real follow-up whenever that stack deploys, not something to
fake here. Terms of Service Section 7 states the ladder in plain language,
including this same "hasn't already been paid out" scoping rather than
overpromising a seizure that isn't technically possible against completed
on-chain payments.

Admin's creator editor also got manual `suspended`/`banned` status
options (for hand-adjusting outside the automatic ladder -- e.g.
reinstating someone early) and a violation-count/suspension-date readout,
consistent with how `status` was already hand-editable there.

## Full fresh-eyes re-audit + critical fixes (2026-09-17)

After a real production bug (uploads silently overwriting each other,
traced to a stale-client-snapshot pattern) slipped past the earlier audit
pass, explicit direction: re-audit the ENTIRE repo with no assumptions
carried over, as if seeing it for the first time. Ran a much larger
Workflow pass -- 9 finder agents covering every page, every API route,
every lib file, `proxy.js`, all of `server/`, and all of `contracts/`,
each explicitly told not to trust prior conclusions and to read full
files, not skim -- then adversarially verified every finding 3 ways.
62 raw findings, 59 confirmed. Fixed the live-site critical ones
immediately rather than just reporting them:

**Age verification could be faked with an ordinary login cookie.** The
single worst finding. `lib/session.js`'s login-session token and
`lib/age-verification.js`'s age-verification token used the identical
root secret and an identical HMAC scheme, with no field distinguishing
one token type from the other -- copying a real `oa_session` cookie
value into the `oa_age_verified` cookie slot was accepted as proof of
real age verification, completely defeating the 27-state geoblock.
Fixed with two independent layers, either of which alone would have
closed it: each token type now signs with its own key, derived from the
shared root secret via HMAC with a distinct context string
(`oa:session:v1` vs `oa:age-verification:v1`), and each payload now
carries an explicit `typ` field that verification checks. Verified both
directions locally: a genuine token of one type is now rejected when
replayed as the other, while each type's own legitimate round-trip still
works.

**Wall comments and DMs were leaking real email addresses.**
`lib/users-store.js`'s `displayNameFor()` always fell back to the
local-part of `user.email` since no user ever actually had a
`displayName` field set -- meaning every creator (real email required)
and every fan who opted into a real email (vs. the anonymous-username
option) had a fragment of their real address shown publicly on every
wall comment and DM. Fixed: a creator now shows their real public
creator name; a fan's stored value is only shown as-is when it has no
"@" (meaning it genuinely is the plain username they chose to be shown
by, not a real address). Same fix applied to the independent, separate
leak in `pages/api/messages/conversations.js`'s inline fallback.

**A live, fully-functional endpoint could create real marketplace orders
for $0.** `pages/api/marketplace/orders/create.js` was built ahead of
real payment capture (its own comment said so) but was directly callable
by anyone logged in -- including creating a real physical order with a
real shipping address, having paid nothing. Closed with a 501 until
payment actually exists to call it first.

**A signup timing race could log one person into a different person's
account.** `lib/users-store.js`'s `createUser` computed new account IDs
as "highest existing + 1" -- two signups landing close together could
compute the same ID and end up sharing a login-session identity. Fixed
with `crypto.randomUUID()` instead of a sequential counter; every ID
comparison in the codebase already does `String(a) === String(b)`, so a
non-numeric ID is a safe drop-in.

**Hardcoded fallback secret was a live risk for any future
misconfigured deployment.** `lib/session.js` and `lib/age-verification.js`
both fell back to a secret hardcoded in the source (`'only-ass-dev-secret'`)
if neither real env var was set. Today's production is correctly
configured so this wasn't actively exploitable, but a future mirror site
or fork that didn't inherit the same env vars would have silently
accepted a publicly-known secret. Now production refuses to start
(throws loudly) instead of silently falling back; the hardcoded value
only applies to local dev.

**A hidden creator's internal account ID was still leaking, and
Marketplace/Search forgot to hide suspended/banned creators.**
`pages/creator/[id].js` correctly nulled the `creator` prop for a
pending/suspended/banned profile but still separately leaked
`creatorUserId` from a stale closure variable -- fixed to re-derive it
from the post-check `creator`. `pages/marketplace.js` and `pages/search.js`
both resolved a listing's creator against the *unfiltered* creator list
instead of `isPubliclyVisible()`, so a suspended/banned creator's real
name and photo kept showing on their listings -- both fixed to match
every other public page's behavior.

**The upload-limit bypass was the exact same bug class as the fix from
earlier tonight, just missed in a second spot.** `pages/api/me/upload.js`'s
50/200-slot check used the client-sent `x-current-gallery` header's
length instead of the real server-side gallery length -- sending an
empty array bypassed the limit entirely, for anyone. Fixed to use the
fresh server value, matching the fix already applied to the store layer.
Also fixed: the gallery-delete button (dashboard and admin) had no
`disabled={busy}` guard, so two quick clicks could delete the wrong
photo -- same missing-disable pattern as the original upload race.

**The systemic "read full file, write full file, no synchronization"
pattern got a real, general fix -- not a punt.** The earlier session's
fix for gallery uploads only addressed *client*-supplied stale data; a
genuine *concurrent-request* race (two people sending a message, filing
an NCII report, etc. within milliseconds of each other) was still
possible in at least 9 other stores, one of which (`ncii-reports-store.js`)
carries real legal exposure under the TAKE IT DOWN Act's 48-hour clock.
Checked whether a real fix was actually possible before writing anything
off as "needs a full database migration" -- it was: Vercel Blob's `put()`
supports a documented `ifMatch` option (conditional write against the
blob's current ETag, throwing `BlobPreconditionFailedError` on a
mismatch). Built `lib/blob-json-store.js`, a shared `readJsonList`/
`updateJsonList` helper implementing real optimistic-concurrency
read-modify-write with automatic retry on conflict, and migrated every
flagged store to it: `creators-store.js`, `listings-store.js`,
`orders-store.js`, `messages-store.js`, `wall-store.js`,
`favorites-store.js`, `reports-store.js`, `violations-store.js`,
`ncii-reports-store.js`, and `users-store.js` (not originally flagged,
same underlying pattern, fixed for consistency). A losing write is now
rejected and retried against the winner's fresh state instead of
silently discarding it, with no database migration needed.

**Not done in this pass, explicitly deferred:** the full SHOULD-FIX list
(login timing/rate-limiting, logout not invalidating sessions, a few
admin-side filter gaps, marketplace edit validation gaps, an overly
aggressive payment-filter false-positive rate) and everything found in
`server/`/`contracts/` (a real money-minting bug in the ledger for
double-referred transactions, a launchpad contract that can be
permanently disabled by anyone for one cheap transaction, and several
smaller issues) -- none of the server/contracts findings are live since
neither stack is deployed, but they're real and tracked here for
whenever that changes.

## This branch deploys straight to production (learned the hard way 2026-09-18)

`claude/ecstatic-ride-g21n07` is not a side branch. Vercel project
`onlyass` (`prj_HqD55c4fAsUZvbogdPGNolLlSxFf`, team
`team_IFiqVIqlnExa5XSzMXjYOWeE`) builds **every push to it with
`target: "production"`** -- confirmed by reading the deployment list, not
assumed. There is no staging step and no preview-then-promote.

**So there is no such thing as a "safe checkpoint commit" here.** Interim
commits made during this session to avoid losing work if the container was
reclaimed went live on onlyass.fun within about a minute of each push, and
were described to the founder as merely saving work -- which was wrong,
because nobody had checked where the branch deployed. Check the deploy
target before calling a push safe.

Practical rule until this changes: **run the real checks before pushing,
not after.** "It parses" and "it typechecks" are not enough for code that
is live on a public adult platform a minute later. The suites that exist
and actually run: `npx next build`; `cd server && npx vitest run` (needs
Postgres + Redis -- `service postgresql start`, `service redis-server
start`, then `npx prisma db push`, all available in this container);
`npx hardhat test` (109 tests); and the plain-node tests
`node --experimental-test-module-mocks --no-warnings --import
./test-register.mjs lib/session.test.mjs` and the same for
`lib/blob-json-store.test.mjs`.

Worth raising with the founder again if it keeps biting: point production
at a stable branch and let this one build previews.

## Two data-loss bugs shipped and were caught by review, not by their author (2026-09-18)

Both were in code written earlier the same night, and both reached
production before anyone noticed. Recording the pattern, not just the
bugs.

1. **`lib/blob-json-store.js` could silently wipe any manifest.**
   `updateJsonList` captured the blob's ETag from `head()`, then read the
   body, and caught *every* read failure in one handler commented
   "manifest doesn't exist yet" -- carrying on with `fallback` as the
   current state. A transient network error, a 5xx, or a truncated body
   during any ordinary write therefore wrote `fallback` over the whole
   file, and the ETag precondition happily matched because nobody else had
   written. Blast radius: every store (accounts, listings, orders,
   messages, wall, favorites, reports, violations, and the NCII takedown
   reports that carry a 48-hour federal clock). For `creators-store`,
   whose fallback is the demo seed roster, it would have replaced every
   real creator with the fake ones -- reopening the seed/real merge already
   recorded above as a launch blocker. Fixed: `fallback` is used ONLY on a
   confirmed not-found; every other read failure aborts the write.
   `lib/blob-json-store.test.mjs` is the regression test -- **its first
   three cases fail against the version that shipped**, so if they ever
   fail again do not "fix" the test.

2. **The not-found check itself was nearly wrong in the same way.** The
   obvious `/does not exist/` message test matches BOTH
   `BlobNotFoundError` ("The requested blob does not exist") and
   `BlobStoreNotFoundError` ("This store does not exist."), so a
   misconfigured or deleted blob store would have read as "no data yet"
   and served the invented demo roster as though those were real people.
   Now `instanceof` only, which can only fail in the safe direction.
   Related: **@vercel/blob's error classes do not set a custom `.name`** --
   it reads `"Error"` on all of them (verified against 2.8.0), so any
   `err.name === 'BlobSomethingError'` check anywhere in this codebase is
   dead code that never matches. Use `instanceof`.

Neither was found by the author re-reading their own work. Both came from
pointing independent hostile reviewers at freshly written code, and one
came from an agent working on a *different* file disagreeing. The standing
lesson: **treat just-written, just-shipped code as the prime suspect in the
next audit, not as the known-good baseline.** Every pass so far has found
real bugs the previous pass missed, and the fixes themselves have
introduced new ones.


## Launchpad removed; token launches later from the founder's own launchpad (2026-09-18)

Direct call: **"Remove launch pad not doing that"**, then **"I'll launch from
my own launch pad once site is ready to go."** Both senses of "launchpad"
were removed from the repo:

- **The creator-token launchpad** -- `OnlyAssLaunchpad`, `OnlyAssLaunchpadV4`,
  `OnlyAssLaunchpadHook`, `HookDeployer`, `LaunchedToken`, the V4 sqrt-price
  library, the V2 interfaces, launchpad-only test helpers, both deploy
  scripts, the hook-salt miner, their tests, `LAUNCHPAD.md`,
  `LAUNCHPAD_V4.md`, and the `launchpad:*` npm scripts. Compiled Solidity
  went from 150 files to 30.
- **The $ONLYASS auction links** -- the "Join Auction" button on `/token`,
  the "Live Auction" card, and the homepage's "Buy $ONLYASS" button. All
  three pointed at `NEXT_PUBLIC_LAUNCHPAD_URL` (the third-party Kekfun
  auction).

**There is deliberately no "buy the token" link anywhere on the site now,
and that is not an oversight to fix.** The founder is launching $ONLYASS
himself, from his own launchpad, once the site is ready. Don't add a
purchase/auction link back, and don't "restore" the Kekfun URL, until he
gives a new destination.

**Knock-on change, made as a consequence rather than a separate decision:**
`OnlyAssPayments.payWithCreatorToken` and the equivalent creator-token
pricing in `OnlyAssCreatorNFT` were removed too. Both existed only to accept
a token a creator had launched *through the launchpad*, verified live
against it -- with no launchpad, no such token can exist, so the check could
never pass. Accepting an arbitrary unverified ERC-20 in its place would have
been strictly worse than removing it. ETH and $ONLYASS payments are
unchanged; both constructors lost their launchpad argument.

**`scripts/deploy.js` was already broken before this** (four arguments to a
five-argument constructor; it would have failed at deploy time). Fixed --
and note the trap, because the obvious patch is the dangerous one:
`OnlyAssPayments` takes its **owner FIRST**, ahead of the platform wallet,
and both are plain `address`, so appending the missing argument instead
compiles, deploys, reverts nothing, and silently hands ownership of the
payments contract to the fee wallet. Unfixable once live.

**Telegram links removed** (`t.me/creatorsfirst`) from the homepage footer,
`/blocked-region` and `/verify-age`.

**Left in deliberately, not an oversight:** `@uniswap/v4-core` and
`v4-periphery` are now unused by any contract, as are
`scripts/postinstall-permit2-link.js` and hardhat's 0.8.26 compiler
override. Pulling dependencies needs a full reinstall to verify, and this
branch deploys straight to production -- not worth the risk mid-session.


## Storage moved from Vercel Blob JSON files to Postgres (built 2026-09-18, IN HISTORY BUT REVERTED ON THE BRANCH TIP)

**READ THIS FIRST -- the code below is written, tested and in git history, but
the branch tip deliberately does NOT contain it.** Commit `afff05f` has the
whole migration; the commit immediately after it reverts it. That is not an
abandoned attempt, it is a hold:

- This branch deploys straight to production. Every store throws without
  `DATABASE_URL`, so deploying the migration before that env var exists takes
  the entire site down.
- Leaving it uncommitted risked losing it -- this container is ephemeral.

So it was committed (preserving the work in the remote) and immediately
reverted (keeping production on the working blob code). Both commits push
together, and Vercel builds only the tip, so production never runs the
Postgres build.

**To bring it back, once `DATABASE_URL` is set in Vercel production:**

    git revert --no-edit <the revert commit>   # re-applies the whole migration
    npm install                                # restores the `pg` dependency

then run `node scripts/migrate-blob-to-postgres.js --apply` and delete the old
blob manifests. Do NOT re-do this by hand -- it is ~1,400 lines across 20
files with 112 passing tests, and re-deriving it would lose the details below.

Blocker as of 2026-09-18: creating the database in Vercel failed with
"Cannot create Database... Your integration is pending deletion." Vercel holds
a removed Marketplace integration for 24 hours before finalising. The
workaround that avoids waiting is to create the database directly at
neon.tech and paste its connection string into Vercel as a plain
`DATABASE_URL` env var -- `lib/db.js` takes any standard Postgres URL and
already handles the SSL managed providers require, so it does not need the
Vercel integration at all.

---


### Why -- a live data exposure, confirmed against production

Every store was a single JSON file in Vercel Blob, read whole and written
whole. Blob objects are served from a **public URL**, the store hostname
appears in every image URL on the site, and the manifest paths were fixed.
So they were world-readable. Verified, not theorised:

    GET https://<store>.public.blob.vercel-storage.com/data/creators.json
    -> 200, two real creator records including walletAddress and payoutMethod

Those are the exact fields `toPublicCreator()` strips from page props -- the
fix from the earlier audit hid them from the page and left the raw file
served. `users.json` (bcrypt password hashes), `messages.json` (every private
DM) and `ncii-reports.json` (takedown victims' names and contact details)
would have been readable the same way the moment they existed. That is the
clock: the exposure was small only because almost nobody had signed up yet.

The second reason was the write model. Read-whole-file/write-whole-file has
no atomicity; the ETag guard bolted onto it narrowed the window without
closing it, and mishandling a failed read wiped a whole manifest once
already (see the section above).

### What was built

`lib/db.js` -- a `pg` Pool, an idempotent `create table if not exists`
schema, `query()` and `withTransaction()`. Ten tables, one row per record,
each record kept as a `data` jsonb column with a real primary key.

**The jsonb shape is a deliberate trade, not laziness.** It fixes both
problems (nothing is served at a URL; a write is a row-level UPDATE) while
leaving every record the same JavaScript object the pages and API routes
already expect -- so the migration did not also become a rewrite of every
caller. Fields that get filtered or sorted on have expression indexes.
Normalise properly later if real queries need it.

Bugs that disappeared as a side effect, rather than being patched again:
- `max(existing id) + 1` id generation, still present in six stores, was the
  same collision class already fixed once for users. Identity columns and a
  sequence now assign ids.
- Login-identifier uniqueness is a unique index on
  `lower(btrim(data->>'email'))`, not a read-then-check. It must keep
  matching `normalizeIdentifier()` in users-store.js -- it trims, so the
  index has to as well, or " a@b.com" and "a@b.com" become two rows one
  lookup matches.
- The whole "a failed read looks like an empty list" hazard is gone: there is
  no list to overwrite.

**Seeding changed meaning.** The blob version fell back to the demo roster
whenever the manifest was missing, so wiping every creator made the fake
demo ones reappear as real. Now seeding happens once, recorded in an
`app_meta` row, so `deleteAllCreators(includeSeed)` leaves an empty site.
There is a test for exactly that.

**`lib/creator-status.js` is new and load-bearing for the build.**
`toPublicCreator`, `effectiveCreatorStatus`, `isPubliclyVisible`,
`sanitizeSocials` and `sanitizeTags` are pure and are used inside React
components, so importing them from `creators-store.js` pulls the Postgres
driver into the client bundle and the build fails outright on `net`/`tls`/
`dns`. Client code must import them from `creator-status.js`;
`creators-store.js` re-exports them for server callers.

Vercel Blob is still used, correctly, for actual file uploads (images and
video). Only the JSON data manifests moved.

### Verified

102 store tests plus 10 session tests, run against a real local Postgres --
not mocks -- including the concurrency cases that used to lose data: 30
simultaneous messages into one conversation, 25 simultaneous takedown
filings, 20 listing-media uploads, 15 gallery uploads, and 10 racing signups
for the same identifier (exactly one wins). `npx next build` clean.

### NOT DONE -- what has to happen before this is real

1. **A Postgres database has to exist.** Vercel -> Storage -> Create
   Database -> Neon, attached to the `onlyass` project, which sets
   `DATABASE_URL`. There is no MCP tool that can provision one.
2. **This commit is deliberately NOT pushed.** The branch deploys straight
   to production, and without `DATABASE_URL` every store throws and the site
   is down. Push only once the env var exists.
3. **Run `node scripts/migrate-blob-to-postgres.js`** (dry run by default,
   `--apply` to write) to copy the existing manifests across. Idempotent,
   never deletes, never touches the blobs.
4. **Then delete the old manifests in the Vercel Blob dashboard.** Copying
   the data does not un-publish the copy that is already public. This is the
   step that actually closes the exposure -- skipping it leaves
   `data/creators.json` readable by anyone.
5. `ORDERS_ENCRYPTION_KEY` must be set for marketplace orders (it already
   throws loudly rather than storing an address unencrypted -- that is
   correct behaviour, not a bug).

## Founding Creator programme: first 100 (shipped 2026-09-18)

Todd's pitch, built as specified except for one line held back for a
decision (below). Everything lives in `lib/founding.js` so the cap and the
window can't drift apart between the pages that show them.

What's real today:
- **100-slot cap**, enforced server-side in `pages/api/admin/profile.js`
  (409 on the 101st grant), mirrored in the admin UI as a live "X of 100
  taken" counter and a checkbox that disables itself at the cap. Granting
  again never restarts an existing creator's clock -- `foundingSince` is
  stamped once, on first grant.
- **Founding Creator badge** on the profile, the Explore cards, the home
  strip and the admin roster.
- **Priority placement** in Explore (`pages/home.js`, `pages/onlyass.js`)
  and Marketplace (`pages/marketplace.js`) -- a real sort via
  `byPlacement`, founding first then trending, not a label.
- **Creator referral link + share kit** on the dashboard: `?ref=<handle>`
  captured into a 30-day `oa_ref` cookie (`lib/referral.js`, **first-touch
  wins** so a later creator's link can't overwrite the one that did the
  work), resolved server-side at signup against a real, publicly visible
  creator, self-referral rejected. The link points at "/" (the ungated
  landing), NOT the creator's own profile -- a fan following it from one of
  the 27 blocked states would otherwise land on `/blocked-region` as their
  first impression of both the creator and the site.
- **Crypto payouts** were already how this works: wallet to wallet.
- `pages/founding-creator.js`, the public recruitment page, exempt from the
  geoblock in `proxy.js` AND from `_app.js`'s 18+ notice. Both exemptions
  carry the same hard rule as the landing page: **no creator photos, no
  content, ever** -- that restraint is the whole basis for it being public.
  Worth knowing: `_app.js`'s notice `return null`s on first render, so any
  page it covers serves an EMPTY document to anything that doesn't run JS.
  A page meant to be pasted into a link preview cannot be behind it.

**The fee-waiver clock is deliberately NOT started.** "0% platform fee for
your first 30 days" measured from acceptance would burn off entirely before
this site can charge anyone anything -- there is no payment processing here,
so a creator joining today would reach launch with the perk already spent
having never been charged 0% of anything. `PAYMENTS_LIVE_AT` (null today)
gates it: the window starts at the LATER of acceptance and payments going
live, `feeWaiverPending()` is true until then, and both the recruitment page
and the dashboard say so in plain words rather than implying a countdown is
running. **Set `PAYMENTS_LIVE_AT` when payments go live, and make
`server/`'s `charge()` consult `feeWaiverActive()`** -- the waiver is
honoured trivially today only because the fee doesn't exist.

**Held back pending a decision -- Todd's "10% OFF when you join through my
link".** Deliberately omitted from `creatorShareText()`, because it
contradicts a decision already made and shipped: staking, then the VIP burn,
was to be **the only fan-facing discount**, and both
`TOKEN_PAYMENT_DISCOUNT_BPS` and `LOYALTY_DISCOUNT_BPS` were deleted from
`server/` for exactly that reason. Adding a referral discount re-opens what
was closed. Second unanswered question if it goes ahead: **who absorbs the
10%** -- the platform (its entire cut, since the platform fee is 10%) or the
creator. Nobody has said. Don't build it until both are answered.

## Payments become USDC credits; token renamed $ONLYONE and taken off the payment path (2026-09-18)

Founder's call, verbatim: *"payments will be in usdc they buy credits our
token will be only one not only ass need find way to use it can't be
payments cause will be violation."*

Three separate decisions in one line, all now reflected on the live site:

1. **Fans pay in USDC and spend credits.** 1 credit = 1 USDC, deliberately,
   so nobody has to do arithmetic to know what they're spending.
2. **The token is `$ONLYONE`, not `$ONLYASS`.** Nothing is deployed yet
   (the launchpad and the Kekfun auction were removed earlier the same
   day), so the rename cost nothing.
3. **The token is never a payment method.** Not for subscriptions, tips,
   unlocks, marketplace, or creator payouts -- paying a creator in the
   token is still paying someone in the token. `lib/brand.js` states this
   rule in one place; the failure mode is copy drifting back to "pay with
   the token" one page at a time.

### The token's actual use, since it can't be payment

Already built, just needs to become the *only* thing it does:
- **Burn for VIP** (`server/src/core/vip.ts`) -- a one-way burn past an
  admin-adjustable threshold buys permanent VIP. Status, not currency.
- **Token-gating** -- the `locked` field on a creator ("requires token
  holding") already exists on the live site and was never wired up.
- **Creator token-lock perk** (`server/src/modules/stake.ts`) -- a fan
  locks tokens for a creator-defined perk.

Deliberately NOT recommended: paying creators bonuses in the token,
spending it to boost placement, or letting it buy credits. Each one puts it
back on the payment path through a side door.

### The thing that actually changed legally, and it isn't the token

Credits make the platform **custodial**. Terms of Service section 5 used to
say, accurately, that payments were wallet-to-wallet and *"the Platform
does not hold, custody, or have the ability to reverse funds."* Under
credits that is false: the platform holds fan money and remits to creators.
That is the money-transmission question, and it is a bigger deal than the
token ever was. The Terms were rewritten, not patched.

**The design constraint that follows, and it has to survive into the
ledger:** credits are **closed-loop** -- spendable only here, never
transferable between users, never cashed back out to a fan. That is what
OnlyFans/Twitch/Patreon do and it is the defensible shape. The moment a fan
can withdraw credits back to money, this stops being closed-loop. Creator
payouts are different and are fine (that's remitting earnings, not running
an exchange), but they are still the platform holding other people's money.
**Get this in front of a lawyer before taking the first dollar** -- not as a
punt, as the one item on this list that code cannot settle.

**USDC and Circle:** accepting USDC as a plain on-chain transfer into the
platform's own wallet needs nobody's permission. What is off-limits is
Circle's *business products* -- Circle Mint, Arc -- which ban adult content
the same way Stripe and Transak do (already recorded above). Same for any
fiat->USDC on-ramp the platform embeds: that vendor's adult-content policy
applies. Don't sign up for a Circle account expecting it to work.

### Shipped (live site, copy and labels only -- no payments exist here)

`lib/brand.js` (new, the rule); `pages/token.js` leads with "you never need
to hold this token to use the platform"; `pages/get-crypto.js` teaches USDC
instead of swapping into the token; `pages/onlyass.js` tiers re-denominated
in dollars; payout selects are USDC/ETH in both the dashboard and admin
(legacy stored `'onlyass'` reads as USDC rather than being migrated --
nothing ever paid out under it); creator subscription prices are dollars in
the seed roster, the become-a-creator form and `api/creator/submit.js`;
Terms section 2 and 5 rewritten.

**`lib/payment-circumvention-filter.js` keeps `'onlyass'` exempt alongside
`'onlyone'`.** Dropping the old ticker would flag every existing listing and
DM that mentions it as an attempt to route payment off-platform -- a rename
would become a queue of false violations. Leave it in.

### NOT built -- the credits ledger itself

`server/` still denominates in `ONLYASS` end to end (`payAsset`/
`payoutAsset`, the deposit indexer, the price oracle, treasury-hedge) and is
still not deployed. Turning it into the credits ledger means: `payAsset`
becomes credits-only, deposits watch USDC instead of the token, payouts
settle in USDC, the $ONLYASS price oracle stops being load-bearing for
pricing (a stablecoin doesn't need one), and VIP keeps its burn since that
is the token's remaining job. The founding-creator fee waiver
(`PAYMENTS_LIVE_AT` in `lib/founding.js`) starts its clock at that same
moment. Don't start this without deciding credit expiry and whether unspent
credits are refundable -- both change the schema and both are legal
questions before they are code ones.
