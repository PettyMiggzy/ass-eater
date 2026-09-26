import { requireAdminKey } from '../../../lib/admin-auth';
import { parseTakedownTarget, takeDownContent, listModerationActions, adminTakedownResultView } from '../../../lib/content-takedown';
import { NCII_REPORT_NOT_FOUND } from '../../../lib/ncii-reports-store';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * Admin takedown of one specific item (lib/content-takedown.js). Header x-admin-key.
 *
 * POST { type: 'listing', listingId, nciiReportId?, preserve? }
 *      { type: 'message', conversationId, messageId, nciiReportId?, preserve? }
 *      { type: 'wall_post', postId, nciiReportId?, preserve? }
 *   -> 200 { ok, result: 'removed' | 'already_gone', preserved: number, snapshot, actionId }
 *   A listing is taken down WITH its paid files (buyers stop receiving it). A
 *   POSSIBLE MINOR takedown request (or preserve: true) quarantines the
 *   listing's files first. The item is copied before removal; the takedown is
 *   written to the audit trail and, with nciiReportId, onto that request --
 *   which is what lets it be resolved as 'removed'.
 *   400 bad target; 404 { code: 'report_not_found' } unknown takedown request.
 *
 * GET ?nciiReportId=12 -> 200 { ok, actions: [...] }   the audit trail (newest first)
 *
 * Neither response carries a DM takedown's conversation id (it is the two
 * participants' ids joined); a deleted participant reads as null.
 * `snapshot` is { type, text, senderId, ..., participantIds } without
 * `conversationId`, and each action's `target` is { type, messageId } for a DM.
 */
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (!requireAdminKey(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'GET') {
    const raw = req.query?.nciiReportId;
    const nciiReportId = typeof raw === 'string' && /^[1-9][0-9]{0,17}$/.test(raw) ? raw : null;
    try {
      return res.status(200).json({ ok: true, actions: await listModerationActions({ nciiReportId }) });
    } catch (err) {
      console.error('[admin/content-takedown] list failed:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { target, error } = parseTakedownTarget(body);
  if (error) return res.status(400).json({ error });
  const rawReport = body.nciiReportId;
  const hasReport = rawReport !== undefined && rawReport !== null && rawReport !== '';
  if (hasReport && !/^[1-9][0-9]{0,17}$/.test(String(rawReport))) {
    return res.status(400).json({ error: 'Invalid takedown request id' });
  }
  if (body.preserve !== undefined && typeof body.preserve !== 'boolean') {
    return res.status(400).json({ error: 'preserve must be true or false' });
  }

  try {
    const out = await takeDownContent(target, {
      nciiReportId: hasReport ? String(rawReport) : null,
      preserve: body.preserve === true,
    });
    // The copy's conversation id names both participants; the panel only
    // needs the message id (lib/content-takedown.js adminTakedownResultView).
    return res.status(200).json({ ok: true, ...adminTakedownResultView(out) });
  } catch (err) {
    if (err.code === NCII_REPORT_NOT_FOUND) {
      return res.status(404).json({ code: 'report_not_found', error: 'Takedown request not found. Nothing was removed.' });
    }
    console.error('[admin/content-takedown] failed:', err);
    return res.status(500).json({ error: 'Something went wrong. Check the item and try again -- it may be partly removed.' });
  }
}
