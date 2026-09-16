import { getViolations } from '../../../lib/violations-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const violations = await getViolations();
  const status = req.query.status || 'open';
  const filtered = status === 'all' ? violations : violations.filter((v) => v.status === status);
  return res.status(200).json({ violations: filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
}
