import { refuseMalformedText } from '../../../lib/field-validation';
import { getViolations } from '../../../lib/violations-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  // NUL / half an emoji in a query value is a 400, never a 500 from pg (round-11 fix-up).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const violations = await getViolations();
  const status = req.query.status || 'open';
  const filtered = status === 'all' ? violations : violations.filter((v) => v.status === status);
  return res.status(200).json({ violations: filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
}
