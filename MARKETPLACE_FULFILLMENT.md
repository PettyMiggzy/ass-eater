# Marketplace physical-item fulfillment

The gap: creators can list "merch" but there was no shipping address
collection, no order/fulfillment status, and no way for a creator to know
what to ship. This is that system.

Two implementations exist in this repo (a known, pre-existing duplication --
see the live Blob-based marketplace vs. the Postgres/Fastify `server/`
backend): the live site's version below, and a fuller escrow-backed version
in `server/` (see "Escrow" section below) for whenever the real backend is
deployed. Shipping/carrier/tracking is the creator's own responsibility in
both -- the platform never touches the physical item, only the payment.

## What's built

- **`Listing.kind`**: `'digital'` (default) or `'physical'`, set at creation.
  Physical listings also carry a flat `shippingCents` fee the creator sets —
  there's no address-based rate calculation, the creator just picks a number
  (matches this platform's whole pricing model: creators set their own
  prices, not a rate engine).
- **`lib/orders-store.js`**: order/fulfillment lifecycle, separate from
  payment. `createOrder()` is the integration point for whenever real
  marketplace checkout captures payment — it doesn't move money itself, it
  just starts the order at `pending_shipment` (physical) or `fulfilled`
  (digital, since unlocking the gated media *is* the fulfillment).
- **Creator dashboard → "Orders to Ship"**: shows every pending physical
  order for that creator's own listings (decrypted shipping address
  included, since they need it to ship), with a form to enter carrier +
  tracking number and mark it shipped.
- **`pages/api/marketplace/orders/mine.js`**: a buyer's own order history.

## Why the shipping address is encrypted at rest

The live site's data manifests (`lib/listings-store.js`, `lib/reports-store.js`)
are plain JSON in Vercel Blob at fixed, `access: 'public'` paths — fine for
listing/profile data that's meant to be public anyway, but a home address
tied to a specific person's purchase history on an adult content platform is
a materially more sensitive class of data (a real doxxing/safety risk if a
manifest URL ever leaks or gets guessed). `lib/crypto.js` encrypts just the
address fields (AES-256-GCM, random IV per field) before they ever touch
Blob storage, using a server-only `ORDERS_ENCRYPTION_KEY` env var (32
random bytes, base64-encoded — generate with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
Every read path (`getOrdersForBuyer`, `getOrdersForCreator`) decrypts only
for the specific, already-authorized caller — nothing ever returns the raw
order list to a client unfiltered.

## Escrow (server/, real money)

The gap this closes: `marketplace.ts`'s buy handler used to pay the creator
their net proceeds *immediately* on purchase, physical or digital, no
different from an instant digital unlock. For a physical item that's the
platform paying a seller in full before anything has shipped, delivered, or
been confirmed — if the seller never ships, ships the wrong thing, or the
item is lost, the platform has already released the money and is the one
left holding the dispute.

The first version of this held funds for a flat 14 days and required an
admin to personally decide who was telling the truth on every dispute
("buyer says it never arrived" vs. "creator says it shipped fine"). Both of
those were the wrong call: 14 days is a long time for a creator to wait on
money for something already sold, and the platform has no better evidence
than either party does — putting it in the position of adjudicating "who's
lying" is real liability for no benefit, and it's exactly the kind of
he-said/she-said a buyer could exploit by falsely claiming non-delivery.
Redesigned around two rules instead: **pay out fast by default, and never
force the platform to referee a factual dispute.**

- **Purchase**: the buyer's charge posts as before, but a physical order's
  net proceeds (+ shipping) go into the `ESCROW_ID` pseudo-account
  (`core/ledger.ts`), not the creator's balance. `ListingOrder` starts at
  `AWAITING_SHIPMENT`.
- **Ship** (`POST /listings/orders/:id/ship`, creator-only): records
  carrier + tracking, starts a `MARKETPLACE_AUTO_RELEASE_DAYS` (default
  **5**) countdown — most domestic shipping arrives well inside that.
- **Confirm receipt** (`POST /listings/orders/:id/confirm-receipt`,
  buyer-only): releases escrow to the creator immediately, doesn't wait for
  the clock.
- **Auto-release** (`workers/escrow-auto-release.ts`, hourly sweep): pays
  the creator the same way once the clock runs out, buyer silent or not.
  **This is the default outcome, not a fallback** — nothing about disputing
  changes it.
- **Dispute** (`POST /listings/orders/:id/dispute`, buyer-only): does
  **not** freeze the money or force an admin decision. It buys
  `MARKETPLACE_DISPUTE_GRACE_DAYS` (default **5**) more time on the *same*
  clock, so buyer and creator can actually talk (existing Inbox messaging),
  and logs a `Report` for visibility. If neither side does anything before
  the grace period runs out, it auto-releases to the creator anyway — a
  dispute is a pause button, not a hold-forever button. A buyer falsely
  claiming non-delivery gains nothing but a few extra days' delay unless
  they can actually convince the creator.
- **Voluntary refund** (`POST /listings/orders/:id/refund`, creator-only,
  new): the creator's own call, any time before release, no dispute or
  admin sign-off needed. If a buyer convinces them directly (or they just
  don't want the hassle), they can refund on their own — this is the real
  "let them decide between them" path.
- **Admin override** (`/admin/reports/:id/resolve` with `release_escrow` /
  `refund_buyer`): kept, but reframed as a rare manual override for a case
  that actually needs the platform to step in (a filed chargeback, a clear
  fraud pattern, a legal request) — **not** the default path for an
  ordinary dispute. Most disputes should resolve via direct buyer/creator
  contact or simply time out.

All of this lives in `core/escrow.ts`, kept separate from the Fastify route
handlers so it's unit-testable the same way `core/ledger.ts` is (see
`core/escrow.test.ts` — 16 tests, including that a dispute's grace period
still auto-releases if nobody acts, that a released/refunded order can
never be released twice, and that only the actual buyer/creator on an
order can act on it).

**On "getting liability off the platform":** escrow is the real mechanism —
it's what a chargeback review or a court actually looks at, not the ToS
wording. But it doesn't make the platform legally invisible. Depending on
jurisdiction, "marketplace facilitator" statutes and payment-processor/card
network rules can still pull the platform into a dispute regardless of an
escrow flow or a "seller is solely responsible" clause — this reduces
exposure and gives a clean, defensible process, it doesn't eliminate it.
Worth a real ToS review alongside this, not a substitute for one.

**Also new:** `scripts/seed-system-accounts.ts`, run once after
`prisma migrate deploy` — creates the `PLATFORM_ID`/`ESCROW_ID` pseudo-user
rows the ledger posts to. This was a pre-existing gap for `PLATFORM_ID`
specifically: tests created it ad hoc in `beforeEach`, production never had
an equivalent bootstrap step.

**Also fixed while here:** `npm run build` was compiling `*.test.ts` files
into `dist/`, and Vitest's default glob picked up both the source and
compiled copies — silently running every test twice. `tsconfig.json` now
excludes test files from the build.

## What's NOT done yet, on purpose

- **No buyer-facing checkout/address-collection UI.** The marketplace's Buy
  button is still an honest `showComingSoon()` — there's no real payment
  capture for the marketplace anywhere yet. Building an address-collection
  modal in front of a button that doesn't actually charge anyone would let a
  "to ship" queue show orders nobody paid for. Wire the address form + a
  call to `POST /api/marketplace/orders/create` in right after payment
  succeeds, once real checkout exists — not before.
- **No inventory/quantity tracking.** One physical listing = one item to
  ship, same as "one-of-a-kind" digital listings already work. A creator
  with 50 units of the same shirt needs 50 listings today. Real inventory
  tracking is a bigger feature than this gap needed solving.
- **No shipping-address validation beyond "these fields aren't empty".** No
  address-verification API, no international shipping restrictions modeled
  (e.g. some countries a creator might not want to ship to at all).
- **The live Blob-based site's `orders-store.js` doesn't have the escrow
  lifecycle** (confirm-receipt, dispute, auto-release) that `server/`'s
  Postgres version now has — no real money exists there to escrow yet
  (see above). Its `pending_shipment` → `shipped` statuses still work fine
  as-is for creator visibility; extend it to match once the live site has
  real payment capture and escrow actually needs enforcing there too.
- **No email/push notification on ship, auto-release-approaching, or
  dispute.** A buyer finding out their item shipped only by checking the
  site, and a creator finding out a dispute happened only by checking
  `/admin`, isn't ideal at any real volume.
