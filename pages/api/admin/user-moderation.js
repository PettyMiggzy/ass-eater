import { requireAdminKey } from '../../../lib/admin-auth';
import { findUserById, setUserModeration, USER_MODERATION_NOT_ALLOWED } from '../../../lib/users-store';
import { effectiveUserStatus } from '../../../lib/user-moderation';
import { deliverFor, reportPushFailure } from '../../../lib/server-api';

const ACTIONS = new Set(['suspend', 'ban', 'clear']);
const MAX_DAYS = 365;
const DEFAULT_DAYS = 30;

function view(user) {
  return {
    userId: String(user.id),
    role: user.role || null,
    status: effectiveUserStatus(user),
    moderationUntil: user.moderationUntil || null,
    moderationReason: user.moderationReason || null,
    moderatedAt: user.moderatedAt || null,
  };
}

/**
 * Account-level moderation for fan accounts and unapproved creator accounts -- see
 * lib/user-moderation.js. Admin-key gated.
 *
 * GET  ?userId=<id>
 *   -> 200 { ok: true, user: { userId, role, status, moderationUntil, moderationReason, moderatedAt } }
 * POST { userId, action: 'suspend' | 'ban' | 'clear', days?: 1..365 (suspend, default 30), reason?: string }
 *   -> 200 { ok: true, user: <same shape> }
 *   -> 404 no such user; 400 bad input, or an APPROVED creator account (its
 *      standing is set on the creator profile, POST /api/admin/profile). A
 *      creator account that is not approved (pending, no profile, suspended
 *      or banned profile) can be moderated here like a fan.
 *
 * A suspension makes the account read-only (no wall posts, DMs, reports,
 * checkout or credit purchases) until it lapses; a ban signs the account
 * out everywhere and refuses every future sign-in. 'clear' lifts either.
 * The wall-comment author (post.authorId) and a violation's userId are the
 * ids the Reports and Violations panels pass here.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAdminKey(req, res)) return;

  const source = req.method === 'GET' ? req.query : req.body || {};
  const userId = source.userId;
  if ((typeof userId !== 'string' && typeof userId !== 'number') || !String(userId).trim() || String(userId).length > 100) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  try {
    if (req.method === 'GET') {
      const user = await findUserById(String(userId).trim());
      if (!user) return res.status(404).json({ error: 'No such account' });
      return res.status(200).json({ ok: true, user: view(user) });
    }

    const { action, days, reason } = source;
    if (!ACTIONS.has(action)) return res.status(400).json({ error: 'action must be suspend, ban or clear' });
    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      return res.status(400).json({ error: 'reason must be text' });
    }
    let until = null;
    if (action === 'suspend') {
      const n = days === undefined || days === null || days === '' ? DEFAULT_DAYS : Number(days);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
        return res.status(400).json({ error: `days must be a whole number from 1 to ${MAX_DAYS}` });
      }
      until = Date.now() + n * 24 * 60 * 60 * 1000;
    }
    const status = action === 'suspend' ? 'suspended' : action === 'ban' ? 'banned' : null;
    const user = await setUserModeration(String(userId).trim(), { status, until, reason: reason || null, by: 'admin' });
    if (!user) return res.status(404).json({ error: 'No such account' });
    console.info('[admin/user-moderation]', action, String(user.id));
    // The standing was queued for server/ in the same commit; deliver it now
    // (best effort -- an undelivered push is retried and listed in
    // /api/admin/standing-pushes). Without this a site-banned fan's server/
    // subscriptions kept renewing and a suspended one kept spending there.
    reportPushFailure(await deliverFor([user.id]), `user moderation ${user.id}`);
    return res.status(200).json({ ok: true, user: view(user) });
  } catch (err) {
    if (err.code === USER_MODERATION_NOT_ALLOWED) {
      return res.status(400).json({ error: "That's an approved creator -- suspend or ban it from its creator profile instead." });
    }
    console.error('[admin/user-moderation] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
