import { getReports, attachReportTargets } from '../../../lib/reports-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  try {
    const reports = await getReports();
    const status = req.query.status || 'open';
    const filtered = status === 'all' ? reports : reports.filter((r) => r.status === status);
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    // Each report carries `target` -- the reported comment's text and wall,
    // or the listing's title, status and seller -- so a moderator can see
    // what they are about to remove. `targetId` is always a string.
    return res.status(200).json({ reports: await attachReportTargets(filtered) });
  } catch (err) {
    console.error('[admin/reports] unexpected error:', err);
    return res.status(500).json({ error: 'Could not load reports.' });
  }
}
