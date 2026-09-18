import { getVerifiedSessionUserId } from '../../../../lib/session';
import { getOrdersForBuyer } from '../../../../lib/orders-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to see your orders' });

  const orders = await getOrdersForBuyer(uid);
  return res.status(200).json({ orders: orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
}
