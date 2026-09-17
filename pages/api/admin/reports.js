import { getReports } from '../../../lib/reports-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const reports = await getReports();
  const status = req.query.status || 'open';
  const filtered = status === 'all' ? reports : reports.filter((r) => r.status === status);
  return res.status(200).json({ reports: filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
}
