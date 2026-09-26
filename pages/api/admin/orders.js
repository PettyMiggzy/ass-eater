import { refuseMalformedText } from '../../../lib/field-validation';
import { requireAdminKey } from '../../../lib/admin-auth';
import { getOrderSummariesForAdmin } from '../../../lib/orders-store';

/**
 * GET /api/admin/orders?orderId=&creatorId=&buyerId=&status=   (admin key)
 *   -> 200 { orders: [{ id, listingId, title, kind, status, priceCents,
 *            shippingCents, buyerId, creatorId, createdAt, shippedAt, closedAt,
 *            closeReason, closeForced, addressErasedAt, hasAddress,
 *            seller: { creatorId, name, handle, status, hasLogin, unableToFulfil } }] }
 *   -> 400 an invalid filter
 *
 * The admin panel's only way to FIND an order. "Close an order that can't be
 * fulfilled" and "erase an address" both take an order number, and nothing
 * in the admin panel ever showed one: a banned creator's unshipped orders
 * were reported only as a count (round-9 admin-ui#0). Typical calls:
 *   ?creatorId=<id>&status=pending_shipment  -- a banned/deleted seller's
 *                                              unshipped orders
 *   ?orderId=<id>                             -- the summary the close
 *                                              dialog shows before confirming
 *
 * Never returns a shipping address, decrypted or not (`hasAddress` says
 * whether one is still stored). Newest first, at most 200.
 */
const ID_RE = /^[1-9][0-9]{0,17}$/;
const CREATOR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = new Set(['pending_shipment', 'shipped', 'fulfilled', 'delivered', 'closed_unfulfilled']);

export default async function handler(req, res) {
  // NUL / half an emoji in a query value is a 400, never a 500 from pg (round-11 fix-up).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdminKey(req, res)) return;

  const q = req.query || {};
  const one = (v) => (Array.isArray(v) ? undefined : v);
  const orderId = one(q.orderId);
  const creatorId = one(q.creatorId);
  const buyerId = one(q.buyerId);
  const status = one(q.status);
  for (const [name, value, re] of [['orderId', orderId, ID_RE], ['creatorId', creatorId, CREATOR_ID_RE], ['buyerId', buyerId, USER_ID_RE]]) {
    if (value !== undefined && (typeof value !== 'string' || !re.test(value))) {
      return res.status(400).json({ error: `Invalid ${name}` });
    }
  }
  if (status !== undefined && (typeof status !== 'string' || !STATUSES.has(status))) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (orderId === undefined && creatorId === undefined && buyerId === undefined) {
    return res.status(400).json({ error: 'Give an orderId, a creatorId or a buyerId.' });
  }

  try {
    const orders = await getOrderSummariesForAdmin({
      orderId: orderId ?? null,
      creatorId: creatorId ?? null,
      buyerId: buyerId ?? null,
      status: status ?? null,
    });
    return res.status(200).json({ orders });
  } catch (err) {
    console.error('[admin/orders] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
