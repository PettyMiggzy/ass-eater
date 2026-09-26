import { refuseMalformedText } from '../../../lib/field-validation';
import { getOpenNciiSummary } from '../../../lib/ncii-reports-store';
import { requireAdminKey } from '../../../lib/admin-auth';

/**
 * GET /api/admin/ncii-summary
 *   -> 200 { summary: { open, oldestOpenCreatedAt, openMinor } }
 *
 * The TAKEDOWN badge's own small query (round-12 social#0). The badge used to
 * read the summary off the full list response, so anything that broke the
 * list -- a flood of filings from the public form -- took the badge down with
 * it, exactly when the 48-hour clock mattered most.
 */
export default async function handler(req, res) {
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAdminKey(req, res)) return;
  try {
    const summary = await getOpenNciiSummary();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ summary });
  } catch (err) {
    console.error('[admin/ncii-summary] unexpected error:', err);
    return res.status(500).json({ error: 'Could not load the takedown summary.' });
  }
}
