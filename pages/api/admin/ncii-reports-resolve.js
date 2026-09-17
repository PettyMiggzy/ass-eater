import { getNciiReports, updateNciiReportStatus } from '../../../lib/ncii-reports-store';
import { applyContentViolation } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { id, action, creatorId } = req.body || {};
  if (!id || !['dismiss', 'removed'].includes(action)) {
    return res.status(400).json({ error: 'Missing report id or invalid action (dismiss | removed)' });
  }

  const reports = await getNciiReports();
  const existing = reports.find((r) => String(r.id) === String(id));
  if (!existing) return res.status(404).json({ error: 'Report not found' });

  try {
    const updated = await updateNciiReportStatus(id, action, 'admin');
    // Attributing a confirmed violation to a creator account triggers the
    // enforcement ladder (30-day suspension on the 1st, permanent ban on
    // the 2nd) -- optional because not every valid report is a creator's
    // own post (could be a wall comment, a hijacked account, etc.), so
    // admin decides whether/who to attribute it to rather than this being
    // automatic just because the report was confirmed.
    //
    // Only counts when the report was still open going in: the ladder is
    // per-report, and re-resolving one already resolved (a retried request,
    // a second admin acting on the same row) would otherwise stack a second
    // violation onto the same complaint and permanently ban the creator off
    // a single report.
    let creator = null;
    if (action === 'removed' && creatorId && existing.status === 'open') {
      creator = await applyContentViolation(creatorId);
    }
    return res.status(200).json({ ok: true, report: updated, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
