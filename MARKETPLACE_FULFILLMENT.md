# Marketplace physical-item fulfillment

The gap: creators can list "merch" but there was no shipping address
collection, no order/fulfillment status, and no way for a creator to know
what to ship. This is that system.

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
- **No delivery confirmation / dispute flow.** Once marked `shipped`, there's
  no `delivered` state or a way for a buyer to dispute a no-show. Worth
  building once there's real order volume to see what actually goes wrong.
- **No shipping-address validation beyond "these fields aren't empty".** No
  address-verification API, no international shipping restrictions modeled
  (e.g. some countries a creator might not want to ship to at all).
