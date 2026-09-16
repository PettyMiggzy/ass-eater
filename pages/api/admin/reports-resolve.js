import { getReports, updateReportStatus } from '../../../lib/reports-store';
import { getListings, saveListings, findListing } from '../../../lib/listings-store';
import { deleteWallPost } from '../../../lib/wall-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id, action } = req.body || {};
  if (!id || !['dismiss', 'remove_content'].includes(action)) {
    return res.status(400).json({ error: 'Missing report id or invalid action (dismiss | remove_content)' });
  }

  const reports = await getReports();
  const report = reports.find((r) => String(r.id) === String(id));
  if (!report) return res.status(404).json({ error: 'Report not found' });

  try {
    if (action === 'remove_content') {
      if (report.targetType === 'listing') {
        const listings = await getListings();
        const listing = findListing(listings, report.targetId);
        if (listing) {
          await saveListings(listings.map((l) => (String(l.id) === String(report.targetId) ? { ...l, status: 'removed' } : l)));
        }
      } else if (report.targetType === 'wall_post') {
        await deleteWallPost(report.targetId, 'admin', { isWallOwner: true }).catch(() => {}); // already-deleted is fine
      }
      // Unrecognized targetType: still marks the report resolved below, just can't act on content we don't know how to touch.
    }

    const updated = await updateReportStatus(id, action === 'dismiss' ? 'dismissed' : 'actioned', 'admin');
    return res.status(200).json({ ok: true, report: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
