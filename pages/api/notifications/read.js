import { getVerifiedSessionUserId } from '../../../lib/session';
import { markReadUpTo } from '../../../lib/notifications-store';

/**
 * POST { fromId, upToId } -- marks read every unread notification with
 * fromId <= id <= upToId, i.e. exactly what the bell displayed. Anything newer
 * (or older than the displayed page) stays unread. fromId is optional.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in first' });

  const { upToId, fromId } = req.body || {};
  const max = Number(upToId);
  if (!Number.isSafeInteger(max) || max <= 0) {
    return res.status(400).json({ error: 'upToId (the highest notification id shown) is required' });
  }

  try {
    const marked = await markReadUpTo(uid, max, fromId);
    return res.status(200).json({ ok: true, marked });
  } catch (err) {
    console.error('[notifications/read] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
