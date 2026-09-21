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
import { FEES } from './fees';

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

/**
 * Creates one order per cart item from a SINGLE verified on-chain payment.
 * `txHash` must already have been verified by the caller (see
 * pages/api/marketplace/orders/create.js) to actually be a real, confirmed
 * transfer of at least the combined total to the platform's payout address --
 * this function does not touch the chain, it only records the result.
 *
 * The hash is claimed in `used_payment_tx` inside the SAME transaction that
 * writes the order rows: if two requests raced to spend the same hash twice,
 * the loser's insert hits the primary key and its whole transaction (order
 * rows included) rolls back, rather than checking "already used?" and
 * writing the orders as two separate steps with a window between them.
 */
export async function createOrdersFromPayment({ txHash, buyerId, items, ageConfirmed, tosAccepted }) {
  if (ageConfirmed !== true || tosAccepted !== true) {
    throw new Error('Age confirmation and Marketplace Terms acceptance are both required to place an order');
  }
  if (!txHash || !Array.isArray(items) || items.length === 0) {
    throw new Error('Missing payment reference or cart items');
  }

  return withTransaction(async (client) => {
    try {
      await client.query('insert into used_payment_tx (tx_hash) values ($1)', [txHash]);
    } catch (err) {
      if (err.code === '23505') {
        // Postgres unique_violation -- this exact payment already produced orders.
        const already = Object.assign(new Error('This payment has already been used to create an order'), { code: 'TX_ALREADY_USED' });
        throw already;
      }
      throw err;
    }

    const created = [];
    for (const item of items) {
      const entry = {
        listingId: item.listingId,
        creatorId: item.creatorId,
        buyerId,
        priceCents: item.priceCents,
        shippingCents: item.shippingCents || 0,
        signatureRequired: item.kind === 'physical' && !!item.signatureRequired,
        kind: item.kind,
        status: item.kind === 'physical' ? 'pending_shipment' : 'fulfilled',
        shippingAddress: item.kind === 'physical' ? encryptShippingAddress(item.shippingAddress) : null,
        carrier: null,
        trackingNumber: null,
        shippedAt: null,
        paymentTxHash: txHash,
        paymentMethod: 'crypto_usdc',
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
 * fresh key, so this never blocks a real repeat purchase.
 *
 * Each non-unlimited ("one-of-a-kind") item is atomically claimed via
 * claimUniqueListing BEFORE it's charged -- if a listing has already sold
 * (to this same cart's own duplicate entry, or to someone else racing this
 * exact checkout), the claim fails and the whole transaction rolls back
 * before any money moves, rather than charging for something that's gone.
 */
export async function createOrdersFromCredits({ buyerId, items, ageConfirmed, tosAccepted, idempotencyKey }) {
  if (ageConfirmed !== true || tosAccepted !== true) {
    throw new Error('Age confirmation and Marketplace Terms acceptance are both required to place an order');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart is empty');
  }

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
      if (!item.unlimited) {
        const claimed = await claimUniqueListing(item.listingId, client);
        if (!claimed) {
          throw Object.assign(
            new Error(`"${item.title || 'An item'}" in your cart just sold to someone else.`),
            { code: 'LISTING_UNAVAILABLE' },
          );
        }
      }
      const totalCents = item.priceCents + (item.kind === 'physical' ? item.shippingCents || 0 : 0);
      await transferWithFee(
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
        shippingCents: item.shippingCents || 0,
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
