import { getSessionUser } from '../../../lib/session';
import { userWriteRestriction } from '../../../lib/user-moderation';
import { addReport, normalizeTargetId, validateReportInput, snapshotListing, reporterView } from '../../../lib/reports-store';
import { sendReportAlert } from '../../../lib/alerts';
import { query } from '../../../lib/db';
import { consumeAttempt } from '../../../lib/rate-limit';

const MAX_REPORTS = 20;
const WINDOW_MS = 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Log in to report a listing' });
  const uid = user.id;
  // A suspended account (lib/user-moderation.js) can't file reports either:
  // report spam is one of the ways an account abuses the moderation queue.
  const accountRestricted = userWriteRestriction(user);
  if (accountRestricted) return res.status(403).json({ error: accountRestricted });

  const { listingId: rawListingId, reason, category } = req.body || {};
  // A positive integer, normalised, and a listing that actually exists --
  // this used to store whatever it was sent, and an object stored as the
  // target crashed the admin REPORTS panel for everyone.
  const listingId = normalizeTargetId(rawListingId);
  if (!listingId || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'Missing listing id or reason' });
  }
  // Reason length is refused, not cut; category is one of
  // lib/reports-store.js REPORT_CATEGORIES ('minor' | 'non_consensual' |
  // 'other', default 'other').
  const input = validateReportInput({ reason, category });
  if (input.error) return res.status(400).json(input);

  const { limited, retryAfterSeconds } = consumeAttempt(`marketplace-report:user:${uid}`, {
    limit: MAX_REPORTS,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'You are reporting too quickly. Give it a moment.' });
  }

  try {
    const { rows } = await query('select data from listings where id = $1', [listingId]);
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
    // The listing's text and the srcs of every file are copied onto the
    // report now. A POSSIBLE MINOR report also puts those files on HOLD in the
    // same transaction (lib/media-preservation.js): the seller can no longer
    // delete them before an admin looks -- 18 U.S.C. 2258A needs them kept if
    // the report is confirmed. A hold does not take the listing down and does
    // not stop it selling (an unverified report must not be a one-click
    // takedown -- checkout ignores holds, see listingMediaBlocked); reports-resolve
    // turns it into a preservation on removal and releases it on dismissal.
    const reportedContent = snapshotListing(rows[0].data);
    const report = await addReport({
      targetType: 'listing',
      targetId: listingId,
      reporterId: uid,
      reason: input.reason,
      category: input.category,
      reportedContent,
    }, { holdMedia: input.category === 'minor' ? reportedContent.media.map((m) => m.src) : null });
    // A possible-minor or non-consensual report alerts the operator (no PII,
    // never blocks the filing) -- the same channel as a takedown request.
    await sendReportAlert(report);
    return res.status(200).json({ ok: true, report: reporterView(report) });
  } catch (err) {
    console.error('[marketplace/report] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
