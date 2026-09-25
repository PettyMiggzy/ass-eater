import { getSessionUser } from '../../../lib/session';
import { userWriteRestriction } from '../../../lib/user-moderation';
import { addReport, normalizeTargetId } from '../../../lib/reports-store';
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

  const { listingId: rawListingId, reason } = req.body || {};
  // A positive integer, normalised, and a listing that actually exists --
  // this used to store whatever it was sent, and an object stored as the
  // target crashed the admin REPORTS panel for everyone.
  const listingId = normalizeTargetId(rawListingId);
  if (!listingId || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({ error: 'Missing listing id or reason' });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(`marketplace-report:user:${uid}`, {
    limit: MAX_REPORTS,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'You are reporting too quickly. Give it a moment.' });
  }

  try {
    const { rows } = await query('select 1 from listings where id = $1', [listingId]);
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
    const report = await addReport({
      targetType: 'listing',
      targetId: listingId,
      reporterId: uid,
      reason: String(reason).slice(0, 500),
    });
    return res.status(200).json({ ok: true, report });
  } catch (err) {
    console.error('[marketplace/report] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
