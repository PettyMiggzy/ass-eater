import { getVerifiedSessionUserId } from '../../../lib/session';
import { getNotificationsForUser, getUnreadCount } from '../../../lib/notifications-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in first' });

  const [rows, unreadCount] = await Promise.all([
    getNotificationsForUser(uid, 30),
    getUnreadCount(uid),
  ]);

  return res.status(200).json({
    notifications: rows.map((n) => ({
      id: n.id,
      type: n.type,
      message: n.message,
      meta: n.meta,
      createdAt: n.created_at,
      read: !!n.read_at,
    })),
    unreadCount,
  });
}
