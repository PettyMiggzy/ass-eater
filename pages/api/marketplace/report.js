import { getVerifiedSessionUserId } from '../../../lib/session';
import { addReport } from '../../../lib/reports-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to report a listing' });

  const { listingId, reason } = req.body || {};
  if (!listingId || !reason || !reason.trim()) {
    return res.status(400).json({ error: 'Missing listing id or reason' });
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
    return res.status(500).json({ error: err.message });
  }
}
