import { refuseMalformedText } from '../../../lib/field-validation';
import { getNciiReportsPage, getOpenNciiSummary } from '../../../lib/ncii-reports-store';
import { requireAdminKey } from '../../../lib/admin-auth';

/**
 * GET /api/admin/ncii-reports?status=open|removed|dismissed|all&cursor=<nextCursor>&limit=<1..50>
 *   -> 200 { reports, hasMore, nextCursor, summary }
 *
 * One PAGE of the TAKEDOWN queue (lib/ncii-reports-store.js
 * getNciiReportsPage): possible-minor filings first, then oldest first,
 * filtered by status in SQL. It used to return every request ever filed in
 * one body, and a flood of junk filings from the public form made it (and the
 * badge that read it) fail outright (round-12 social#0). Pass `nextCursor`
 * back as `cursor` for the next page; `hasMore` says whether there is one.
 *
 * `summary` is still included for the tab, but it is computed separately --
 * and the badge reads /api/admin/ncii-summary, which never depends on the
 * list loading. A summary failure does not fail the list either.
 */
export default async function handler(req, res) {
  // NUL / half an emoji in a query value is a 400, never a 500 from pg (round-11 fix-up).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : 'open';
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const limit = typeof req.query.limit === 'string' ? req.query.limit : undefined;
  try {
    const [page, summary] = await Promise.all([
      getNciiReportsPage({ status, cursor, limit }),
      getOpenNciiSummary().catch((err) => {
        console.error('[admin/ncii-reports] summary failed:', err);
        return null;
      }),
    ]);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ...page, summary });
  } catch (err) {
    console.error('[admin/ncii-reports] unexpected error:', err);
    return res.status(500).json({ error: 'Could not load takedown requests.' });
  }
}
