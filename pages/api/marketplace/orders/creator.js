import { getSessionUser } from '../../../../lib/session';
import { getCreatorById, effectiveCreatorStatus } from '../../../../lib/creators-store';
import { getOrdersForCreator } from '../../../../lib/orders-store';

/**
 * A creator's physical-order queue.
 *
 * Deliberately NOT lib/require-creator-owner.js: that gate 403s a suspended
 * creator, which is right for posting and editing content but wrong here --
 * fans have already paid (non-refundably) for these orders, and a 30-day
 * suspension must not strand their shipments for 30 days. Suspended and
 * pending creators can see and ship what they already sold; only a banned
 * account is refused (a permanent ban is a policy call to keep it out
 * entirely, recorded in the P2 report).
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
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

  const orders = await getOrdersForCreator(creator.id);
  return res.status(200).json({ orders: orders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)) });
}
