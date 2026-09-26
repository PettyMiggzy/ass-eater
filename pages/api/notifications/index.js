import { getVerifiedSessionUserId } from '../../../lib/session';
import { getNotificationsForUser, getUnreadCount } from '../../../lib/notifications-store';

// Keys that exist only so createNotification can fold a burst into one row
// (its `coalesceKey`). Never sent to the client: `wallAuthorKey` identifies a
// wall commenter, whom the wall deliberately keeps anonymous to the creator,
// and rows written before round 8 hold an unkeyed digest anyone can
// recompute from an account id (round-8 social#1).
const INTERNAL_META_KEYS = new Set(['wallAuthorKey']);

function publicMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return meta ?? null;
  const out = {};
  for (const [k, v] of Object.entries(meta)) if (!INTERNAL_META_KEYS.has(k)) out[k] = v;
  return out;
}

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
      meta: publicMeta(n.meta),
      createdAt: n.created_at,
      read: !!n.read_at,
    })),
    unreadCount,
  });
}
