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
    // Guarded on 'open' inside the UPDATE. A second resolve of the same
    // report gets null back and changes nothing -- previously this re-read a
    // stale JS value, so two concurrent resolves each applied the enforcement
    // ladder and jumped a creator straight to a permanent ban off one report.
    const updated = await updateNciiReportStatus(id, action, 'admin', 'open');
    if (!updated) {
      return res.status(409).json({ error: 'That report was already resolved.' });
    }
    // Attributing a confirmed violation to a creator account triggers the
    // enforcement ladder (30-day suspension on the 1st, permanent ban on
    // the 2nd) -- optional because not every valid report is a creator's
    // own post (could be a wall comment, a hijacked account, etc.), so
    // admin decides whether/who to attribute it to rather than this being
    // automatic just because the report was confirmed.
    //
    // Reaching here means this request is the one that moved the report out
    // of 'open', so the ladder runs at most once per report.
    let creator = null;
    if (action === 'removed' && creatorId) {
      creator = await applyContentViolation(creatorId);
    }
    return res.status(200).json({ ok: true, report: updated, creator });
  } catch (err) {
    console.error('[admin/ncii-reports-resolve] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
