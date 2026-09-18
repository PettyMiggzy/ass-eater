import { getVerifiedSessionUserId } from '../../../lib/session';
import { addReport } from '../../../lib/reports-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to report a comment' });

  const { postId, reason } = req.body || {};
  if (!postId || !reason || !reason.trim()) {
    return res.status(400).json({ error: 'Missing comment id or reason' });
  }

  try {
    const report = await addReport({
      targetType: 'wall_post',
      targetId: postId,
      reporterId: uid,
      reason: String(reason).slice(0, 500),
    });
    return res.status(200).json({ ok: true, report });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
