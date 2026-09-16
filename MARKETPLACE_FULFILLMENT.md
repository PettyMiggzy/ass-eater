# Marketplace physical-item fulfillment

The gap: creators can list "merch" but there was no shipping address
collection, no order/fulfillment status, and no way for a creator to know
what to ship. This is that system.

Two implementations exist in this repo (a known, pre-existing duplication --
see the live Blob-based marketplace vs. the Postgres/Fastify `server/`
backend), kept in sync below. Shipping — carrier, packaging, whether to
require a signature, item condition — is entirely the creator's own
responsibility in both. **The creator gets paid at the time of sale, same
as a digital unlock. There is no escrow, no holding period, and no platform
adjudication of delivery disputes.**

An earlier version of this held a physical order's proceeds for 14 days and
required an admin to personally decide who was telling the truth on every
dispute ("buyer says it never arrived" vs. "creator says it shipped fine").
That was the wrong call on both counts: it's a long time for a creator to
wait on money for something already sold, and the platform has no better
evidence than either party does — putting it in the position of
adjudicating "who's lying" is real liability for no benefit, and it's
exactly the setup a buyer could exploit by falsely claiming non-delivery.
Simpler and cleaner: **pay instantly, let the creator protect themselves
with how they ship.**

## What's built

- **`Listing.kind`**: `'digital'` (default) or `'physical'`, set at
  creation. Physical listings also carry a flat `shippingCents` fee the
  creator sets — there's no address-based rate calculation, the creator
  just picks a number (matches this platform's whole pricing model:
  creators set their own prices, not a rate engine). Price shipping to
  cover whatever shipping method you want to use, signature confirmation
  included.
- **`Listing.signatureRequired`**: a flag the creator sets. **This is
  advisory, not enforced** — the platform has no integration with USPS,
  UPS, FedEx, or any shipping carrier, so it can't actually make a creator
  buy signature confirmation or verify they did. It shows the buyer "this
  seller requires a signature" and reminds the creator on their "to ship"
  queue. The actual protection comes from the creator selecting that
  service with their real carrier when they print a label or drop off the
  package — outside anything this codebase can see or control.
- **Payout**: `marketplace.ts`'s buy handler pays the creator their net
  proceeds (+ shipping) immediately at purchase, physical or digital, no
  difference. Shipping status (`AWAITING_SHIPMENT` → `SHIPPED`, carrier +
  tracking) is tracked for buyer/creator visibility only — it never gates
  the payout, there's nothing to release.
- **`lib/orders-store.js`** (live site) / **`ListingOrder`** (server):
  order + shipping-status record, separate from payment.
- **Creator dashboard → "Orders to Ship"**: shows every pending physical
  order for that creator's own listings (decrypted shipping address
  included, since they need it to ship, plus a signature reminder if the
  listing requires one), with a form to enter carrier + tracking number
  and mark it shipped.
- **`pages/api/marketplace/orders/mine.js`** / `GET /listings/orders/mine`:
  a buyer's own order history.

## On "getting liability off the platform"

This is a real, deliberate tradeoff, not a free lunch — worth stating
plainly rather than oversold:
- **What it buys you:** the platform never holds money hostage over a
  factual dispute it can't actually adjudicate, creators get paid
  instantly like everywhere else on the platform, and the terms are simple
  enough to put plainly in the ToS ("the creator is the seller; shipping
  method, including whether to require a signature, is entirely their
  choice and responsibility; the platform processes payment and takes no
  role in delivery"). That framing — a payment processor, not the seller
  of record, taking no custody of the goods or the money in transit — is
  the same one Shopify/Stripe-based creator stores rely on, and most of
  them don't run escrow either.
- **What it doesn't buy you:** since fan payments here settle in
  crypto/ledger balance rather than through a card network, there's no
  chargeback mechanism forcing a resolution if a creator turns out to be a
  bad actor — a scammed buyer's only recourse is reporting the creator
  (existing report/ban tooling in `/admin`) or convincing the creator
  directly, not an automatic refund from the platform. A creator requiring
  signature confirmation (or a buyer only buying from creators who do)
  materially reduces "it never arrived" disputes since it produces
  objective, carrier-side proof of delivery — but it's the creator's own
  protection against a false claim, not something the platform verifies or
  guarantees on their behalf.

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

## What's NOT done yet, on purpose

- **No buyer-facing checkout/address-collection UI.** The marketplace's Buy
  button is still an honest `showComingSoon()` — there's no real payment
  capture for the marketplace anywhere yet. Wire the address form + a call
  to `POST /api/marketplace/orders/create` (or `/listings/:id/buy` on
  `server/`) in right after payment succeeds, once real checkout exists.
- **No inventory/quantity tracking.** One physical listing = one item to
  ship, same as "one-of-a-kind" digital listings already work. A creator
  with 50 units of the same shirt needs 50 listings today.
- **No shipping-address validation beyond "these fields aren't empty".** No
  address-verification API, no international shipping restrictions modeled
  (e.g. some countries a creator might not want to ship to at all).
- **No email/push notification on ship.** A buyer finding out their item
  shipped only by checking the site isn't ideal at any real volume.
- **No carrier integration.** Everything above about signature confirmation
  is a label, not an API call to USPS/UPS/FedEx/a shipping aggregator
  (EasyPost, Shippo). Real label purchasing/tracking-verification would be
  a materially bigger feature than what this gap needed solving.
