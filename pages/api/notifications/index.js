import { getVerifiedSessionUserId } from '../../../lib/session';
import { getNotificationsPage, getUnreadCount } from '../../../lib/notifications-store';

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

/**
 * GET -> 200 { notifications: [{ id, type, message, meta, createdAt, read }], unreadCount }
 * `notifications` is every unread row (up to 200) plus the newest 30, newest
 * first (round-19 public-pages#0: an unread row older than the newest 30 used
 * to be unreachable). `unreadCount` counts every unread row. Mark read with
 * POST /api/notifications/read { ids } (exactly what was shown) or { all: true }.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in first' });

  let rows;
  let unreadCount;
  try {
    [rows, unreadCount] = await Promise.all([
      getNotificationsPage(uid, { limit: 30, unreadCap: 200 }),
      getUnreadCount(uid),
    ]);
  } catch (err) {
    console.error('[notifications] list failed:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

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
