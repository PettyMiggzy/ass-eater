import { query, rowToRecord, rowsToRecords, withTransaction, NCII_PRIORITY_SQL } from './db';
import { removeListingsForCreator } from './listings-store';
import { applyContentViolation } from './creators-store';
import { deleteMediaQuietly } from './blob-cleanup';
import { preserveMedia, movePreservedToEvidence, reportRef } from './media-preservation';
import { lockListingsWithFiles, listingFileItems } from './media-locks';
import { mediaPathnames } from './blob-cleanup';
import { pushCreatorStatus } from './server-api';
import { sliceText } from './unicode-text';

// Non-consensual intimate imagery (NCII) / deepfake takedown requests --
// the notice-and-removal process required by the federal TAKE IT DOWN Act.
// Deliberately separate from lib/reports-store.js (which requires a login
// and targets a specific wall post/listing already on the platform) --
// anyone, logged in or not, needs to be able to file one of these against
// any piece of content, and they get a 48-hour handling clock the general
// report queue doesn't have.
//
// These carry a federal legal deadline, so a filing must never be lost to
// another one landing at the same moment. Each insert is its own row, so
// concurrent filings cannot overwrite each other at all -- the previous
// whole-file rewrite could, and an ETag guard bolted onto it only narrowed
// the window rather than closing it.

export async function getNciiReports() {
  const { rows } = await query('select id, data from ncii_reports order by id');
  return rowsToRecords(rows);
}

/**
 * One page of the admin queue (round-12 social#0). The list endpoint used to
 * load EVERY request ever filed, filter it in JS and return them all in one
 * body; the form is public and unauthenticated, so a few hours of junk
 * filings pushed that body past the platform's 4.5 MB response limit and the
 * TAKEDOWN tab -- and the badge, which read the same response -- stopped
 * loading, with no way to dismiss the junk from the panel.
 *
 * Now: filtered by status in SQL, possible-minor filings first, then oldest
 * first (the identity id is the filing order; every one carries a 48-hour
 * clock), at most NCII_PAGE_MAX rows, keyset-paged by `cursor` (the
 * `nextCursor` of the previous page). Bounded by construction: a row is at
 * most ~8,400 characters of text (NCII_FIELD_LIMITS), and control
 * characters -- which JSON writes as 6-byte escapes -- are refused at
 * intake, so even NCII_PAGE_MAX worst-case rows stay far under the limit.
 *
 * `status` is 'all' or a status string ('open', 'removed', 'dismissed'...).
 * Returns { reports, hasMore, nextCursor }.
 */
export const NCII_PAGE_SIZE = 25;
export const NCII_PAGE_MAX = 50;
// Shared with the queue index in lib/db.js, which must match it exactly.

export async function getNciiReportsPage({ status = 'open', limit = NCII_PAGE_SIZE, cursor = null } = {}) {
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || NCII_PAGE_SIZE, 1), NCII_PAGE_MAX);
  const st = typeof status === 'string' && status ? status.slice(0, 40) : 'open';
  const m = typeof cursor === 'string' ? cursor.match(/^([01]):([1-9]\d{0,17})$/) : null;
  const { rows } = await query(
    `select id, data, ${NCII_PRIORITY_SQL} as prio from ncii_reports
      where ($1::text = 'all' or data->>'status' = $1::text)
        and ($2::int is null or (${NCII_PRIORITY_SQL}, id) > ($2::int, $3::bigint))
      order by ${NCII_PRIORITY_SQL}, id
      limit $4`,
    [st, m ? Number(m[1]) : null, m ? m[2] : null, size + 1],
  );
  const hasMore = rows.length > size;
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    reports: page.map((r) => rowToRecord({ id: r.id, data: r.data })),
    hasMore,
    nextCursor: hasMore && last ? `${last.prio}:${last.id}` : null,
  };
}

/**
 * Open-queue summary for the admin panel's TAKEDOWN REQUESTS badge: how many
 * are open and when the oldest one was filed, so the 48-hour clock is
 * visible without opening the tab.
 */
export async function getOpenNciiSummary() {
  const { rows } = await query(
    `select count(*)::int as open, min(data->>'createdAt') as oldest,
            count(*) filter (where data->>'category' = 'minor')::int as open_minor
       from ncii_reports
      where data->>'status' = 'open'`,
  );
  return { open: rows[0]?.open || 0, oldestOpenCreatedAt: rows[0]?.oldest || null, openMinor: rows[0]?.open_minor || 0 };
}

/**
 * Intake field limits, shared with pages/api/report-content.js (which refuses
 * anything longer with a 400) and the form (maxLength + counters). The store
 * used to cut contentLocation at 500 and description at 1000 characters with
 * no error, so a victim pasting ten links had three silently dropped while
 * being told the report was received -- and the admin removed only the rest,
 * under a 48-hour legal clock. The slices below are only a backstop now.
 */
export const NCII_FIELD_LIMITS = {
  reporterName: 200,
  reporterContact: 200,
  contentLocation: 4000,
  description: 4000,
};

/**
 * Who is filing, and about what:
 *   - 'self'        the person who appears (or someone authorized to act for
 *                   them) -- the TAKE IT DOWN Act notice. Signs the
 *                   "I appear in this / it was posted without consent" statement.
 *   - 'third_party' someone else reporting non-consensual content about
 *                   another person. Signs a plain good-faith statement only:
 *                   they cannot truthfully attest they are the person shown.
 *   - 'minor'       anyone reporting content they believe shows a person under
 *                   18. Same good-faith statement; sorted to the top of the
 *                   admin queue and handled with an immediate ban, not the
 *                   30-day ladder (Terms: zero tolerance).
 * A filing with no category is a 'self' filing (the form's original shape).
 */
export const NCII_CATEGORIES = ['self', 'third_party', 'minor'];

export function normalizeNciiCategory(category) {
  return NCII_CATEGORIES.includes(category) ? category : 'self';
}

export async function addNciiReport({ reporterName, reporterContact, contentLocation, description, consentStatement, category, goodFaithStatement }) {
  const cat = normalizeNciiCategory(category);
  const entry = {
    category: cat,
    reporterName: sliceText(reporterName || '', NCII_FIELD_LIMITS.reporterName),
    reporterContact: sliceText(reporterContact || '', NCII_FIELD_LIMITS.reporterContact),
    contentLocation: sliceText(contentLocation || '', NCII_FIELD_LIMITS.contentLocation),
    description: sliceText(description || '', NCII_FIELD_LIMITS.description),
    // Which statement the reporter actually signed. A third-party or minor
    // report never records the self-attestation as signed.
    consentStatement: cat === 'self' ? !!consentStatement : false,
    goodFaithStatement: cat === 'self' ? false : !!goodFaithStatement,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  const { rows } = await query('insert into ncii_reports (data) values ($1) returning id, data', [entry]);
  return rowToRecord(rows[0]);
}

/**
 * `expectedStatus` makes the "is this report still open?" test part of the
 * UPDATE rather than a separate read beforehand. It has to be: the resolve
 * route reads the report, updates it, and then decides whether to apply a
 * content violation -- and that decision was being made against the value
 * read BEFORE the update. Two admins (or one retried request) resolving the
 * same report both saw 'open' and both ran the enforcement ladder, which
 * turns a single complaint into a permanent ban.
 *
 * Returns null when the row exists but no longer matches `expectedStatus`,
 * so a caller can tell "already resolved" apart from "no such report".
 */
export async function updateNciiReportStatus(id, status, resolvedBy, expectedStatus = null) {
  const { rows } = await query(
    `update ncii_reports
        set data = data || jsonb_build_object('status', $2::text, 'resolvedBy', $3::text, 'resolvedAt', $4::text)
      where id = $1
        and ($5::text is null or data->>'status' = $5::text)
      returning id, data`,
    [id, status, resolvedBy ?? null, new Date().toISOString(), expectedStatus],
  );
  if (!rows.length) {
    if (expectedStatus === null) throw new Error('Report not found');
    return null;
  }
  return rowToRecord(rows[0]);
}

export const NCII_CREATOR_NOT_FOUND = 'ncii_creator_not_found';
export const NCII_ALREADY_RESOLVED = 'ncii_already_resolved';
export const NCII_REPORT_NOT_FOUND = 'ncii_report_not_found';
export const NCII_REASON_REQUIRED = 'ncii_reason_required';
export const NCII_NOT_REOPENABLE = 'ncii_not_reopenable';
export const NCII_NOTE_MAX = 1000;
export const NCII_TAKEDOWN_REQUIRED = 'ncii_takedown_required';

/**
 * Records one specific-item takedown against a takedown request (on the
 * caller's transaction `client`, or its own): appended to `takedowns` and to
 * `history`. `entry` is { type, target, result, preserved?, snapshot? }.
 * Throws NCII_REPORT_NOT_FOUND. Resolving a request as 'removed' requires one
 * of these (or an explicit "already gone" acknowledgement) -- see
 * resolveNciiReport's requireTakedown.
 */
export async function recordNciiTakedown(reportId, entry, client = null) {
  const at = new Date().toISOString();
  const item = { ...entry, at, by: entry?.by || 'admin' };
  const { rows } = await (client || { query }).query(
    `update ncii_reports
        set data = data || jsonb_build_object(
              'takedowns', coalesce(data->'takedowns', '[]'::jsonb) || jsonb_build_array($2::jsonb),
              'history', coalesce(data->'history', '[]'::jsonb) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                'action', 'takedown', 'by', $3::text, 'at', $4::text, 'type', $2::jsonb->>'type',
                'target', $2::jsonb->'target', 'result', $2::jsonb->>'result'))))
      where id = $1
      returning id, data`,
    [String(reportId), JSON.stringify(item), item.by, at],
  );
  if (!rows.length) throw Object.assign(new Error('Report not found'), { code: NCII_REPORT_NOT_FOUND });
  return rowToRecord(rows[0]);
}

/** A takedown request exists? (For routes that attribute an action to one.) */
export async function nciiReportExists(reportId) {
  if (!/^[1-9][0-9]{0,17}$/.test(String(reportId ?? ''))) return null;
  const { rows } = await query('select id, data from ncii_reports where id = $1', [String(reportId)]);
  return rows.length ? rowToRecord(rows[0]) : null;
}

function normalizeNciiNote(note) {
  if (typeof note !== 'string') return null;
  const text = note.replace(/\s+/g, ' ').trim();
  return text ? sliceText(text, NCII_NOTE_MAX) : null;
}

/**
 * Puts a DISMISSED takedown request back in the open queue (admin-ui#1): a
 * dismissal is one click from the removal buttons, and without this a
 * misclick on a POSSIBLE MINOR report took it off the 48-hour queue for good.
 * Only dismissals can be reopened -- a 'removed' resolution has already run
 * the enforcement ladder, which reopening would not undo. The reason is
 * required, and both the dismissal and the reopening stay in `history`.
 * The 48-hour clock is still counted from the ORIGINAL filing (createdAt).
 * Guarded on status = 'dismiss' inside the UPDATE, so a concurrent reopen or
 * resolve cannot interleave. Throws NCII_REPORT_NOT_FOUND / NCII_NOT_REOPENABLE
 * / NCII_REASON_REQUIRED.
 */
export async function reopenNciiReport(id, { reason, by = 'admin' } = {}) {
  const note = normalizeNciiNote(reason);
  if (!note) throw Object.assign(new Error('A reason is required to reopen a takedown request.'), { code: NCII_REASON_REQUIRED });
  const at = new Date().toISOString();
  const { rows } = await query(
    `update ncii_reports
        set data = (data - 'resolvedBy' - 'resolvedAt' - 'dismissReason' - 'attributedCreatorId')
                   || jsonb_build_object(
                        'status', 'open', 'reopenedAt', $2::text, 'reopenedBy', $3::text,
                        'history', coalesce(data->'history', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                          'action', 'reopened', 'by', $3::text, 'at', $2::text, 'reason', $4::text,
                          'previousReason', data->'dismissReason', 'previousResolvedAt', data->'resolvedAt')))
      where id = $1
        and data->>'status' = 'dismiss'
      returning id, data`,
    [id, at, by, note],
  );
  if (rows.length) return rowToRecord(rows[0]);
  const { rows: exists } = await query('select 1 from ncii_reports where id = $1', [id]);
  if (!exists.length) throw Object.assign(new Error('Report not found'), { code: NCII_REPORT_NOT_FOUND });
  throw Object.assign(new Error('Only a dismissed request can be reopened.'), { code: NCII_NOT_REOPENABLE });
}

/**
 * Resolves a takedown request and, when the admin attributes a confirmed
 * removal to a creator account, applies the enforcement ladder -- in ONE
 * transaction.
 *
 * These used to be two separately committed statements: the report flipped
 * to 'removed' first, then the ladder ran. If the ladder then failed (the
 * attributed creator deleted since the picker loaded, a dropped connection),
 * the report already read as resolved, a retry hit the "already resolved"
 * guard, and the confirmed violation was never counted -- so a creator's
 * next confirmed deepfake earned a suspension instead of the ban the Terms
 * promise. Now the status change, the violation count and the creator's
 * status/suspension commit or roll back together, and a failure leaves the
 * report open so the admin can simply try again. A ban's listing takedown
 * is recorded in the same commit; only the file deletion follows it.
 *
 * A report filed as category 'minor' that is resolved 'removed' against a
 * creator bans that creator outright in the same transaction (not the
 * 30-day ladder); `outrightBan` in the result says it happened. In that case
 * every file of the creator is PRESERVED as evidence rather than deleted
 * (banCreatorForMinorReportTx below); the report records their pathnames in
 * `preservedMedia` -- merged with anything already preserved for it -- and
 * `preservedCount` is the size of that merged list.
 *
 * The 'open' guard is still part of the UPDATE, so two concurrent resolves
 * of the same report cannot both run the ladder.
 */
export async function resolveNciiReport(id, action, { creatorId = null, resolvedBy = 'admin', reason = null, requireTakedown = false, contentGone = false } = {}) {
  const attributed = action === 'removed' && creatorId !== null && creatorId !== undefined && String(creatorId) !== '';
  // A dismissal takes a legally clocked request out of the open queue, so it
  // must say why (admin-ui#1): the reason is required and stored on the
  // report, next to who dismissed it and when.
  const dismissReason = action === 'dismiss' ? normalizeNciiNote(reason) : null;
  if (action === 'dismiss' && !dismissReason) {
    throw Object.assign(new Error('A reason is required to dismiss a takedown request.'), { code: NCII_REASON_REQUIRED });
  }
  const result = await withTransaction(async (client) => {
    if (attributed) {
      // Locked FOR UPDATE, before the report row below: every path that
      // touches both rows takes the CREATOR first. An admin gallery/avatar
      // removal attributed to this request locks the creator
      // (removeGalleryItem / setCreatorAvatar) and then this report
      // (preserveMediaForReportTx / recordNciiTakedown); this used to update
      // the report first and the creator later (applyContentViolation), so
      // the two running together deadlocked and one admin got a 500.
      const { rows: found } = await client.query('select id from creators where id = $1 for update', [String(creatorId)]);
      if (!found.length) throw Object.assign(new Error('That creator no longer exists.'), { code: NCII_CREATOR_NOT_FOUND });
    }

    const { rows } = await client.query(
      `update ncii_reports
          set data = data || jsonb_build_object(
                'status', $2::text, 'resolvedBy', $3::text, 'resolvedAt', $4::text,
                'attributedCreatorId', $5::text, 'dismissReason', $6::text,
                'history', coalesce(data->'history', '[]'::jsonb) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                  'action', $2::text, 'by', $3::text, 'at', $4::text, 'reason', $6::text,
                  'creatorId', $5::text))))
        where id = $1
          and data->>'status' = 'open'
        returning id, data`,
      [id, action, resolvedBy, new Date().toISOString(), attributed ? String(creatorId) : null, dismissReason],
    );
    if (!rows.length) {
      const { rows: exists } = await client.query('select 1 from ncii_reports where id = $1', [id]);
      if (!exists.length) throw Object.assign(new Error('Report not found'), { code: NCII_REPORT_NOT_FOUND });
      throw Object.assign(new Error('That report was already resolved.'), { code: NCII_ALREADY_RESOLVED });
    }

    // The ONE ladder (lib/creators-store.js), run on this transaction's
    // client so the count, the creator's status and the report's resolution
    // commit together, and keyed by this report id so a retry can never
    // count it twice. It keeps a pending applicant pending (never a
    // suspension that lapses into 'active' without approval) and keeps a
    // banned creator banned. This file used to carry its own copy of the
    // ladder that had neither guard, and it was the only copy that ran.
    let creator = null;
    if (attributed) {
      try {
        creator = await applyContentViolation(String(creatorId), client, { reportId: String(id) });
      } catch (err) {
        if (err && err.message === 'Creator not found') {
          throw Object.assign(new Error('That creator no longer exists.'), { code: NCII_CREATOR_NOT_FOUND });
        }
        throw err;
      }
    }
    // A POSSIBLE MINOR report is not the 30-day ladder: the Terms promise
    // immediate, permanent termination. The category is read from the STORED
    // report (what the reporter filed), never from the admin's request, and
    // the ban commits in this same transaction as the resolution and the
    // violation count. It used to be a second request from the panel through
    // /api/admin/profile, whose manual-ban takedown keeps PAID listings'
    // files serving to earlier buyers -- so a creator banned over suspected
    // child sexual content kept distributing whatever they had already sold.
    // The takedown below runs without keepPaid for every NCII ban.
    const outrightBan = attributed && normalizeNciiCategory(rows[0].data?.category) === 'minor';
    // A ban also takes the creator's listings off sale, in this same commit,
    // and records their files for deletion (media_uploads) in it too. The
    // files themselves are deleted after COMMIT -- deletion cannot be rolled
    // back -- and anything that step does not reach is finished by the
    // orphan sweep. (It used to run entirely after the commit, so a failure
    // left a banned creator's listings live with only a log line.) No
    // keepPaid here: an NCII ban (ladder or possible-minor) takes paid
    // listings' files down too, unlike a manual ban from the creator record.
    //
    // A POSSIBLE MINOR report: the whole outright ban -- status, founding
    // cleared, every file quarantined as evidence, every listing down with no
    // keepPaid -- is banCreatorForMinorReportTx, shared with the in-product
    // report resolver (pages/api/admin/reports-resolve.js 'remove_and_ban'),
    // so the outcome no longer depends on which of the two report forms the
    // reporter picked (round-12 legal-journeys#0).
    let preserved = [];
    let files = [];
    if (outrightBan && creator) {
      ({ creator, preserved, files } = await banCreatorForMinorReportTx(client, String(creator.id), {
        ref: reportRef('ncii', id),
        label: `possible minor report #${id}`,
      }));
    } else if (creator?.status === 'banned') {
      ({ files } = await removeListingsForCreator(String(creator.id), { moderation: true, client }));
    }
    // The creator's new standing is queued for server/ in this same commit
    // (lib/standing-outbox.js); the route delivers it after the commit.
    let pushUid = null;
    if (creator) pushUid = (await pushCreatorStatus(String(creator.id), { client })).uid || null;

    // 'removed' is a statement that the content is down. The admin route
    // (requireTakedown) only lets it be recorded when that is on file: a
    // specific-item takedown recorded against this request
    // (/api/admin/content-takedown, or a gallery/avatar removal attributed to
    // it), a POSSIBLE-MINOR outright ban in this same commit (every file of
    // the creator is quarantined, so nothing of theirs is served any more),
    // or the admin's explicit
    // acknowledgement that the content is already gone or was removed
    // elsewhere (`contentGone`, recorded on the report). The panel used to
    // ask "confirm you have already removed it" while offering no way to
    // remove a listing, DM or comment at all.
    if (action === 'removed' && requireTakedown) {
      // Only a takedown that actually took something down counts. An entry
      // whose result is 'already_gone' (a mistyped listing/comment/message
      // id finds nothing and records exactly that) proves nothing about the
      // reported content, which may still be up; with only those on file the
      // admin has to say explicitly that the content is gone (contentGone).
      const takedowns = Array.isArray(rows[0].data?.takedowns) ? rows[0].data.takedowns : [];
      const removedCount = takedowns.filter((t) => t && t.result === 'removed').length;
      // A ladder ban is NOT a basis by itself (round-16 media#0): it takes
      // the creator's listings down but only HIDES their gallery and avatar,
      // whose files stay stored, stay referenced and come back if the ban is
      // ever lifted -- so 'removed' would be recorded for an image that is
      // still there. Only the possible-minor outright ban, which quarantines
      // every file of the creator, proves the reported content is down.
      const basis = removedCount ? 'takedown' : outrightBan && creator ? 'ban' : contentGone ? 'acknowledged' : null;
      if (!basis) {
        throw Object.assign(new Error('Record the takedown first, or confirm the content is already gone.'), { code: NCII_TAKEDOWN_REQUIRED });
      }
      const { rows: based } = await client.query(
        `update ncii_reports set data = data || jsonb_build_object('removalBasis', $2::text) where id = $1 returning id, data`,
        [id, basis],
      );
      rows[0] = based[0];
    }

    let report = rowToRecord(rows[0]);
    if (outrightBan && creator) {
      // MERGED into what the report already records, exactly as
      // preserveMediaForReportTx does -- not overwritten. Files preserved for
      // this request earlier (the gallery item or listing file the admin
      // already took down) are no longer on the creator, so the creator-wide
      // preservation here does not include them; overwriting dropped them from
      // the request's record of its CSAM evidence (round-11 social#0). The
      // first preservedAt is kept.
      const { rows: marked } = await client.query(
        `with merged as (
           select coalesce(jsonb_agg(distinct x), '[]'::jsonb) as media
             from ncii_reports r, jsonb_array_elements_text(coalesce(r.data->'preservedMedia', '[]'::jsonb) || $2::jsonb) as x
            where r.id = $1
         )
         update ncii_reports
            set data = data || jsonb_build_object(
                  'preservedMedia', (select media from merged),
                  'preservedAt', coalesce(data->>'preservedAt', $3::text),
                  'preservedCount', jsonb_array_length((select media from merged)))
          where id = $1
          returning id, data`,
        [id, JSON.stringify(preserved), new Date().toISOString()],
      );
      report = rowToRecord(marked[0]);
    }
    return { report, creator, files, preserved, pushUid, outrightBan: !!(outrightBan && creator) };
  });

  const { files, preserved, ...out } = result;
  // deleteMediaQuietly never deletes a preserved file (it re-checks), so the
  // quarantined ones are skipped here even though the takedown listed them.
  if (files.length) await deleteMediaQuietly(files);
  if (preserved.length) await movePreservedToEvidence({ limit: Math.min(preserved.length, 200) });
  return { ...out, preservedCount: preserved.length };
}

/**
 * Every stored media src a creator has -- avatar, hero video, gallery, and
 * every listing's media and retainedMedia -- read UNDER LOCK on the caller's
 * transaction: the creator row FOR UPDATE (a no-op when the caller already
 * holds it; gallery and avatar changes take that lock, so they cannot change
 * underneath), then every file's advisory lock in one sorted pass, then the
 * listing rows (lib/media-locks.js order). A file finalized onto a listing
 * after an unlocked read used to be missed by the preservation and deleted by
 * the takedown (round-8 media#1). Returns [] for no such creator.
 */
export async function lockCreatorMediaItems(client, creatorId, extraItems = []) {
  const { rows: c } = await client.query('select data from creators where id = $1 for update', [String(creatorId)]);
  if (!c.length) return null;
  const d = c[0].data || {};
  const profileItems = [d.img, d.video, ...(Array.isArray(d.gallery) ? d.gallery : [])];
  const { rows: ls } = await lockListingsWithFiles(client, { creatorId: String(creatorId), extraItems: [...extraItems, ...profileItems] });
  return [...extraItems, ...profileItems, ...ls.flatMap((r) => listingFileItems(r.data))];
}

/**
 * The OUTRIGHT BAN for content confirmed to show a possible minor, on the
 * caller's transaction `client` (Terms section 8: removed, and the account
 * banned permanently -- not the 30-day ladder). Shared by the TAKE IT DOWN
 * resolve (resolveNciiReport) and the in-product report resolve
 * (pages/api/admin/reports-resolve.js 'remove_and_ban'), which used to have
 * no ban path at all: the admin's only route was the Creators-tab save, whose
 * keepPaid takedown kept every paid listing's files serving to earlier buyers
 * and preserved nothing (round-12 legal-journeys#0).
 *
 * In order, all in the caller's commit:
 *   1. the creator row FOR UPDATE, then status 'banned' (suspension cleared,
 *      founding revoked) unless already banned;
 *   2. every file the creator has -- avatar, hero video, gallery, every
 *      listing's media and retainedMedia, sold or not -- QUARANTINED as
 *      evidence under `ref` ('ncii:<id>' or 'report:<id>',
 *      lib/media-preservation.js reportRef): 18 U.S.C. 2258A requires the
 *      material be preserved. This takes the creator's file locks before any
 *      listing row lock (lib/media-locks.js order);
 *   3. every listing off sale with NO keepPaid (removeListingsForCreator,
 *      moderation), so /api/media and order delivery stop serving them.
 *
 * Returns { creator (the banned record), preserved (pathnames), files (to
 * delete after the commit -- preserved ones already left out) }. The caller
 * queues pushCreatorStatus and, after its commit, deletes `files` and runs
 * movePreservedToEvidence. Throws NCII_CREATOR_NOT_FOUND for no such creator.
 */
export async function banCreatorForMinorReportTx(client, creatorId, { ref, label = 'possible minor report' } = {}) {
  const { rows: found } = await client.query('select id, data from creators where id = $1 for update', [String(creatorId)]);
  if (!found.length) throw Object.assign(new Error('That creator no longer exists.'), { code: NCII_CREATOR_NOT_FOUND });
  let creator = rowToRecord(found[0]);
  if (creator.status !== 'banned') {
    const { rows: banned } = await client.query(
      `update creators
          set data = data || jsonb_build_object(
                'status', 'banned',
                'suspendedUntil', null,
                'founding', false,
                'foundingSince', null,
                'foundingRevokedAt', case when coalesce((data->>'founding')::boolean, false)
                                          then to_jsonb($2::text) else data->'foundingRevokedAt' end),
              updated_at = now()
        where id = $1
        returning id, data`,
      [String(creator.id), new Date().toISOString()],
    );
    if (!banned.length) throw Object.assign(new Error('That creator no longer exists.'), { code: NCII_CREATOR_NOT_FOUND });
    creator = rowToRecord(banned[0]);
  }
  const items = (await lockCreatorMediaItems(client, String(creator.id))) || [];
  const preserved = await preserveMedia(items, {
    reportId: ref,
    reason: `${label}: all media of creator ${creator.id}`,
    client,
  });
  let { files } = await removeListingsForCreator(String(creator.id), { moderation: true, client });
  // Preserved files never go on the deletion list: recordPendingDeletions
  // and deleteMediaQuietly both skip them anyway, but there is no reason to
  // hand them to a deleter at all.
  if (preserved.length) {
    const kept = new Set(preserved);
    files = files.filter((f) => !mediaPathnames([f]).some((p) => kept.has(p)));
  }
  return { creator, preserved, files };
}

/**
 * Admin preservation of specific items for a report (any NCII category) --
 * used BEFORE removing something reported as showing a minor that is not
 * covered by resolving the report against a creator (a wall photo, one
 * listing of an account that is not being banned yet). The report must exist.
 * Returns { reportId, preserved: pathname[] }.
 */
export async function preserveMediaForReport(reportId, items, { reason = null } = {}) {
  const preserved = await withTransaction((client) => preserveMediaForReportTx(client, reportId, items, { reason }));
  if (preserved.length) await movePreservedToEvidence({ limit: Math.min(preserved.length, 200) });
  return { reportId: String(reportId), preserved };
}

/**
 * Admin preservation of EVERY file of one creator (plus `srcs`) for a report,
 * with the file list read under lock in the same transaction as the
 * preservation (lockCreatorMediaItems). The route used to read the gallery
 * and listings with no lock and preserve that snapshot, so a file added in
 * between was not preserved. Lock order: creator row, report row, files,
 * listing rows -- the same as the resolve and an attributed gallery/avatar
 * removal. Throws NCII_REPORT_NOT_FOUND / NCII_CREATOR_NOT_FOUND. Returns
 * { reportId, preserved }.
 */
export async function preserveCreatorMediaForReport(reportId, creatorId, srcs = []) {
  const preserved = await withTransaction(async (client) => {
    const { rows: found } = await client.query('select id from creators where id = $1 for update', [String(creatorId)]);
    if (!found.length) throw Object.assign(new Error('That creator no longer exists.'), { code: NCII_CREATOR_NOT_FOUND });
    const { rows } = await client.query('select id from ncii_reports where id = $1 for update', [String(reportId)]);
    if (!rows.length) throw Object.assign(new Error('Report not found'), { code: NCII_REPORT_NOT_FOUND });
    const items = (await lockCreatorMediaItems(client, String(creatorId), srcs)) || [];
    return preserveMediaForReportTx(client, String(reportId), items);
  });
  if (preserved.length) await movePreservedToEvidence({ limit: Math.min(preserved.length, 200) });
  return { reportId: String(reportId), preserved };
}

/**
 * The same, on the caller's transaction `client`, so the preservation commits
 * or rolls back with the removal it protects (pages/api/admin/gallery-delete.js
 * preserves inside the locked transaction that removes the item: a removal
 * that finds the item already gone rolls the quarantine back too). The caller
 * runs movePreservedToEvidence after its commit. Throws NCII_REPORT_NOT_FOUND
 * when the report does not exist. Returns the preserved pathnames.
 */
export async function preserveMediaForReportTx(client, reportId, items, { reason = null } = {}) {
  const { rows } = await client.query('select id from ncii_reports where id = $1 for update', [reportId]);
  if (!rows.length) throw Object.assign(new Error('Report not found'), { code: NCII_REPORT_NOT_FOUND });
  const preserved = await preserveMedia(items, { reportId: reportRef('ncii', reportId), reason: reason || `preserved for report #${reportId}`, client });
  if (preserved.length) {
    await client.query(
      `update ncii_reports
          set data = data || jsonb_build_object(
                'preservedMedia', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                                     from jsonb_array_elements_text(coalesce(data->'preservedMedia', '[]'::jsonb) || $2::jsonb) as x),
                'preservedAt', coalesce(data->>'preservedAt', $3::text))
        where id = $1`,
      [reportId, JSON.stringify(preserved), new Date().toISOString()],
    );
  }
  return preserved;
}
