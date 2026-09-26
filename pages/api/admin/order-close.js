import { requireAdminKey } from '../../../lib/admin-auth';
import { closeUnfulfilledOrder, ORDER_NOT_FOUND, ORDER_NOT_CLOSABLE, ORDER_SELLER_ACTIVE, MAX_CLOSE_REASON } from '../../../lib/orders-store';

/**
 * POST /api/admin/order-close { orderId, reason, eraseAddress?, force? }   (admin key)
 *   -> 200 { ok: true, orderId, status: 'closed_unfulfilled', closedAt, erased, forced }
 *   -> 400 missing/invalid id or reason
 *   -> 404 no such order
 *   -> 409 { code: 'ORDER_NOT_CLOSABLE' } not closable (a digital order, or one
 *      no longer waiting to ship)
 *   -> 409 { code: 'ORDER_SELLER_ACTIVE', seller } the seller is not banned
 *      or deleted and could still ship it; resend with `force: true` only
 *      after confirming (GET /api/admin/orders?orderId= shows the summary)
 *
 * Closes a paid physical order that can never ship because its seller was
 * banned or deleted (lib/orders-store.js closeUnfulfilledOrder). Once closed
 * it counts as settled everywhere: its address can be erased (here with
 * `eraseAddress: true`, or later via /api/admin/order-address-erase), and the
 * buyer is no longer blocked from deleting their account. The buyer gets an
 * in-app notification. No credits move -- a re-credit to the buyer is a
 * separate, explicit owner decision. The reason is an internal note: neither
 * the buyer's nor the seller's order API returns it.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdminKey(req, res)) return;

  const { orderId, reason, eraseAddress, force } = req.body && typeof req.body === 'object' ? req.body : {};
  const idOk = (typeof orderId === 'string' && /^[1-9]\d{0,17}$/.test(orderId)) || (Number.isSafeInteger(orderId) && orderId > 0);
  if (!idOk) return res.status(400).json({ error: 'Missing or invalid order id' });
  if (typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'Give a reason for closing the order (shown to support, kept on the order).' });
  }
  if (reason.length > MAX_CLOSE_REASON) {
    return res.status(400).json({ error: `Reason must be at most ${MAX_CLOSE_REASON} characters.` });
  }
  if (eraseAddress !== undefined && typeof eraseAddress !== 'boolean') {
    return res.status(400).json({ error: 'eraseAddress must be true or false' });
  }
  if (force !== undefined && typeof force !== 'boolean') {
    return res.status(400).json({ error: 'force must be true or false' });
  }

  try {
    const result = await closeUnfulfilledOrder(String(orderId), { reason, eraseAddress: eraseAddress === true, force: force === true });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err.code === ORDER_NOT_FOUND) return res.status(404).json({ error: 'Order not found' });
    if (err.code === ORDER_NOT_CLOSABLE) return res.status(409).json({ error: err.message, code: ORDER_NOT_CLOSABLE, status: err.status ?? null });
    if (err.code === ORDER_SELLER_ACTIVE) return res.status(409).json({ error: err.message, code: ORDER_SELLER_ACTIVE, seller: err.seller ?? null });
    console.error('[admin/order-close] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
