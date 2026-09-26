import {
  resolveNciiReport,
  reopenNciiReport,
  NCII_CREATOR_NOT_FOUND,
  NCII_ALREADY_RESOLVED,
  NCII_REPORT_NOT_FOUND,
  NCII_REASON_REQUIRED,
  NCII_NOT_REOPENABLE,
  NCII_NOTE_MAX,
  NCII_TAKEDOWN_REQUIRED,
  adminNciiReportViewLive,
} from '../../../lib/ncii-reports-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { deliverFor, reportPushFailure } from '../../../lib/server-api';
import { refuseMalformedText } from '../../../lib/field-validation';

const POSITIVE_INT = /^[1-9]\d{0,17}$/;

/**
 * POST /api/admin/ncii-reports-resolve   Header x-admin-key.
 *   { id, action: 'removed', creatorId?, contentGone? }  -> 200 { ok, report, creator, outrightBan, preservedCount }
 *        'removed' needs the removal on file: a takedown recorded against this
 *        request that actually removed something (result 'removed' -- from
 *        POST /api/admin/content-takedown, or a gallery/avatar removal
 *        attributed to it; an 'already_gone' entry does not count), a possible-minor request's
 *        outright ban of the attributed creator (every file quarantined -- a ladder ban
 *        only hides the gallery and does NOT count, round-16 media#0), or
 *        `contentGone: true` -- the admin confirming the content is already
 *        gone or was removed elsewhere (stored as report.removalBasis).
 *        409 { code: 'takedown_required' } otherwise; nothing is changed.
 *   { id, action: 'dismiss', reason }      -> 200 { ok, report, creator: null, ... }
 *        a dismissal REQUIRES a reason (1..1000 chars, stored as report.dismissReason
 *        and in report.history) -- 400 { code: 'reason_required' } without one
 *   { id, action: 'reopen', reason }       -> 200 { ok, report }
 *        puts a DISMISSED request back in the open queue (a misclicked dismissal);
 *        409 { code: 'not_reopenable' } for an open or 'removed' one
 *   404 no such report; 409 already resolved.
 */

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { id, action, creatorId, reason, contentGone } = req.body || {};
  if (!POSITIVE_INT.test(String(id ?? '')) || !['dismiss', 'removed', 'reopen'].includes(action)) {
    return res.status(400).json({ error: 'Missing report id or invalid action (dismiss | removed | reopen)' });
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason must be text' });
  }
  if (typeof reason === 'string' && reason.trim().length > NCII_NOTE_MAX) {
    return res.status(400).json({ error: `Keep the reason under ${NCII_NOTE_MAX} characters.`, field: 'reason', maxLength: NCII_NOTE_MAX });
  }
  if ((action === 'dismiss' || action === 'reopen') && !(typeof reason === 'string' && reason.trim())) {
    return res.status(400).json({ code: 'reason_required', error: `A reason is required to ${action === 'dismiss' ? 'dismiss' : 'reopen'} a takedown request.` });
  }

  if (action === 'reopen') {
    try {
      const report = await reopenNciiReport(id, { reason, by: 'admin' });
      console.info('[admin/ncii-reports-resolve] reopened', String(id));
      return res.status(200).json({ ok: true, report: await adminNciiReportViewLive(report) });
    } catch (err) {
      if (err.code === NCII_REPORT_NOT_FOUND) return res.status(404).json({ error: 'Report not found' });
      if (err.code === NCII_NOT_REOPENABLE) {
        return res.status(409).json({ code: 'not_reopenable', error: 'Only a dismissed request can be reopened (this one is open, or was resolved as removed).' });
      }
      if (err.code === NCII_REASON_REQUIRED) return res.status(400).json({ code: 'reason_required', error: err.message });
      console.error('[admin/ncii-reports-resolve] reopen failed:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
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
    const { report, creator, outrightBan, pushUid, preservedCount } = await resolveNciiReport(id, action, {
      creatorId,
      reason,
      requireTakedown: true,
      contentGone: contentGone === true,
    });
    // A suspension or ban reaches the creator's server/ account too
    // (subscriptions, payouts, live): queued in the resolve's own commit,
    // delivered now, retried by the cron if this delivery fails.
    if (pushUid) reportPushFailure(await deliverFor([pushUid]), `ncii report ${id}`);
    return res.status(200).json({ ok: true, report: await adminNciiReportViewLive(report), creator, outrightBan: !!outrightBan, preservedCount: preservedCount || 0 });
  } catch (err) {
    if (err.code === NCII_REPORT_NOT_FOUND) return res.status(404).json({ error: 'Report not found' });
    if (err.code === NCII_ALREADY_RESOLVED) return res.status(409).json({ error: 'That report was already resolved.' });
    if (err.code === NCII_REASON_REQUIRED) return res.status(400).json({ code: 'reason_required', error: err.message });
    if (err.code === NCII_TAKEDOWN_REQUIRED) {
      return res.status(409).json({
        code: 'takedown_required',
        error: 'Nothing was changed -- take the content down first (Take down content), or confirm it is already gone.',
      });
    }
    if (err.code === NCII_CREATOR_NOT_FOUND) {
      return res.status(400).json({ error: 'That creator no longer exists. Pick another account, or resolve without attributing it.' });
    }
    console.error('[admin/ncii-reports-resolve] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. The report is still open -- please try again.' });
  }
}
