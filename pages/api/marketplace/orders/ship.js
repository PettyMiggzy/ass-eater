import { getSessionUser } from '../../../../lib/session';
import { getCreatorById, effectiveCreatorStatus } from '../../../../lib/creators-store';
import { markOrderShipped } from '../../../../lib/orders-store';

// Own auth rather than requireCreatorOwner, for the same reason as
// orders/creator.js: a suspended creator must still be able to ship orders
// fans already paid for. Only a banned account is refused.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (user.role !== 'creator' || !user.creatorId) return res.status(403).json({ error: 'Not a creator account' });
  const creator = await getCreatorById(user.creatorId);
  if (!creator) return res.status(404).json({ error: 'Creator profile not found' });
  if (effectiveCreatorStatus(creator) === 'banned') {
    return res.status(403).json({ error: 'This account has been permanently banned.' });
  }

  const { orderId, carrier, trackingNumber } = req.body || {};
  const idOk = (typeof orderId === 'string' && /^\d{1,18}$/.test(orderId)) || (Number.isSafeInteger(orderId) && orderId > 0);
  if (!idOk || typeof carrier !== 'string' || !carrier.trim() || typeof trackingNumber !== 'string' || !trackingNumber.trim()) {
    return res.status(400).json({ error: 'Missing order id, carrier, or tracking number' });
  }

  try {
    // markOrderShipped only matches an order whose creatorId equals creator.id --
    // a creator can't mark another creator's order shipped, this isn't just a UI restriction.
    const order = await markOrderShipped(orderId, creator.id, { carrier: carrier.trim().slice(0, 100), trackingNumber: trackingNumber.trim().slice(0, 100) });
    return res.status(200).json({ ok: true, order });
  } catch (err) {
    if (err.message === 'Order not found') return res.status(404).json({ error: err.message });
    if (err.message === 'Only physical orders can be marked shipped') return res.status(400).json({ error: err.message });
    console.error('[marketplace/orders/ship] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
