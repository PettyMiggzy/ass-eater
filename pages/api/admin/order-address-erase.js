import { requireAdminKey } from '../../../lib/admin-auth';
import { eraseOrderShippingAddress, ORDER_NOT_FOUND, ORDER_NOT_SHIPPED } from '../../../lib/orders-store';

/**
 * POST /api/admin/order-address-erase { orderId }   (admin key)
 *   -> 200 { ok: true, orderId, erased, addressErasedAt }
 *        erased:false means there was nothing left to erase (already erased,
 *        or an order with no address) -- still a success.
 *   -> 404 no such order
 *   -> 409 the order has not shipped yet (its address is still needed)
 *
 * Keeps Privacy section 7's promise: once a physical order has shipped, the
 * buyer can ask for its shipping name and address to be deleted. The order
 * record itself stays; only the address goes (lib/orders-store.js
 * eraseOrderShippingAddress). Whether an address must be kept for an open
 * dispute is the admin's call before pressing this -- it cannot be undone.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdminKey(req, res)) return;

  const { orderId } = req.body && typeof req.body === 'object' ? req.body : {};
  const idOk = (typeof orderId === 'string' && /^[1-9]\d{0,17}$/.test(orderId)) || (Number.isSafeInteger(orderId) && orderId > 0);
  if (!idOk) return res.status(400).json({ error: 'Missing or invalid order id' });

  try {
    const result = await eraseOrderShippingAddress(String(orderId));
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err.code === ORDER_NOT_FOUND) return res.status(404).json({ error: 'Order not found' });
    if (err.code === ORDER_NOT_SHIPPED) return res.status(409).json({ error: err.message });
    console.error('[admin/order-address-erase] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
