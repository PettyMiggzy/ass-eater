import { getSessionUser } from '../../../lib/session';
import { userWriteRestriction } from '../../../lib/user-moderation';
import {
  addReport,
  normalizeTargetId,
  validateReportInput,
  reporterView,
  findProfileMediaItem,
  snapshotProfileMedia,
  PROFILE_MEDIA_TARGETS,
} from '../../../lib/reports-store';
import { getCreatorById } from '../../../lib/creators-store';
import { isPubliclyVisible } from '../../../lib/creator-status';
import { sendReportAlert } from '../../../lib/alerts';
import { consumeAttempt } from '../../../lib/rate-limit';
import { refuseMalformedText } from '../../../lib/field-validation';
import { AUTHOR_ACCOUNT_GONE } from '../../../lib/author-lock';

const MAX_REPORTS = 20;
const WINDOW_MS = 60 * 1000;

/**
 * POST /api/creator/report-media -- report ONE item of a creator's profile.
 * JSON { creatorId, targetType: 'gallery_item' | 'avatar', src, reason, category? }
 *   -> 200 { ok, report }   (the reporter's view: no stored copy, no held files)
 *   -> 400 bad input; 401 not logged in; 403 restricted account;
 *      404 no such public creator, or `src` is not (or no longer) that
 *      creator's gallery item / avatar; 429 too many.
 *
 * A creator's gallery and avatar are the main content surface, and had no
 * in-product report at all: a possible-minor photo could only be reported
 * through the public takedown form, which holds nothing, so the creator could
 * delete the file before an admin looked -- and 18 U.S.C. 2258A needs it
 * kept. Now, exactly as for a listing (pages/api/marketplace/report.js):
 *   - the item is validated server-side against the creator's CURRENT gallery
 *     or avatar (the reporter only names it);
 *   - a copy (creator, item src and type) is stored on the report at filing;
 *   - a POSSIBLE MINOR report puts the file on HOLD in the same transaction
 *     (lib/media-preservation.js): no removal path can delete it until the
 *     report is resolved. A hold does not take the item down -- an unverified
 *     report must not be a one-click takedown; reports-resolve preserves then
 *     removes it, or releases the hold on dismissal.
 * The report's targetId is the creator's id; `src` names the item.
 */
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Log in to report this' });
  const accountRestricted = userWriteRestriction(user);
  if (accountRestricted) return res.status(403).json({ error: accountRestricted });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const creatorId = normalizeTargetId(body.creatorId);
  const { targetType, src, reason, category } = body;
  if (!creatorId || !PROFILE_MEDIA_TARGETS.includes(targetType) || typeof src !== 'string' || !src || src.length > 2048) {
    return res.status(400).json({ error: 'Missing creator, item or type' });
  }
  const input = validateReportInput({ reason, category });
  if (input.error) return res.status(400).json(input);

  const { limited, retryAfterSeconds } = consumeAttempt(`profile-media-report:user:${user.id}`, {
    limit: MAX_REPORTS,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'You are reporting too quickly. Give it a moment.' });
  }

  try {
    const creator = await getCreatorById(creatorId);
    if (!creator || !isPubliclyVisible(creator)) return res.status(404).json({ error: 'Creator not found' });
    const item = findProfileMediaItem(creator, targetType, src);
    if (!item) return res.status(404).json({ error: 'That item is no longer on this profile.' });
    const reportedContent = snapshotProfileMedia(creator, targetType, item);
    const report = await addReport({
      targetType,
      targetId: creatorId,
      src: item.src,
      reporterId: user.id,
      reason: input.reason,
      category: input.category,
      reportedContent,
    }, { holdMedia: input.category === 'minor' ? [item.src] : null, requireReporter: true });
    await sendReportAlert(report);
    return res.status(200).json({ ok: true, report: reporterView(report) });
  } catch (err) {
    if (err.code === AUTHOR_ACCOUNT_GONE) return res.status(401).json({ error: 'Your account no longer exists.' });
    console.error('[creator/report-media] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
