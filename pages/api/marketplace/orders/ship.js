import { requireCreatorOwner } from '../../../../lib/require-creator-owner';
import { markOrderShipped } from '../../../../lib/orders-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { orderId, carrier, trackingNumber } = req.body || {};
  if (!orderId || !carrier || !trackingNumber) {
    return res.status(400).json({ error: 'Missing order id, carrier, or tracking number' });
  }

  try {
    // markOrderShipped only matches an order whose creatorId equals ctx.creator.id --
    // a creator can't mark another creator's order shipped, this isn't just a UI restriction.
    const order = await markOrderShipped(orderId, ctx.creator.id, { carrier: String(carrier).slice(0, 100), trackingNumber: String(trackingNumber).slice(0, 100) });
    return res.status(200).json({ ok: true, order });
  } catch (err) {
    return res.status(err.message === 'Order not found' ? 404 : 500).json({ error: err.message });
  }
}
