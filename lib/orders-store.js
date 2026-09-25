import { encryptShippingAddress, decryptShippingAddress } from './crypto';

/**
 * decryptShippingAddress throws on a malformed blob and on a GCM tag failure
 * (a rotated or wrong ORDERS_ENCRYPTION_KEY). Both read paths below map it
 * across every row, so one unreadable address would throw for the WHOLE
 * result -- a creator's entire shipping queue 500s because of one legacy or
 * corrupt row. A null address is a visible gap in one order; a 500 is no
 * orders at all.
 */
function safeDecrypt(value) {
  try {
    return decryptShippingAddress(value);
  } catch (err) {
    console.error('[orders] shipping address could not be decrypted:', err.message);
    return null;
  }
}
import { query, rowToRecord, withTransaction } from './db';
import { transferWithFee } from './credits-store';
import { claimUniqueListing } from './listings-store';
import { isDemoListing, listingHasDeliverable } from './creator-status';
import { createNotification } from './notifications-store';
import { FEES } from './fees';

// The Terms version each order records -- pages/terms.js Section 6 is what a
// buyer accepts per order. Defined in lib/tos.js (one constant, shared with
// the terms page's "last updated" date and signup); bump it there.
import { CURRENT_TOS_VERSION } from './tos';
export { CURRENT_TOS_VERSION };

// Orders are stored with the shipping address encrypted at rest (see
// lib/crypto.js). Every read path below decrypts only for the specific
// caller it's already been authorized for (the buyer's own order, or the
// creator who owns the listing) -- and each query filters in SQL rather than
// fetching every order and filtering in JavaScript, so one caller's rows are
// the only ones that ever leave the database.

/**
 * Creates an order record. Call this from wherever real marketplace checkout
 * ends up capturing payment -- this store only tracks the order/fulfillment
 * lifecycle, it doesn't move money itself.
 */
export async function createOrder({ listingId, creatorId, buyerId, priceCents, shippingCents, kind, signatureRequired, shippingAddress, ageConfirmed, tosAccepted }) {
  if (ageConfirmed !== true || tosAccepted !== true) throw new Error('Age confirmation and Marketplace Terms acceptance are both required to place an order');
  const entry = {
    listingId,
    creatorId,
    buyerId,
    priceCents,
    shippingCents: shippingCents || 0,
    signatureRequired: kind === 'physical' && !!signatureRequired, // advisory only -- see MARKETPLACE_FULFILLMENT.md
    kind, // 'digital' | 'physical'
    status: kind === 'physical' ? 'pending_shipment' : 'fulfilled',
    shippingAddress: kind === 'physical' ? encryptShippingAddress(shippingAddress) : null,
    carrier: null,
    trackingNumber: null,
    shippedAt: null,
    ageConfirmedAt: new Date().toISOString(), // recorded per order, separate from account-level DOB check -- see terms.js Section 6
    tosVersion: CURRENT_TOS_VERSION,
    createdAt: new Date().toISOString(),
  };
  const { rows } = await query('insert into orders (data) values ($1) returning id, data', [entry]);
  const order = rowToRecord(rows[0]);
  return { ...order, shippingAddress: undefined }; // never echo the encrypted blob back either
}

/**
 * Creates orders paid from the buyer's credits balance -- no wallet, no
 * on-chain step. `items` carry `creatorUserId` (the creator's OWN login
 * account, resolved by the caller via findUserByCreatorId, since credits
 * move between USER accounts, not creator profile ids).
 *
 * The whole cart is ONE transaction: every item's transfer runs inside it,
 * so a multi-item cart either fully charges or not at all -- a fan cannot
 * end up charged for item 3 of 5 because item 4 turned out to be a listing
 * whose creator has no login account (deleted since the cart page loaded).
 * transferWithFee is called with this transaction's client for exactly
 * that reason, not with its own default one.
 *
 * `idempotencyKey`, when given, is claimed in `checkout_idempotency` inside
 * this same transaction -- a retried or double-submitted checkout (a
 * dropped response, a double-click before the button disables) with the
 * SAME key fails the insert and rolls back the whole charge, rather than
 * being processed a second time. A genuinely new checkout always sends a
 * fresh key, so this never blocks a real repeat purchase. The claim is
 * per buyer (the table's primary key is (buyer_id, idempotency_key)), so a
 * key some OTHER account already used never comes back as this buyer's
 * DUPLICATE_CHECKOUT.
 *
 * Each non-unlimited ("one-of-a-kind") item is atomically claimed via
 * claimUniqueListing BEFORE it's charged -- if a listing has already sold
 * (to this same cart's own duplicate entry, or to someone else racing this
 * exact checkout), the claim fails and the whole transaction rolls back
 * before any money moves, rather than charging for something that's gone.
 *
 * Each item's priceCents / shippingCents / kind must be the values the
 * buyer was shown and confirmed (pages/api/marketplace/orders/create.js
 * checks them against the client's expected values); they are re-checked
 * here against the row-locked listing and a mismatch throws PRICE_CHANGED
 * rather than charging a price nobody agreed to.
 */
export async function createOrdersFromCredits({ buyerId, items, ageConfirmed, tosAccepted, idempotencyKey }) {
  if (ageConfirmed !== true || tosAccepted !== true) {
    throw new Error('Age confirmation and Marketplace Terms acceptance are both required to place an order');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart is empty');
  }

  // Lock order: listings are row-locked one by one inside the transaction,
  // so two carts holding the same listings in opposite order used to form a
  // lock cycle (A locks 5 and waits on 9, B locks 9 and waits on 5) and
  // Postgres killed one with a deadlock -- a spurious "something went wrong"
  // for a fan who did nothing wrong. Walking every cart in ascending listing
  // id order removes that cycle. Payer/payee balance rows can still cycle
  // across two different checkouts (X buys from Y while Y buys from X), so a
  // deadlock or serialization failure is retried: the whole transaction,
  // idempotency key included, rolled back, so a retry is a clean re-run.
  const ordered = [...items].sort((a, b) => compareListingIds(a.listingId, b.listingId));
  for (let attempt = 1; ; attempt++) {
    try {
      return await placeOrders({ buyerId, items: ordered, idempotencyKey });
    } catch (err) {
      if (attempt >= CHECKOUT_ATTEMPTS || !RETRYABLE_SQLSTATES.has(err && err.code)) throw err;
    }
  }
}

const CHECKOUT_ATTEMPTS = 3;
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']); // deadlock_detected, serialization_failure

function compareListingIds(a, b) {
  const x = String(a);
  const y = String(b);
  // Numeric ids compared as numbers ("9" < "10"); length first, then text,
  // so no id overflows a Number.
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

/**
 * Error code for a digital listing the buyer already holds a paid order for.
 * Buying it again would charge non-refundable credits for nothing: delivery
 * already serves the listing's full current media set to the first order.
 */
export const ALREADY_OWNED = 'ALREADY_OWNED';

/** Does this buyer already hold a paid digital order for this listing? */
export async function buyerOwnsDigitalListing(buyerId, listingId, client = null) {
  const runner = client || { query };
  const { rows } = await runner.query(
    `select 1 from orders
      where data->>'buyerId' = $1
        and data->>'listingId' = $2
        and data->>'kind' = 'digital'
        and coalesce(data->>'status', '') in ('fulfilled', 'delivered')
      limit 1`,
    [String(buyerId), String(listingId)],
  );
  return rows.length > 0;
}

function placeOrders({ buyerId, items, idempotencyKey }) {
  return withTransaction(async (client) => {
    if (idempotencyKey) {
      try {
        await client.query('insert into checkout_idempotency (idempotency_key, buyer_id) values ($1, $2)', [idempotencyKey, String(buyerId)]);
      } catch (err) {
        if (err.code === '23505') {
          throw Object.assign(new Error('This checkout was already processed -- check your order history before trying again.'), { code: 'DUPLICATE_CHECKOUT' });
        }
        throw err;
      }
    }

    const created = [];
    for (const item of items) {
      // Re-read the listing INSIDE the charge's transaction, row-locked, so
      // what is charged is exactly what the caller verified against the
      // price the fan saw: a creator editing the price, or the listing being
      // removed, between the route's check and this point either waits for
      // this transaction or is caught here -- never silently charged at a
      // different price.
      const { rows: lr } = await client.query('select id, data from listings where id = $1 for update', [item.listingId]);
      const current = lr.length ? lr[0].data : null;
      // Also refused here, on the locked row: a listing marked demo, and a
      // digital listing with no files (its last file removed between the
      // route's check and this point). The seller's own demo flag is checked
      // by transferWithFee (canReceiveStanding).
      if (
        !current ||
        current.status !== 'active' ||
        String(current.creatorId) !== String(item.creatorId) ||
        isDemoListing(current) ||
        !listingHasDeliverable(current)
      ) {
        throw Object.assign(
          new Error(
            current?.status === 'sold'
              ? `"${item.title || 'An item'}" in your cart just sold to someone else.`
              : `"${item.title || 'An item'}" in your cart is no longer available.`,
          ),
          { code: 'LISTING_UNAVAILABLE', listingId: item.listingId },
        );
      }
      const currentKind = current.kind === 'physical' ? 'physical' : 'digital';
      const currentShipping = currentKind === 'physical' ? Number(current.shippingCents) || 0 : 0;
      const itemShipping = item.kind === 'physical' ? Number(item.shippingCents) || 0 : 0;
      if (Number(current.priceCents) !== item.priceCents || currentKind !== item.kind || currentShipping !== itemShipping) {
        throw Object.assign(new Error(`The price of "${item.title || 'an item'}" changed. Review your cart and confirm again.`), {
          code: 'PRICE_CHANGED',
          listingId: item.listingId,
        });
      }
      // A digital item this buyer already paid for: refused on the locked
      // row, before any money moves. (A physical unlimited item bought twice
      // is two shipments, and is allowed.) Earlier items of this same cart
      // are visible here, so a duplicate entry is caught too.
      if (currentKind === 'digital' && (await buyerOwnsDigitalListing(buyerId, item.listingId, client))) {
        throw Object.assign(new Error(`You already own "${item.title || 'this item'}" -- it's in your order history.`), {
          code: ALREADY_OWNED,
          listingId: item.listingId,
        });
      }
      if (!current.unlimited) {
        const claimed = await claimUniqueListing(item.listingId, client);
        if (!claimed) {
          throw Object.assign(
            new Error(`"${item.title || 'An item'}" in your cart just sold to someone else.`),
            { code: 'LISTING_UNAVAILABLE', listingId: item.listingId },
          );
        }
      }
      const totalCents = item.priceCents + itemShipping;
      // transferWithFee also refuses a seller who isn't an active, real
      // creator (RECIPIENT_UNAVAILABLE) or a frozen buyer (ACCOUNT_FROZEN),
      // and applies the founding-creator fee waiver -- see credits-store.js.
      const { netCents, feeBps: appliedFeeBps } = await transferWithFee(
        {
          fromUserId: buyerId,
          toUserId: item.creatorUserId,
          cents: totalCents,
          feeBps: FEES.MARKETPLACE_BPS,
          type: 'marketplace',
          meta: { listingId: item.listingId },
        },
        client,
      );
      // Inside the same transaction as the charge -- if the charge rolls
      // back (a later item in the cart fails), there is no notification for
      // a sale that never happened either.
      await createNotification(
        {
          userId: item.creatorUserId,
          type: 'sale',
          message: `You made a sale: "${item.title || 'Listing'}" — +$${(netCents / 100).toFixed(2)} credits`,
          meta: { listingId: item.listingId, netCents },
        },
        client,
      );

      const entry = {
        listingId: item.listingId,
        creatorId: item.creatorId,
        buyerId,
        // Snapshotted at purchase time, not looked up live: a listing can be
        // edited, sold out (see claimUniqueListing above) or removed later,
        // and an order in someone's history should still say what they
        // actually bought regardless of what happens to the listing after.
        title: item.title || null,
        priceCents: item.priceCents,
        shippingCents: itemShipping,
        // What the creator actually received and the rate applied (0 during
        // a founding waiver) -- the order is the receipt for both sides.
        feeBps: appliedFeeBps,
        creatorNetCents: netCents,
        signatureRequired: item.kind === 'physical' && !!item.signatureRequired,
        kind: item.kind,
        status: item.kind === 'physical' ? 'pending_shipment' : 'fulfilled',
        shippingAddress: item.kind === 'physical' ? encryptShippingAddress(item.shippingAddress) : null,
        carrier: null,
        trackingNumber: null,
        shippedAt: null,
        paymentMethod: 'credits',
        ageConfirmedAt: new Date().toISOString(),
        tosVersion: CURRENT_TOS_VERSION,
        createdAt: new Date().toISOString(),
      };
      const { rows } = await client.query('insert into orders (data) values ($1) returning id, data', [entry]);
      created.push({ ...rowToRecord(rows[0]), shippingAddress: undefined });
    }
    return created;
  });
}

/** A buyer's own order history. Decrypts their own shipping address so they can see where it's going. */
export async function getOrdersForBuyer(buyerId) {
  const { rows } = await query(
    `select id, data from orders where data->>'buyerId' = $1 order by id`,
    [String(buyerId)],
  );
  return rows.map(rowToRecord).map((o) => ({ ...o, shippingAddress: safeDecrypt(o.shippingAddress) }));
}

/** A creator's pending-shipment queue, scoped to their own listings only. Decrypts the buyer's address since the creator needs it to ship. */
export async function getOrdersForCreator(creatorId) {
  const { rows } = await query(
    `select id, data from orders
      where data->>'creatorId' = $1 and data->>'kind' = 'physical'
      order by id`,
    [String(creatorId)],
  );
  return rows.map(rowToRecord).map((o) => ({ ...o, shippingAddress: safeDecrypt(o.shippingAddress) }));
}

/**
 * Creator marks a physical order shipped.
 *
 * Ownership is part of the UPDATE's WHERE clause, not a check done against a
 * row read earlier, so there is no window in which the order could change
 * between the check and the write. A missing row and a row belonging to
 * someone else are deliberately the same error: "not found" tells a prodding
 * caller nothing about whether that order id exists.
 */
/**
 * True when this buyer has already committed a checkout under `key`. The
 * checkout route asks this BEFORE its balance, price and availability
 * prechecks: a retry of a checkout that committed but lost its response would
 * otherwise get "not enough credits" or "price changed" (the first attempt
 * already spent the credits / sold the item) instead of being told it went
 * through. The claim inside createOrdersFromCredits stays the real guard.
 */
export async function isCheckoutKeyClaimed(key, buyerId) {
  if (typeof key !== 'string' || !key) return false;
  const { rows } = await query(
    'select 1 from checkout_idempotency where idempotency_key = $1 and buyer_id = $2',
    [key.slice(0, 200), String(buyerId)],
  );
  return rows.length > 0;
}

export async function markOrderShipped(orderId, creatorId, { carrier, trackingNumber }) {
  // A paid physical order whose address can't be decrypted must not be
  // recorded as shipped -- nobody knows where it went. The address is written
  // once at checkout and never changes, so checking it before the update is
  // not a race.
  const { rows: pre } = await query(
    `select data->>'kind' as kind, data->'shippingAddress' as addr from orders where id = $1 and data->>'creatorId' = $2`,
    [orderId, String(creatorId)],
  );
  if (pre.length && pre[0].kind === 'physical') {
    const addr = pre[0].addr == null ? null : safeDecrypt(pre[0].addr);
    if (!addr || typeof addr !== 'object' || !addr.line1) {
      const err = new Error("This order's shipping address can't be read -- contact team@onlyone1.fun before shipping.");
      err.code = 'ADDRESS_UNREADABLE';
      throw err;
    }
  }
  const { rows } = await query(
    `update orders
        set data = data || jsonb_build_object(
              'status', 'shipped',
              'carrier', $3::text,
              'trackingNumber', $4::text,
              'shippedAt', $5::text
            )
      where id = $1
        and data->>'creatorId' = $2
        and data->>'kind' = 'physical'
      returning id, data`,
    [orderId, String(creatorId), carrier ?? null, trackingNumber ?? null, new Date().toISOString()],
  );
  if (!rows.length) {
    // Distinguish the two cases the old code did, but only for an order this
    // creator actually owns -- otherwise stay silent about its existence.
    const { rows: own } = await query(
      `select data->>'kind' as kind from orders where id = $1 and data->>'creatorId' = $2`,
      [orderId, String(creatorId)],
    );
    if (own.length && own[0].kind !== 'physical') throw new Error('Only physical orders can be marked shipped');
    throw new Error('Order not found');
  }
  const updated = rowToRecord(rows[0]);
  return { ...updated, shippingAddress: undefined };
}
