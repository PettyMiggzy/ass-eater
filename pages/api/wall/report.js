import { getSessionUser } from '../../../lib/session';
import { userWriteRestriction } from '../../../lib/user-moderation';
import { addReport, normalizeTargetId } from '../../../lib/reports-store';
import { query } from '../../../lib/db';
import { consumeAttempt } from '../../../lib/rate-limit';

// Every other write-heavy endpoint in this codebase throttles per-user
// (wall/post.js, messages/send.js) -- this one didn't, so a single free
// account could flood the moderation queue admins triage as fast as the
// client could fire requests. 20/min matches wall/post.js's own limit.
const MAX_REPORTS = 20;
const WINDOW_MS = 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Log in to report a comment' });
  const uid = user.id;
  // A suspended account (lib/user-moderation.js) can't file reports either:
  // report spam is one of the ways an account abuses the moderation queue.
  const accountRestricted = userWriteRestriction(user);
  if (accountRestricted) return res.status(403).json({ error: accountRestricted });

  const { postId: rawPostId, reason } = req.body || {};
  // typeof, not just truthiness -- a truthy non-string reason (an object)
  // passed the old `!reason` check and then threw on `.trim()`. The post id
  // is normalised to a positive integer and checked against a real comment
  // below, same as marketplace/report.js.
  const postId = normalizeTargetId(rawPostId);
  if (!postId || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'Missing comment id or reason' });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(`wall-report:user:${uid}`, {
    limit: MAX_REPORTS,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'You are reporting too quickly. Give it a moment.' });
  }

  try {
    const { rows } = await query('select 1 from wall_posts where id = $1', [postId]);
    if (!rows.length) return res.status(404).json({ error: 'Comment not found' });
    const report = await addReport({
      targetType: 'wall_post',
      targetId: postId,
      reporterId: uid,
      reason: String(reason).slice(0, 500),
    });
    return res.status(200).json({ ok: true, report });
  } catch (err) {
    console.error('[wall/report] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
