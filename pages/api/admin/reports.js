import { getReports } from '../../../lib/reports-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const reports = await getReports();
  const status = req.query.status || 'open';
  const filtered = status === 'all' ? reports : reports.filter((r) => r.status === status);
  return res.status(200).json({ reports: filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
}
