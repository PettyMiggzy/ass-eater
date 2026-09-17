import { getViolations } from '../../../lib/violations-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const violations = await getViolations();
  const status = req.query.status || 'open';
  const filtered = status === 'all' ? violations : violations.filter((v) => v.status === status);
  return res.status(200).json({ violations: filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
}
