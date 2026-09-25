import {
  resolveNciiReport,
  NCII_CREATOR_NOT_FOUND,
  NCII_ALREADY_RESOLVED,
  NCII_REPORT_NOT_FOUND,
} from '../../../lib/ncii-reports-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { pushCreatorStatus, reportPushFailure } from '../../../lib/server-api';

const POSITIVE_INT = /^[1-9]\d{0,17}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { id, action, creatorId } = req.body || {};
  if (!POSITIVE_INT.test(String(id ?? '')) || !['dismiss', 'removed'].includes(action)) {
    return res.status(400).json({ error: 'Missing report id or invalid action (dismiss | removed)' });
  }
  if (creatorId !== undefined && creatorId !== null && creatorId !== '' && typeof creatorId !== 'string' && typeof creatorId !== 'number') {
    return res.status(400).json({ error: 'Invalid creator id' });
  }

  try {
    // Attributing a confirmed violation to a creator account triggers the
    // enforcement ladder (30-day suspension on the 1st, permanent ban on
    // the 2nd) -- optional because not every valid report is a creator's
    // own post (could be a wall comment, a hijacked account, etc.), so
    // admin decides whether/who to attribute it to rather than this being
    // automatic just because the report was confirmed.
    //
    // The status change and the ladder commit in one transaction
    // (resolveNciiReport), guarded on 'open' inside the UPDATE: the ladder
    // runs exactly once per resolved report -- never twice from a
    // concurrent double-resolve, and never zero times because the second
    // half failed after the first had committed.
    // A report filed as a POSSIBLE MINOR bans the attributed creator outright
    // in that same transaction (the category comes from the stored report,
    // not from this request); `outrightBan` says it happened.
    const { report, creator, outrightBan } = await resolveNciiReport(id, action, { creatorId });
    // A suspension or ban reaches the creator's server/ account too
    // (subscriptions, payouts, live) -- after the commit, best effort.
    if (creator) reportPushFailure(await pushCreatorStatus(creator.id), `ncii report ${id}`);
    return res.status(200).json({ ok: true, report, creator, outrightBan: !!outrightBan });
  } catch (err) {
    if (err.code === NCII_REPORT_NOT_FOUND) return res.status(404).json({ error: 'Report not found' });
    if (err.code === NCII_ALREADY_RESOLVED) return res.status(409).json({ error: 'That report was already resolved.' });
    if (err.code === NCII_CREATOR_NOT_FOUND) {
      return res.status(400).json({ error: 'That creator no longer exists. Pick another account, or resolve without attributing it.' });
    }
    console.error('[admin/ncii-reports-resolve] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. The report is still open -- please try again.' });
  }
}
