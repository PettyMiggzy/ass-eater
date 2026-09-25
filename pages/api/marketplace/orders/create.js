import { getVerifiedSessionUserId } from '../../../../lib/session';
import { getListings, findListing } from '../../../../lib/listings-store';
import { findUserByCreatorId } from '../../../../lib/users-store';
import {
  getCreators,
  effectiveCreatorStatus,
  isPubliclyVisible,
  isDemoListing,
  listingHasDeliverable,
} from '../../../../lib/creators-store';
import { createOrdersFromCredits, ALREADY_OWNED, isCheckoutKeyClaimed } from '../../../../lib/orders-store';
import {
  getBalanceCents,
  accountStanding,
  isFrozenStanding,
  INSUFFICIENT_BALANCE,
  ACCOUNT_FROZEN,
  RECIPIENT_UNAVAILABLE,
} from '../../../../lib/credits-store';

// Bounds how long a checkout request can run. pages/cart.js relies on this:
// an uncertain attempt whose key is still unclaimed after its
// UNCERTAIN_GRACE_MS (kept well above this) is reported as "did not go
// through", which is only true if no request can still commit by then. If
// the function is killed, its database connection drops and Postgres rolls
// the open transaction back, so nothing commits past this limit.
export const config = { maxDuration: 60 };

const REQUIRED_ADDRESS_FIELDS = ['fullName', 'line1', 'city', 'region', 'postalCode', 'country'];
const MAX_CART_ITEMS = 50;
const MAX_ADDRESS_FIELD = 200;

function isIntOrNull(v) {
  return v === null || (Number.isInteger(v) && v >= 0);
}

/**
 * Marketplace checkout, paid from the buyer's credits balance -- no wallet
 * connection here at all. The only place a wallet is ever needed is
 * pages/api/credits/buy.js, converting real USDG into that balance once.
 *
 * Request: { items: [{ listingId, expectedPriceCents, expectedShippingCents,
 * expectedKind }], shippingAddress?, ageConfirmed, tosAccepted,
 * idempotencyKey }. The expected* values are what the cart SHOWED the fan
 * -- the charge happens only if they still match the live listing, so a
 * creator raising a price after a fan added the item can never charge the
 * fan the new price silently. A missing expected value counts as a
 * mismatch. On any mismatch: 409 { code: 'PRICE_CHANGED', items: [{
 * listingId, title, priceCents, shippingCents, kind }] } and nothing is
 * charged; the cart updates itself and asks the fan to confirm again.
 * A digital listing the fan already bought: 409 { code: 'ALREADY_OWNED',
 * listingId, error } and nothing is charged.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to place an order' });

  const { items: cartItems, shippingAddress, ageConfirmed, tosAccepted, idempotencyKey } = req.body || {};
  // A retry of a checkout that already committed is answered as such before
  // any precheck can refuse it for a reason the first attempt itself caused.
  if (await isCheckoutKeyClaimed(idempotencyKey, uid)) {
    return res.status(409).json({ code: 'DUPLICATE_CHECKOUT', error: 'This checkout was already processed -- check your order history before trying again.' });
  }
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }
  if (cartItems.length > MAX_CART_ITEMS) {
    return res.status(400).json({ error: `A cart can hold at most ${MAX_CART_ITEMS} items.` });
  }
  if (ageConfirmed !== true || tosAccepted !== true) {
    return res.status(400).json({ error: 'Age confirmation and Marketplace Terms acceptance are both required' });
  }
  for (const it of cartItems) {
    const id = it?.listingId;
    if (!((typeof id === 'string' && /^\d{1,18}$/.test(id)) || (Number.isSafeInteger(id) && id > 0))) {
      return res.status(400).json({ error: 'Your cart has an invalid item in it -- remove it and try again.' });
    }
  }

  // A cart can't legitimately contain the same listing twice -- there's
  // nothing to "quantity 2" here, every listing is its own item. Rejecting
  // this up front (rather than relying only on the atomic claim inside the
  // transaction below) gives a clear error instead of a generic
  // "just sold to someone else" for what's actually a client bug.
  const ids = cartItems.map((it) => String(it.listingId));
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'Your cart has a duplicate item in it -- remove it and try again.' });
  }

  // A banned or suspended creator's balance is frozen -- it can't be spent
  // on someone else's listing any more than it can be cashed out.
  // (transferWithFee enforces the same thing inside the transaction.)
  const buyer = await accountStanding(uid);
  if (isFrozenStanding(buyer)) {
    return res.status(403).json({ error: 'Your account is suspended or banned, so its credits are frozen and can’t be spent.' });
  }

  // Re-validate every item against the CURRENT stored listing and its
  // seller -- never trust a price or an availability the client sends.
  const [listings, creators] = await Promise.all([getListings(), getCreators()]);
  const resolved = [];
  const changed = [];
  let needsShipping = false;
  let totalCents = 0;
  for (const cartItem of cartItems) {
    const { listingId } = cartItem;
    const listing = findListing(listings, listingId);
    if (!listing || listing.status !== 'active') {
      return res.status(404).json({ error: `A listing in your cart is no longer available (#${listingId})`, listingId: String(listingId) });
    }
    // The browse pages hide a listing whose seller is pending, suspended,
    // banned or a demo profile; checkout used to sell it anyway to anyone
    // holding its id (a stale cart, or a direct POST). Only an active, real
    // creator can sell, and never a listing the site labels "Demo — not for
    // sale" -- isDemoListing (seed OR demo, on the listing or its creator) is
    // the same predicate that label is drawn from.
    const seller = creators.find((c) => String(c.id) === String(listing.creatorId));
    if (!seller || !isPubliclyVisible(seller) || effectiveCreatorStatus(seller) !== 'active' || isDemoListing(listing, seller)) {
      return res.status(404).json({ error: `A listing in your cart is no longer available (#${listingId})`, listingId: String(listingId) });
    }
    // A digital listing with no files has nothing to deliver: the fan would
    // pay non-refundable credits for an empty order. Re-checked on the locked
    // row inside createOrdersFromCredits.
    if (!listingHasDeliverable(listing)) {
      return res.status(409).json({ error: `"${listing.title}" isn't available yet -- the creator hasn't attached its files.`, listingId: String(listingId) });
    }
    // A creator's login account is separate from their public creator
    // profile -- credits move between USER accounts, so a listing whose
    // creator has no (or no longer has a) login account can't be paid into.
    const creatorUser = await findUserByCreatorId(listing.creatorId);
    if (!creatorUser) {
      return res.status(404).json({ error: `"${listing.title}" isn't available for purchase right now`, listingId: String(listingId) });
    }
    if (String(creatorUser.id) === String(uid)) {
      return res.status(400).json({ error: `"${listing.title}" is your own listing -- you can't buy it.`, listingId: String(listingId) });
    }

    const kind = listing.kind === 'physical' ? 'physical' : 'digital';
    const priceCents = Number(listing.priceCents);
    const shippingCents = kind === 'physical' ? Number(listing.shippingCents) || 0 : 0;
    if (!Number.isInteger(priceCents) || priceCents <= 0) {
      return res.status(404).json({ error: `"${listing.title}" isn't available for purchase right now`, listingId: String(listingId) });
    }
    const expPrice = cartItem.expectedPriceCents;
    const expShip = cartItem.expectedShippingCents ?? 0;
    const expKind = cartItem.expectedKind;
    const matches =
      isIntOrNull(expPrice) && expPrice === priceCents &&
      isIntOrNull(expShip) && (kind === 'physical' ? expShip === shippingCents : true) &&
      (expKind === 'physical' ? 'physical' : expKind === 'digital' ? 'digital' : null) === kind;
    if (!matches) {
      changed.push({ listingId: String(listing.id), title: listing.title, priceCents, shippingCents, kind });
      continue;
    }
    if (kind === 'physical') needsShipping = true;
    totalCents += priceCents + shippingCents;
    resolved.push({ listing, creatorUserId: creatorUser.id, kind, priceCents, shippingCents });
  }

  if (changed.length) {
    return res.status(409).json({
      code: 'PRICE_CHANGED',
      error: 'Something in your cart changed since you added it. Review the updated prices and confirm again.',
      items: changed,
    });
  }

  let cleanAddress;
  if (needsShipping) {
    if (!shippingAddress || typeof shippingAddress !== 'object') {
      return res.status(400).json({ error: 'Shipping address is missing' });
    }
    cleanAddress = {};
    for (const field of [...REQUIRED_ADDRESS_FIELDS, 'line2']) {
      const v = shippingAddress[field];
      if (v !== undefined && v !== null && typeof v !== 'string') {
        return res.status(400).json({ error: `Shipping address ${field} is invalid` });
      }
      cleanAddress[field] = String(v || '').trim().slice(0, MAX_ADDRESS_FIELD);
    }
    for (const field of REQUIRED_ADDRESS_FIELDS) {
      if (!cleanAddress[field]) {
        return res.status(400).json({ error: `Shipping address is missing ${field}` });
      }
    }
  }

  const balanceCents = await getBalanceCents(uid);
  if (balanceCents < totalCents) {
    return res.status(402).json({ error: 'Not enough credits', shortfallCents: totalCents - balanceCents });
  }

  try {
    const orders = await createOrdersFromCredits({
      buyerId: uid,
      items: resolved.map(({ listing, creatorUserId, kind, priceCents, shippingCents }) => ({
        listingId: listing.id,
        creatorId: listing.creatorId,
        creatorUserId,
        priceCents,
        shippingCents,
        kind,
        unlimited: !!listing.unlimited,
        title: listing.title,
        signatureRequired: listing.signatureRequired,
        shippingAddress: cleanAddress,
      })),
      ageConfirmed,
      tosAccepted,
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey.slice(0, 200) : undefined,
    });
    // The orders are committed at this point. A failure reading the new
    // balance must not turn a completed purchase into a 500 -- the cart would
    // then report "couldn't confirm" for a checkout that went through. The
    // cart refreshes the balance itself when it gets null here.
    let newBalance = null;
    try {
      newBalance = await getBalanceCents(uid);
    } catch (balanceErr) {
      console.error('[marketplace/orders/create] balance read after commit failed:', balanceErr);
    }
    return res.status(200).json({ ok: true, orders, balanceCents: newBalance });
  } catch (err) {
    if (err.code === INSUFFICIENT_BALANCE) return res.status(402).json({ error: 'Not enough credits' });
    if (err.code === 'LISTING_UNAVAILABLE') return res.status(409).json({ error: err.message, listingId: err.listingId != null ? String(err.listingId) : undefined });
    if (err.code === 'PRICE_CHANGED') return res.status(409).json({ code: 'PRICE_CHANGED', error: err.message, listingId: String(err.listingId) });
    // The fan already owns this digital item: nothing was charged. `code` and
    // `listingId` let the cart drop it.
    if (err.code === ALREADY_OWNED) return res.status(409).json({ code: ALREADY_OWNED, error: err.message, listingId: String(err.listingId) });
    // A retry of a checkout that already went through (the first response
    // was lost). `code` lets the cart treat it as "already paid": clear the
    // cart, refresh the balance, send the fan to /orders -- instead of
    // leaving the paid items in the cart under a key a reload would replace.
    if (err.code === 'DUPLICATE_CHECKOUT') return res.status(409).json({ code: 'DUPLICATE_CHECKOUT', error: err.message });
    if (err.code === ACCOUNT_FROZEN) return res.status(403).json({ error: err.message });
    if (err.code === RECIPIENT_UNAVAILABLE) return res.status(409).json({ error: 'A creator in your cart can’t be paid right now -- remove their item and try again.' });
    console.error('[marketplace/orders/create] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong placing your order. Check your order history before trying again.' });
  }
}
