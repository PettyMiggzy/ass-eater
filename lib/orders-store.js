import { encryptShippingAddress, decryptShippingAddress } from './crypto';
import { query, rowToRecord } from './db';

const CURRENT_TOS_VERSION = 'v1'; // pages/terms.js, Section 6 (Marketplace Purchases) -- bump this if that section's text materially changes

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

/** A buyer's own order history. Decrypts their own shipping address so they can see where it's going. */
export async function getOrdersForBuyer(buyerId) {
  const { rows } = await query(
    `select id, data from orders where data->>'buyerId' = $1 order by id`,
    [String(buyerId)],
  );
  return rows.map(rowToRecord).map((o) => ({ ...o, shippingAddress: decryptShippingAddress(o.shippingAddress) }));
}

/** A creator's pending-shipment queue, scoped to their own listings only. Decrypts the buyer's address since the creator needs it to ship. */
export async function getOrdersForCreator(creatorId) {
  const { rows } = await query(
    `select id, data from orders
      where data->>'creatorId' = $1 and data->>'kind' = 'physical'
      order by id`,
    [String(creatorId)],
  );
  return rows.map(rowToRecord).map((o) => ({ ...o, shippingAddress: decryptShippingAddress(o.shippingAddress) }));
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
export async function markOrderShipped(orderId, creatorId, { carrier, trackingNumber }) {
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
