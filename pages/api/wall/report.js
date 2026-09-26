import { getSessionUser } from '../../../lib/session';
import { userWriteRestriction } from '../../../lib/user-moderation';
import { addReport, normalizeTargetId, validateReportInput, snapshotWallPost, reporterView } from '../../../lib/reports-store';
import { sendReportAlert } from '../../../lib/alerts';
import { query } from '../../../lib/db';
import { consumeAttempt } from '../../../lib/rate-limit';
import { refuseMalformedText } from '../../../lib/field-validation';
import { AUTHOR_ACCOUNT_GONE } from '../../../lib/author-lock';

// Every other write-heavy endpoint in this codebase throttles per-user
// (wall/post.js, messages/send.js) -- this one didn't, so a single free
// account could flood the moderation queue admins triage as fast as the
// client could fire requests. 20/min matches wall/post.js's own limit.
const MAX_REPORTS = 20;
const WINDOW_MS = 60 * 1000;

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
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

  const { postId: rawPostId, reason, category } = req.body || {};
  // typeof, not just truthiness -- a truthy non-string reason (an object)
  // passed the old `!reason` check and then threw on `.trim()`. The post id
  // is normalised to a positive integer and checked against a real comment
  // below, same as marketplace/report.js.
  const postId = normalizeTargetId(rawPostId);
  if (!postId || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'Missing comment id or reason' });
  }
  // Reason length is refused, not cut; category is one of
  // lib/reports-store.js REPORT_CATEGORIES ('minor' | 'non_consensual' |
  // 'other', default 'other').
  const input = validateReportInput({ reason, category });
  if (input.error) return res.status(400).json(input);

  const { limited, retryAfterSeconds } = consumeAttempt(`wall-report:user:${uid}`, {
    limit: MAX_REPORTS,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'You are reporting too quickly. Give it a moment.' });
  }

  try {
    const { rows } = await query('select data from wall_posts where id = $1', [postId]);
    if (!rows.length) return res.status(404).json({ error: 'Comment not found' });
    // The comment's text, author and time are copied onto the report NOW:
    // its author (or the wall owner) can delete it a second later, and an
    // account deletion removes every comment the account wrote.
    const report = await addReport({
      targetType: 'wall_post',
      targetId: postId,
      reporterId: uid,
      reason: input.reason,
      category: input.category,
      reportedContent: await snapshotWallPost(rows[0].data),
    }, { requireReporter: true });
    // A possible-minor or non-consensual report alerts the operator (no PII,
    // never blocks the filing) -- the same channel as a takedown request.
    await sendReportAlert(report);
    return res.status(200).json({ ok: true, report: reporterView(report) });
  } catch (err) {
    if (err.code === AUTHOR_ACCOUNT_GONE) return res.status(401).json({ error: 'Your account no longer exists.' });
    console.error('[wall/report] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
