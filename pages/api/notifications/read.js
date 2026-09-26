import { getVerifiedSessionUserId } from '../../../lib/session';
import { markReadUpTo, markReadIds, markAllRead, getUnreadCount } from '../../../lib/notifications-store';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * POST { ids: [id, ...] } -- marks read exactly those notifications (the ids
 *   the bell displayed; at most 500). Preferred (round-19 public-pages#0): a
 *   range could sweep in a row that sat in a gap of the displayed list.
 * POST { all: true } -- marks EVERY unread notification read ("Mark all as
 *   read"), so a stale badge can always be cleared.
 * POST { fromId, upToId } -- legacy: every unread row with fromId <= id <=
 *   upToId. Anything newer stays unread. fromId is optional.
 * -> 200 { ok: true, marked, unreadCount }
 */
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in first' });

  const { upToId, fromId, ids, all } = req.body || {};
  if (all !== undefined && all !== true) return res.status(400).json({ error: 'all must be true' });
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500)) {
    return res.status(400).json({ error: 'ids must be a list of at most 500 notification ids' });
  }
  const max = Number(upToId);
  if (all !== true && ids === undefined && (!Number.isSafeInteger(max) || max <= 0)) {
    return res.status(400).json({ error: 'Send ids (the notifications shown), all: true, or upToId' });
  }

  try {
    const marked = all === true
      ? await markAllRead(uid)
      : ids !== undefined
        ? await markReadIds(uid, ids)
        : await markReadUpTo(uid, max, fromId);
    return res.status(200).json({ ok: true, marked, unreadCount: await getUnreadCount(uid) });
  } catch (err) {
    console.error('[notifications/read] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
