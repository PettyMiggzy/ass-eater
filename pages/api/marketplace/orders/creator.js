import { requireCreatorOwner } from '../../../../lib/require-creator-owner';
import { getOrdersForCreator } from '../../../../lib/orders-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const orders = await getOrdersForCreator(ctx.creator.id);
  return res.status(200).json({ orders: orders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)) });
}
