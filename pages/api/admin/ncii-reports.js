import { getNciiReports } from '../../../lib/ncii-reports-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const reports = await getNciiReports();
  const status = req.query.status || 'open';
  const filtered = status === 'all' ? reports : reports.filter((r) => r.status === status);
  return res.status(200).json({ reports: filtered.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)) });
}
