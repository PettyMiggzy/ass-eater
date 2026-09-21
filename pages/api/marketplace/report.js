import { getVerifiedSessionUserId } from '../../../lib/session';
import { addReport } from '../../../lib/reports-store';
import { consumeAttempt } from '../../../lib/rate-limit';

const MAX_REPORTS = 20;
const WINDOW_MS = 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to report a listing' });

  const { listingId, reason } = req.body || {};
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
    const report = await addReport({
      targetType: 'listing',
      targetId: listingId,
      reporterId: uid,
      reason: String(reason).slice(0, 500),
    });
    return res.status(200).json({ ok: true, report });
  } catch (err) {
    console.error('[marketplace/report] unexpected error:', err);
    return res.status(500).json({ error: 'internal' });
  }
}
