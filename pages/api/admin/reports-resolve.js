import {
  getReportById,
  updateReportStatus,
  normalizeTargetId,
  reopenReport,
  releaseReportHolds,
  dismissNeedsReason,
  REPORT_NOT_FOUND,
  REPORT_NOT_REOPENABLE,
  REPORT_REASON_REQUIRED,
  REPORT_NOTE_MAX,
  PROFILE_MEDIA_TARGETS,
} from '../../../lib/reports-store';
import { removeGalleryItem, setCreatorAvatar, GALLERY_ITEM_GONE } from '../../../lib/creators-store';
import { takeDownListing } from '../../../lib/listings-store';
import { deleteWallPost } from '../../../lib/wall-store';
import { removeConversationMessage } from '../../../lib/messages-store';
import { preserveMedia, movePreservedToEvidence, reportRef, heldPathsForReport } from '../../../lib/media-preservation';
import { mediaSrc } from '../../../lib/media';
import { requireAdminKey } from '../../../lib/admin-auth';
import { query, withTransaction } from '../../../lib/db';

/**
 * POST /api/admin/reports-resolve   Header x-admin-key.
 *   { id, action: 'remove_content' }        -> 200 { ok, report, content: 'removed' | 'already_gone', preserved?: number }
 *   { id, action: 'dismiss', reason? }      -> 200 { ok, report, content: null }
 *        a dismissal of a 'minor' or 'non_consensual' report REQUIRES a reason
 *        (400 { code: 'reason_required' }); it is stored as report.dismissReason
 *        and in report.history
 *   { id, action: 'reopen', reason }        -> 200 { ok, report }
 *        puts a DISMISSED report back in the open queue (reason required);
 *        409 { code: 'not_reopenable' } for an open or actioned one
 *   409 { code: 'already_resolved' }  the report is no longer open (someone
 *        else resolved it first) -- nothing was removed or changed
 *   404 no such report.
 *
 * remove_content takes the reported thing down: a listing (files deleted), a
 * wall comment, a direct message (removed from the conversation), a gallery
 * item (removed, file deleted) or an avatar (reset to the placeholder, file
 * deleted) -- the last two only while the reported item is still the one on
 * the profile.
 *
 * A report filed under category 'minor' is evidence as well as a takedown
 * (18 U.S.C. 2258A): a gallery item's or avatar's file (on hold since filing)
 * is quarantined before it comes down, the same way; a listing's files -- every file the listing had when the
 * report was FILED (they have been on hold since, lib/media-preservation.js)
 * plus whatever it has now -- are QUARANTINED for the report first (kept,
 * never served, never deleted) and then the listing comes down; a text target
 * (comment, message) has its text, author and time copied onto the report
 * (`removedContent`) before it is deleted. Non-consensual reports get the text
 * copy too. Every report also carries the copy taken when it was filed
 * (`reportedContent`). Nothing here bans anyone automatically -- that stays
 * the admin's call.
 *
 * The report is CLAIMED before anything is removed (a `resolving` stamp set
 * only while it is open and unclaimed), and the final status change is
 * guarded on 'open' too: a second moderator, or a stale tab, gets 409 instead
 * of overwriting an 'actioned' possible-minor report with 'dismissed' -- and
 * never re-runs the removal. A claim is released on failure, and one left by
 * a function that died mid-resolve goes stale after CLAIM_STALE_SECONDS.
 * (A claim rather than a lock held across the removal: the removals run in
 * their own transactions, and holding a pool connection across them could
 * exhaust the small per-instance pool.)
 */
const CLAIM_STALE_SECONDS = 300;
// The same placeholder the admin avatar takedown resets to (pages/api/admin/avatar.js).
const AVATAR_PLACEHOLDER = '/images/avatar-placeholder.png';

async function claimReport(id, action) {
  const { rows } = await query(
    `update reports
        set data = data || jsonb_build_object('resolving', jsonb_build_object('action', $2::text, 'at', now()))
      where id = $1
        and data->>'status' = 'open'
        and (not (data ? 'resolving')
             or (data->'resolving'->>'at')::timestamptz < now() - ($3::int * interval '1 second'))
      returning id, data`,
    [String(id), action, CLAIM_STALE_SECONDS],
  );
  return rows.length ? { ...rows[0].data, id: rows[0].id } : null;
}

async function releaseClaim(id) {
  await query(`update reports set data = data - 'resolving' where id = $1`, [String(id)])
    .catch((err) => console.error('[admin/reports-resolve] could not release claim', id, err && err.message));
}
async function snapshot(reportId, content, client = null) {
  await (client ? client.query.bind(client) : query)(
    `update reports set data = data || jsonb_build_object('removedContent', $2::jsonb) where id = $1`,
    [String(reportId), JSON.stringify(content)],
  );
}

class AlreadyResolved extends Error {}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { id, action, reason } = req.body || {};
  if (!normalizeTargetId(id) || !['dismiss', 'remove_content', 'reopen'].includes(action)) {
    return res.status(400).json({ error: 'Missing report id or invalid action (dismiss | remove_content | reopen)' });
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason must be text' });
  }
  if (typeof reason === 'string' && reason.trim().length > REPORT_NOTE_MAX) {
    return res.status(400).json({ error: `Keep the reason under ${REPORT_NOTE_MAX} characters.`, field: 'reason', maxLength: REPORT_NOTE_MAX });
  }

  if (action === 'reopen') {
    try {
      const report = await reopenReport(String(id), { reason, by: 'admin' });
      return res.status(200).json({ ok: true, report });
    } catch (err) {
      if (err.code === REPORT_NOT_FOUND) return res.status(404).json({ error: 'Report not found' });
      if (err.code === REPORT_REASON_REQUIRED) return res.status(400).json({ code: 'reason_required', error: err.message });
      if (err.code === REPORT_NOT_REOPENABLE) {
        return res.status(409).json({ code: 'not_reopenable', error: 'Only a dismissed report can be reopened (this one is open, or its content was already removed).' });
      }
      console.error('[admin/reports-resolve] reopen failed:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  try {
    const first = await getReportById(String(id));
    if (!first) return res.status(404).json({ error: 'Report not found' });
    if (first.status !== 'open') {
      return res.status(409).json({ code: 'already_resolved', error: 'Someone else resolved this report first. Reload the queue.', report: first });
    }
    if (action === 'dismiss' && dismissNeedsReason(first) && !(typeof reason === 'string' && reason.trim())) {
      return res.status(400).json({ code: 'reason_required', error: 'A reason is required to dismiss a possible-minor or non-consensual report.' });
    }

    let contentNote = null;
    let preserved = 0;
    const report = await claimReport(first.id, action);
    if (!report) throw new AlreadyResolved();
    let updated;
    try {
      const keepText = report.category === 'minor' || report.category === 'non_consensual';

      if (action === 'remove_content') {
        if (report.targetType === 'message') {
          if (typeof report.conversationId !== 'string' || typeof report.targetId !== 'string') {
            contentNote = 'already_gone';
          } else {
            // The evidence copy is written in the removal's own transaction,
            // before the message is dropped: a failed copy leaves the message
            // in place (and the report open) instead of losing the only record.
            const gone = await removeConversationMessage(report.conversationId, report.targetId, {
              beforeRemove: keepText
                ? (c, m) => snapshot(report.id, { type: 'message', text: m.text, senderId: String(m.senderId), createdAt: m.createdAt }, c)
                : undefined,
            });
            contentNote = gone ? 'removed' : 'already_gone';
          }
        } else if (report.targetType === 'listing') {
          const targetId = normalizeTargetId(report.targetId);
          // Preservation and takedown in ONE transaction, with the listing
          // read under its file and row locks (lib/listings-store.js
          // takeDownListing): a file the seller finalized after an unlocked
          // read used to be missed by the quarantine and then deleted by the
          // takedown (round-8 media#1).
          const minor = report.category === 'minor';
          const held = minor ? (await heldPathsForReport(reportRef('report', report.id))).map(mediaSrc) : [];
          const out = await takeDownListing(targetId, {
            // Every file the report has held since it was filed (the seller
            // may have removed some from the listing meanwhile) plus what the
            // listing carries now (added by takeDownListing from the locked row).
            extraItems: minor
              ? [...held, ...(Array.isArray(report.reportedContent?.media) ? report.reportedContent.media : [])]
              : [],
            preserve: minor
              ? async (c, items) => {
                const kept = await preserveMedia(items, { reportId: reportRef('report', report.id), reason: `possible minor report (in-product) #${report.id}: listing ${targetId}`, client: c });
                // The preservation supersedes the hold.
                await releaseReportHolds(report.id, c);
                return kept;
              }
              : null,
          });
          preserved = out.preserved.length;
          contentNote = out.removed ? 'removed' : 'already_gone';
        } else if (PROFILE_MEDIA_TARGETS.includes(report.targetType)) {
          const creatorId = normalizeTargetId(report.targetId);
          const src = typeof report.src === 'string' ? report.src : null;
          if (report.category === 'minor') {
            // The held file (and the reported src) is quarantined first, in
            // its own commit: removing the item below then skips deleting it.
            const held = (await heldPathsForReport(reportRef('report', report.id))).map(mediaSrc);
            preserved = (await withTransaction(async (c) => {
              const out = await preserveMedia([...held, ...(src ? [src] : [])], {
                reportId: reportRef('report', report.id),
                reason: `possible minor report (in-product) #${report.id}: ${report.targetType} of creator ${creatorId}`,
                client: c,
              });
              await releaseReportHolds(report.id, c);
              return out;
            })).length;
          }
          contentNote = 'already_gone';
          if (creatorId && src) {
            if (report.targetType === 'gallery_item') {
              try {
                await removeGalleryItem(creatorId, { src });
                contentNote = 'removed';
              } catch (err) {
                if (err.code !== GALLERY_ITEM_GONE && err.message !== 'Creator not found') throw err;
              }
            } else {
              // Reset only while the reported photo is still the avatar: a
              // creator who has since replaced it must not lose the new one.
              const NOT_CURRENT = 'avatar_not_current';
              try {
                await setCreatorAvatar(creatorId, AVATAR_PLACEHOLDER, {
                  beforeChange: async (_client, current) => {
                    if (current !== src) throw Object.assign(new Error('Avatar changed'), { code: NOT_CURRENT });
                  },
                });
                contentNote = 'removed';
              } catch (err) {
                if (err.code !== NOT_CURRENT && err.message !== 'Creator not found') throw err;
              }
            }
          }
        } else if (report.targetType === 'wall_post') {
          const targetId = normalizeTargetId(report.targetId);
          if (!targetId) {
            contentNote = 'already_gone';
          } else {
            if (keepText) {
              const { rows: post } = await query('select data from wall_posts where id = $1', [targetId]);
              if (post.length) {
                await snapshot(report.id, { type: 'wall_post', text: post[0].data.text, authorId: String(post[0].data.authorId ?? ''), createdAt: post[0].data.createdAt });
              }
            }
            try {
              await deleteWallPost(targetId, 'admin', { isWallOwner: true });
              contentNote = 'removed';
            } catch (err) {
              // Only "it's already gone" is fine to treat as done. Anything
              // else (a DB error) must NOT be recorded as actioned -- the
              // content would stay live while the queue says it was removed.
              if (err.message !== 'Comment not found') throw err;
              contentNote = 'already_gone';
            }
          }
        } else {
          // An unrecognised target type cannot be acted on here, so it is not
          // marked actioned as though it had been.
          const e = new Error('unsupported target');
          e.code = 'unsupported_target';
          throw e;
        }
      }

      updated = await withTransaction(async (client) => {
        const out = await updateReportStatus(report.id, action === 'dismiss' ? 'dismissed' : 'actioned', 'admin', {
          reason: action === 'dismiss' ? reason : null,
          client,
          extra: action === 'remove_content' ? { contentOutcome: contentNote } : null,
        });
        if (!out) throw new AlreadyResolved();
        // A dismissal releases the report's file holds (nothing is preserved).
        if (action === 'dismiss') await releaseReportHolds(report.id, client);
        await client.query(`update reports set data = data - 'resolving' where id = $1`, [String(report.id)]);
        return { ...out, resolving: undefined };
      });
    } catch (err) {
      await releaseClaim(report.id);
      throw err;
    }
    if (preserved) await movePreservedToEvidence({ limit: preserved });
    return res.status(200).json({ ok: true, report: updated, content: contentNote, ...(preserved ? { preserved } : {}) });
  } catch (err) {
    if (err instanceof AlreadyResolved) {
      return res.status(409).json({ code: 'already_resolved', error: 'Someone else resolved this report first. Reload the queue.' });
    }
    if (err.code === 'unsupported_target') {
      return res.status(400).json({ error: 'This report type cannot be actioned automatically. Dismiss it or handle it by hand.' });
    }
    if (err.code === REPORT_NOT_FOUND) return res.status(404).json({ error: 'Report not found' });
    console.error('[admin/reports-resolve] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong -- the report is still open. Please try again.' });
  }
}
