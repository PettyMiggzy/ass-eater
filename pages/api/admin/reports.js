import { refuseMalformedText } from '../../../lib/field-validation';
import { getReportsPage, attachReportTargets } from '../../../lib/reports-store';
import { requireAdminKey } from '../../../lib/admin-auth';

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
    // One PAGE (lib/reports-store.js getReportsPage): filtered by status in
    // SQL, bounded, possible-minor first, then non-consensual, then
    // everything else, newest first within each. The whole table used to be
    // loaded, filtered in JS and returned in one body with every reported
    // conversation attached (round-12 social#0). Pass `nextCursor` back as
    // `cursor` for the next page.
    const page = await getReportsPage({ status, cursor, limit });
    // Each report carries `target` -- the reported comment's text and wall,
    // or the listing's title, status and seller -- so a moderator can see
    // what they are about to remove. `targetId` is always a string. Only this
    // page's targets are read.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ reports: await attachReportTargets(page.reports), hasMore: page.hasMore, nextCursor: page.nextCursor });
  } catch (err) {
    console.error('[admin/reports] unexpected error:', err);
    return res.status(500).json({ error: 'Could not load reports.' });
  }
}
