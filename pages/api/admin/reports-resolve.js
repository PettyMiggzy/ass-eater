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
import { banCreatorForMinorReportTx, lockCreatorMediaItems, NCII_CREATOR_NOT_FOUND } from '../../../lib/ncii-reports-store';
import { pushCreatorStatus, deliverFor, reportPushFailure } from '../../../lib/server-api';
import { deleteMediaQuietly } from '../../../lib/blob-cleanup';
import { requireAdminKey } from '../../../lib/admin-auth';
import { query, withTransaction } from '../../../lib/db';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * POST /api/admin/reports-resolve   Header x-admin-key.
 *   { id, action: 'remove_content' }        -> 200 { ok, report, content: 'removed' | 'already_gone', preserved?: number }
 *   { id, action: 'remove_and_ban' }        -> 200 { ok, report, content, preserved?: number, bannedCreatorId }
 *        a 'minor' report only (400 { code: 'not_minor' } otherwise), and only
 *        when the reported content resolves to a CREATOR account (400
 *        { code: 'no_creator' } for a fan's comment or message, or a creator
 *        deleted since): does everything remove_content does, then -- in one
 *        transaction with the status change -- bans that creator outright,
 *        quarantines every file they have for this report and takes all their
 *        listings down with no keepPaid (lib/ncii-reports-store.js
 *        banCreatorForMinorReportTx, the same ban a possible-minor TAKE IT
 *        DOWN resolve applies)
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
 * the admin's call: 'remove_and_ban' is the explicit possible-minor ban
 * (round-12 legal-journeys#0). It is the ONLY ban that honours Terms section
 * 8 for an in-product report: the Creators-tab ban keeps paid listings'
 * files serving (keepPaid, deliberate for bans that are not about content)
 * and preserves nothing.
 *
 * The report is CLAIMED before anything is removed (a `resolving` stamp set
 * only while it is open and unclaimed), and the final status change is
 * guarded on 'open' too: a second moderator, or a stale tab, gets 409 instead
 * of overwriting an 'actioned' possible-minor report with 'dismissed' -- and
 * never re-runs the removal. A claim is released on failure, and one left by
 * a function that died mid-resolve goes stale after CLAIM_STALE_SECONDS.
 *
 * A listing, message or wall-comment removal commits in the SAME transaction
 * as the report's status (and any ban), and a listing's files are deleted
 * only after that commit (round-16 media#1 / social#1): a failure part-way
 * leaves the content up and the report open, never the content gone with the
 * report still open and the retry recording 'already_gone'. A gallery item or
 * avatar is removed in its own transaction (it has to be, to delete the file
 * it replaced), which also stamps `contentRemovedAt` on the report; a retry
 * then records 'removed', and a report so stamped cannot be dismissed
 * (409 { code: 'content_removed' }).
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

/**
 * The creator account behind a report's target, for 'remove_and_ban', or
 * null when there is none: a listing's seller; the creator whose gallery
 * item or avatar it is; a message's sender or a wall comment's author only
 * when that user is (still) a creator account. Read from the database, never
 * from the admin's request; the filing-time copy (`reportedContent`) is the
 * fallback for a target already gone.
 */
async function reportCreatorId(report) {
  const tid = normalizeTargetId(report.targetId);
  const rc = report.reportedContent && typeof report.reportedContent === 'object' ? report.reportedContent : {};
  let creatorId = null;
  let authorUserId = null;
  if (report.targetType === 'listing') {
    if (tid) {
      const { rows } = await query(`select data->>'creatorId' as creator_id from listings where id::text = $1`, [tid]);
      creatorId = rows[0]?.creator_id || null;
    }
    if (!creatorId && rc.creatorId) creatorId = String(rc.creatorId);
  } else if (PROFILE_MEDIA_TARGETS.includes(report.targetType)) {
    creatorId = tid;
  } else if (report.targetType === 'message') {
    authorUserId = rc.senderId || null;
    if (!authorUserId && typeof report.conversationId === 'string' && typeof report.targetId === 'string') {
      const { rows } = await query('select data from conversations where id = $1', [report.conversationId]);
      const m = (Array.isArray(rows[0]?.data?.messages) ? rows[0].data.messages : []).find((x) => x && x.id === report.targetId);
      authorUserId = m ? m.senderId : null;
    }
  } else if (report.targetType === 'wall_post') {
    authorUserId = rc.authorId || null;
    if (!authorUserId && tid) {
      const { rows } = await query(`select data->>'authorId' as author_id from wall_posts where id = $1`, [tid]);
      authorUserId = rows[0]?.author_id || null;
    }
  }
  if (authorUserId !== null && authorUserId !== undefined && String(authorUserId) !== '') {
    const { rows } = await query(
      `select data->>'role' as role, data->>'creatorId' as creator_id from users where id::text = $1`,
      [String(authorUserId)],
    );
    creatorId = rows[0]?.role === 'creator' && rows[0]?.creator_id ? rows[0].creator_id : null;
  }
  if (!creatorId) return null;
  const { rows } = await query('select 1 from creators where id = $1', [String(creatorId)]);
  return rows.length ? String(creatorId) : null;
}

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { id, action, reason } = req.body || {};
  if (!normalizeTargetId(id) || !['dismiss', 'remove_content', 'remove_and_ban', 'reopen'].includes(action)) {
    return res.status(400).json({ error: 'Missing report id or invalid action (dismiss | remove_content | remove_and_ban | reopen)' });
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

    // 'remove_and_ban' is decided before anything is claimed or removed: a
    // report that cannot lead to a ban must not come down half-done.
    let banCreatorId = null;
    if (action === 'remove_and_ban') {
      if (first.category !== 'minor') {
        return res.status(400).json({ code: 'not_minor', error: 'Remove and ban is only for reports filed as possibly showing someone under 18.' });
      }
      banCreatorId = await reportCreatorId(first);
      if (!banCreatorId) {
        return res.status(400).json({
          code: 'no_creator',
          error: 'This content was not posted by a creator account, so there is no creator to ban. Use Remove Content, and suspend or ban the account from the Accounts tab.',
        });
      }
    }
    const removing = action === 'remove_content' || action === 'remove_and_ban';

    let contentNote = null;
    // Pathnames, not a running count: remove_and_ban preserves the reported
    // item and then every file of the creator under the same report ref, and
    // the second preservation returns the first one's files again (it is
    // idempotent) -- summing the two overstated what was kept.
    const preservedPaths = new Set();
    let banFiles = [];
    let pushUid = null;
    const report = await claimReport(first.id, action);
    if (!report) throw new AlreadyResolved();
    let updated;
    // Files the removal took off a listing; deleted only after the commit
    // (round-16 media#1 / social#1).
    let removedFiles = [];
    try {
      const keepText = report.category === 'minor' || report.category === 'non_consensual';
      // A gallery item or avatar is removed in its own transaction (below);
      // that transaction also stamps the report, so a retry after a failure
      // between the two still records 'removed' rather than 'already_gone'
      // and the report cannot then be dismissed as though nothing came down.
      const markRemoved = (c) => c.query(
        `update reports set data = data || jsonb_build_object('contentRemovedAt', to_jsonb(now()::text), 'contentRemovedBy', $2::text)
          where id = $1`,
        [String(report.id), action],
      );
      const removedEarlier = !!report.contentRemovedAt;
      if (action === 'dismiss' && removedEarlier) {
        const e = new Error('content already removed');
        e.code = 'content_removed';
        throw e;
      }

      if (removing && PROFILE_MEDIA_TARGETS.includes(report.targetType)) {
        const creatorId = normalizeTargetId(report.targetId);
        const src = typeof report.src === 'string' ? report.src : null;
        if (report.category === 'minor') {
          // The held file (and the reported src) is quarantined first, in
          // its own commit: removing the item below then skips deleting it.
          const held = (await heldPathsForReport(reportRef('report', report.id))).map(mediaSrc);
          const kept = await withTransaction(async (c) => {
            const out = await preserveMedia([...held, ...(src ? [src] : [])], {
              reportId: reportRef('report', report.id),
              reason: `possible minor report (in-product) #${report.id}: ${report.targetType} of creator ${creatorId}`,
              client: c,
            });
            await releaseReportHolds(report.id, c);
            return out;
          });
          for (const p of kept) preservedPaths.add(p);
        }
        contentNote = 'already_gone';
        if (creatorId && src) {
          if (report.targetType === 'gallery_item') {
            try {
              await removeGalleryItem(creatorId, { src, beforeRemove: (c) => markRemoved(c) });
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
                beforeChange: async (c, current) => {
                  if (current !== src) throw Object.assign(new Error('Avatar changed'), { code: NOT_CURRENT });
                  await markRemoved(c);
                },
              });
              contentNote = 'removed';
            } catch (err) {
              if (err.code !== NOT_CURRENT && err.message !== 'Creator not found') throw err;
            }
          }
        }
      }

      // Everything else -- the listing, message or wall-comment removal, the
      // outright ban and the report's status -- commits in ONE transaction
      // (round-16 media#1 / social#1). The removals used to commit on their
      // own first (a listing's files were even deleted before the report was
      // touched), so a failure in between left the content gone and the
      // report open, and the retry recorded 'already_gone' -- or let it be
      // dismissed. Now a failure rolls the removal back with the rest, and
      // files are deleted only after COMMIT. Lock order as elsewhere: the
      // creator and every file and listing row (when banning), then the
      // conversation / wall rows, then the report rows.
      updated = await withTransaction(async (client) => {
        const listingExtra = [];
        let minorListingHeld = [];
        if (removing && report.targetType === 'listing' && report.category === 'minor') {
          minorListingHeld = (await heldPathsForReport(reportRef('report', report.id), client)).map(mediaSrc);
          listingExtra.push(...minorListingHeld, ...(Array.isArray(report.reportedContent?.media) ? report.reportedContent.media : []));
        }
        if (banCreatorId) {
          // Creator, then every file (the listing's held extras too), then
          // the listing rows -- taken up front so the takedown and the ban
          // below only re-enter locks this transaction already holds.
          const locked = await lockCreatorMediaItems(client, banCreatorId, listingExtra);
          if (!locked) throw Object.assign(new Error('That creator no longer exists.'), { code: NCII_CREATOR_NOT_FOUND });
        }

        if (removing && report.targetType === 'listing') {
          const targetId = normalizeTargetId(report.targetId);
          // Preservation and takedown with the listing read under its file
          // and row locks (lib/listings-store.js takeDownListing): a file the
          // seller finalized after an unlocked read used to be missed by the
          // quarantine and then deleted by the takedown (round-8 media#1).
          const minor = report.category === 'minor';
          const out = await takeDownListing(targetId, {
            // Every file the report has held since it was filed (the seller
            // may have removed some from the listing meanwhile) plus what the
            // listing carries now (added by takeDownListing from the locked row).
            extraItems: listingExtra,
            preserve: minor
              ? async (c, items) => {
                const kept = await preserveMedia(items, { reportId: reportRef('report', report.id), reason: `possible minor report (in-product) #${report.id}: listing ${targetId}`, client: c });
                // The preservation supersedes the hold.
                await releaseReportHolds(report.id, c);
                return kept;
              }
              : null,
            client,
          });
          for (const p of out.preserved) preservedPaths.add(p);
          removedFiles = out.files || [];
          contentNote = out.removed ? 'removed' : 'already_gone';
        }

        let bannedCreatorId = null;
        if (banCreatorId) {
          const ban = await banCreatorForMinorReportTx(client, banCreatorId, {
            ref: reportRef('report', report.id),
            label: `possible minor report (in-product) #${report.id}`,
          });
          banFiles = ban.files;
          for (const p of ban.preserved) preservedPaths.add(p);
          bannedCreatorId = String(ban.creator.id);
          pushUid = (await pushCreatorStatus(bannedCreatorId, { client })).uid || null;
        }

        if (removing && report.targetType === 'message') {
          if (typeof report.conversationId !== 'string' || typeof report.targetId !== 'string') {
            contentNote = 'already_gone';
          } else {
            // The evidence copy is written before the message is dropped, in
            // this same commit.
            const gone = await removeConversationMessage(report.conversationId, report.targetId, {
              beforeRemove: keepText
                ? (c, m) => snapshot(report.id, { type: 'message', text: m.text, senderId: String(m.senderId), createdAt: m.createdAt }, c)
                : undefined,
              client,
            });
            contentNote = gone ? 'removed' : 'already_gone';
          }
        } else if (removing && report.targetType === 'wall_post') {
          const targetId = normalizeTargetId(report.targetId);
          if (!targetId) {
            contentNote = 'already_gone';
          } else {
            // Every report on this comment is locked first, in id order --
            // the same lock deleteWallPost takes below -- so the snapshot
            // (which writes THIS report's row) cannot hold one report row
            // while another admin resolving a second report on the same
            // comment holds theirs: that inverted order deadlocked.
            await client.query(
              `select 1 from reports where data->>'targetType' = 'wall_post' and data->>'targetId' = $1 order by id for update`,
              [targetId],
            );
            if (keepText) {
              const { rows: post } = await client.query('select data from wall_posts where id = $1', [targetId]);
              if (post.length) {
                await snapshot(report.id, { type: 'wall_post', text: post[0].data.text, authorId: String(post[0].data.authorId ?? ''), createdAt: post[0].data.createdAt }, client);
              }
            }
            try {
              await deleteWallPost(targetId, 'admin', { isWallOwner: true, client });
              contentNote = 'removed';
            } catch (err) {
              // Only "it's already gone" is fine to treat as done (it is
              // thrown before anything is written). Anything else (a DB
              // error) must NOT be recorded as actioned.
              if (err.message !== 'Comment not found') throw err;
              contentNote = 'already_gone';
            }
          }
        } else if (removing && report.targetType !== 'listing' && !PROFILE_MEDIA_TARGETS.includes(report.targetType)) {
          // An unrecognised target type cannot be acted on here, so it is not
          // marked actioned as though it had been.
          const e = new Error('unsupported target');
          e.code = 'unsupported_target';
          throw e;
        }

        // A gallery/avatar removal an earlier, interrupted attempt of THIS
        // report already committed is recorded as removed, not already_gone.
        if (removing && contentNote === 'already_gone' && removedEarlier) contentNote = 'removed';

        const out = await updateReportStatus(report.id, action === 'dismiss' ? 'dismissed' : 'actioned', 'admin', {
          reason: action === 'dismiss' ? reason : null,
          client,
          extra: removing ? { contentOutcome: contentNote, ...(bannedCreatorId ? { bannedCreatorId } : {}) } : null,
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
    // After the commit: deletion cannot be rolled back (deleteMediaQuietly
    // re-checks and skips anything preserved), and the new standing reaches
    // server/ now, retried by the cron if this delivery fails.
    if (removedFiles.length || banFiles.length) await deleteMediaQuietly([...removedFiles, ...banFiles]);
    const preserved = preservedPaths.size;
    if (preserved) await movePreservedToEvidence({ limit: Math.min(preserved, 200) });
    if (pushUid) reportPushFailure(await deliverFor([pushUid]), `report ${report.id} ban`);
    return res.status(200).json({
      ok: true,
      report: updated,
      content: contentNote,
      ...(preserved ? { preserved } : {}),
      ...(banCreatorId ? { bannedCreatorId: banCreatorId } : {}),
    });
  } catch (err) {
    if (err instanceof AlreadyResolved) {
      return res.status(409).json({ code: 'already_resolved', error: 'Someone else resolved this report first. Reload the queue.' });
    }
    if (err.code === 'content_removed') {
      return res.status(409).json({
        code: 'content_removed',
        error: 'This content was already taken down by an earlier attempt -- use Remove Content to finish recording it, not Dismiss.',
      });
    }
    if (err.code === 'unsupported_target') {
      return res.status(400).json({ error: 'This report type cannot be actioned automatically. Dismiss it or handle it by hand.' });
    }
    if (err.code === REPORT_NOT_FOUND) return res.status(404).json({ error: 'Report not found' });
    if (err.code === NCII_CREATOR_NOT_FOUND) {
      return res.status(409).json({ code: 'no_creator', error: 'That creator account no longer exists -- the report is still open. Reload and use Remove Content.' });
    }
    console.error('[admin/reports-resolve] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong -- the report is still open. Please try again.' });
  }
}
