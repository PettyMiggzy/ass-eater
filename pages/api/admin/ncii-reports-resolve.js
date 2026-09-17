import { updateNciiReportStatus } from '../../../lib/ncii-reports-store';
import { applyContentViolation } from '../../../lib/creators-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id, action, creatorId } = req.body || {};
  if (!id || !['dismiss', 'removed'].includes(action)) {
    return res.status(400).json({ error: 'Missing report id or invalid action (dismiss | removed)' });
  }

  try {
    const updated = await updateNciiReportStatus(id, action, 'admin');
    // Attributing a confirmed violation to a creator account triggers the
    // enforcement ladder (30-day suspension on the 1st, permanent ban on
    // the 2nd) -- optional because not every valid report is a creator's
    // own post (could be a wall comment, a hijacked account, etc.), so
    // admin decides whether/who to attribute it to rather than this being
    // automatic just because the report was confirmed.
    let creator = null;
    if (action === 'removed' && creatorId) {
      creator = await applyContentViolation(creatorId);
    }
    return res.status(200).json({ ok: true, report: updated, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
