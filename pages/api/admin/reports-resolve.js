import { getReportById, updateReportStatus, normalizeTargetId } from '../../../lib/reports-store';
import { markListingRemoved } from '../../../lib/listings-store';
import { deleteWallPost } from '../../../lib/wall-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { id, action } = req.body || {};
  if (!normalizeTargetId(id) || !['dismiss', 'remove_content'].includes(action)) {
    return res.status(400).json({ error: 'Missing report id or invalid action (dismiss | remove_content)' });
  }

  try {
    const report = await getReportById(String(id));
    if (!report) return res.status(404).json({ error: 'Report not found' });

    let contentNote = null;
    if (action === 'remove_content') {
      const targetId = normalizeTargetId(report.targetId);
      if (report.targetType === 'listing') {
        if (targetId && await markListingRemoved(targetId)) {
          contentNote = 'removed';
        } else {
          contentNote = 'already_gone';
        }
      } else if (report.targetType === 'wall_post') {
        if (!targetId) {
          contentNote = 'already_gone';
        } else {
          try {
            await deleteWallPost(targetId, 'admin', { isWallOwner: true });
            contentNote = 'removed';
          } catch (err) {
            // Only "it's already gone" is fine to treat as done. Anything
            // else (a DB error) must NOT be recorded as actioned -- the
            // content would stay live while the queue says it was removed.
            if (err.message !== 'Comment not found') throw err;
            contentNote = 'already_gone';
          }
        }
      } else {
        // An unrecognised target type cannot be acted on here, so it is not
        // marked actioned as though it had been.
        return res.status(400).json({ error: 'This report type cannot be actioned automatically. Dismiss it or handle it by hand.' });
      }
    }

    const updated = await updateReportStatus(report.id, action === 'dismiss' ? 'dismissed' : 'actioned', 'admin');
    return res.status(200).json({ ok: true, report: updated, content: contentNote });
  } catch (err) {
    console.error('[admin/reports-resolve] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong -- the report is still open. Please try again.' });
  }
}
