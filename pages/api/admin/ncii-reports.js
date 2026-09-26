import { refuseMalformedText } from '../../../lib/field-validation';
import { getNciiReports, getOpenNciiSummary } from '../../../lib/ncii-reports-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  // NUL / half an emoji in a query value is a 400, never a 500 from pg (round-11 fix-up).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  try {
    const [reports, summary] = await Promise.all([getNciiReports(), getOpenNciiSummary()]);
    const status = req.query.status || 'open';
    const filtered = status === 'all' ? reports : reports.filter((r) => r.status === status);
    // Oldest first: every one of these carries a 48-hour clock.
    return res.status(200).json({
      reports: filtered.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
      summary,
    });
  } catch (err) {
    console.error('[admin/ncii-reports] unexpected error:', err);
    return res.status(500).json({ error: 'Could not load takedown requests.' });
  }
}
