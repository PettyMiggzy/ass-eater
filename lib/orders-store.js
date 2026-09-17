import { encryptShippingAddress, decryptShippingAddress } from './crypto';
import { readJsonList, updateJsonList } from './blob-json-store';

const MANIFEST_PATH = 'data/marketplace-orders.json';
const CURRENT_TOS_VERSION = 'v1'; // pages/terms.js, Section 6 (Marketplace Purchases) -- bump this if that section's text materially changes

// Orders are stored with the shipping address encrypted at rest (see
// lib/crypto.js). Every read path below decrypts only for the specific
// caller it's already been authorized for (the buyer's own order, or the
// creator who owns the listing) -- never return a raw order list straight
// from getOrders() to a client.
async function getOrders() {
  return readJsonList(MANIFEST_PATH);
}

/**
 * Creates an order record. Call this from wherever real marketplace checkout
 * ends up capturing payment -- this store only tracks the order/fulfillment
 * lifecycle, it doesn't move money itself.
 */
export async function createOrder({ listingId, creatorId, buyerId, priceCents, shippingCents, kind, signatureRequired, shippingAddress, ageConfirmed, tosAccepted }) {
  if (ageConfirmed !== true || tosAccepted !== true) throw new Error('Age confirmation and Marketplace Terms acceptance are both required to place an order');
  const order = await updateJsonList(MANIFEST_PATH, (list) => {
    const nextId = Math.max(0, ...list.map((o) => Number(o.id) || 0)) + 1;
    const entry = {
      id: nextId,
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
    return { next: [...list, entry], result: entry };
  });
  return { ...order, shippingAddress: undefined }; // never echo the encrypted blob back either
}

/** A buyer's own order history. Decrypts their own shipping address so they can see where it's going. */
export async function getOrdersForBuyer(buyerId) {
  const list = await getOrders();
  return list
    .filter((o) => String(o.buyerId) === String(buyerId))
    .map((o) => ({ ...o, shippingAddress: decryptShippingAddress(o.shippingAddress) }));
}

/** A creator's pending-shipment queue, scoped to their own listings only. Decrypts the buyer's address since the creator needs it to ship. */
export async function getOrdersForCreator(creatorId) {
  const list = await getOrders();
  return list
    .filter((o) => String(o.creatorId) === String(creatorId) && o.kind === 'physical')
    .map((o) => ({ ...o, shippingAddress: decryptShippingAddress(o.shippingAddress) }));
}

/** Creator marks a physical order shipped. Ownership must already be checked by the caller (creatorId must match). */
export async function markOrderShipped(orderId, creatorId, { carrier, trackingNumber }) {
  const updated = await updateJsonList(MANIFEST_PATH, (list) => {
    const idx = list.findIndex((o) => String(o.id) === String(orderId) && String(o.creatorId) === String(creatorId));
    if (idx === -1) throw new Error('Order not found');
    if (list[idx].kind !== 'physical') throw new Error('Only physical orders can be marked shipped');
    const next = [...list];
    next[idx] = { ...next[idx], status: 'shipped', carrier, trackingNumber, shippedAt: new Date().toISOString() };
    return { next, result: next[idx] };
  });
  return { ...updated, shippingAddress: undefined };
}
