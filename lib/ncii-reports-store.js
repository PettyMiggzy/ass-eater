import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import { removeListingsForCreator } from './listings-store';
import { applyContentViolation } from './creators-store';
import { deleteMediaQuietly } from './blob-cleanup';
import { preserveMedia, movePreservedToEvidence, reportRef } from './media-preservation';
import { pushCreatorStatus } from './server-api';

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
 * Open-queue summary for the admin panel's TAKEDOWN REQUESTS badge: how many
 * are open and when the oldest one was filed, so the 48-hour clock is
 * visible without opening the tab.
 */
export async function getOpenNciiSummary() {
  const { rows } = await query(
    `select count(*)::int as open, min(data->>'createdAt') as oldest
       from ncii_reports
      where data->>'status' = 'open'`,
  );
  return { open: rows[0]?.open || 0, oldestOpenCreatedAt: rows[0]?.oldest || null };
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
    reporterName: String(reporterName || '').slice(0, NCII_FIELD_LIMITS.reporterName),
    reporterContact: String(reporterContact || '').slice(0, NCII_FIELD_LIMITS.reporterContact),
    contentLocation: String(contentLocation || '').slice(0, NCII_FIELD_LIMITS.contentLocation),
    description: String(description || '').slice(0, NCII_FIELD_LIMITS.description),
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
  return text ? text.slice(0, NCII_NOTE_MAX) : null;
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
 * (see preserveCreatorMedia below); `preservedCount` says how many, and the
 * report records their pathnames in `preservedMedia`.
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
    if (outrightBan && creator && creator.status !== 'banned') {
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
    // A ban also takes the creator's listings off sale, in this same commit,
    // and records their files for deletion (media_uploads) in it too. The
    // files themselves are deleted after COMMIT -- deletion cannot be rolled
    // back -- and anything that step does not reach is finished by the
    // orphan sweep. (It used to run entirely after the commit, so a failure
    // left a banned creator's listings live with only a log line.) No
    // keepPaid here: an NCII ban (ladder or possible-minor) takes paid
    // listings' files down too, unlike a manual ban from the creator record.
    let files = [];
    if (creator?.status === 'banned') {
      ({ files } = await removeListingsForCreator(String(creator.id), { moderation: true, client }));
    }
    // A POSSIBLE MINOR report is evidence, not only a takedown: 18 U.S.C.
    // 2258A requires the material to be preserved (a year after the
    // CyberTipline report). So every file this creator has -- avatar, hero
    // video, gallery, and every listing's media, sold or not -- is
    // QUARANTINED in this same commit (lib/media-preservation.js): recorded
    // with the report id, taken off the deletion queue, and from then on
    // never served by /api/media and never deleted by any path. The listing
    // takedown above still takes everything off sale and hides it; it just
    // no longer destroys what has to be kept. Other NCII categories keep the
    // plain delete: there the law wants the content gone.
    // The creator's new standing is queued for server/ in this same commit
    // (lib/standing-outbox.js); the route delivers it after the commit.
    let pushUid = null;
    if (creator) pushUid = (await pushCreatorStatus(String(creator.id), { client })).uid || null;

    // 'removed' is a statement that the content is down. The admin route
    // (requireTakedown) only lets it be recorded when that is on file: a
    // specific-item takedown recorded against this request
    // (/api/admin/content-takedown, or a gallery/avatar removal attributed to
    // it), the attributed creator banned in this same commit (every listing
    // comes down and the profile is hidden), or the admin's explicit
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
      const basis = removedCount ? 'takedown' : creator?.status === 'banned' ? 'ban' : contentGone ? 'acknowledged' : null;
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
    let preserved = [];
    if (outrightBan && creator) {
      preserved = await preserveCreatorMedia(client, String(creator.id), id);
      const { rows: marked } = await client.query(
        `update ncii_reports
            set data = data || jsonb_build_object(
                  'preservedMedia', $2::jsonb, 'preservedAt', $3::text, 'preservedCount', $4::int)
          where id = $1
          returning id, data`,
        [id, JSON.stringify(preserved), new Date().toISOString(), preserved.length],
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

// Every stored media src a creator has, read on the resolve's transaction
// (their listings are locked by the takedown that ran just before).
async function preserveCreatorMedia(client, creatorId, reportId) {
  const { rows: c } = await client.query('select data from creators where id = $1', [creatorId]);
  const { rows: ls } = await client.query(`select data from listings where data->>'creatorId' = $1`, [creatorId]);
  const d = c[0]?.data || {};
  const items = [
    d.img,
    d.video,
    ...(Array.isArray(d.gallery) ? d.gallery : []),
    ...ls.flatMap((r) => [
      ...(Array.isArray(r.data?.media) ? r.data.media : []),
      ...(Array.isArray(r.data?.retainedMedia) ? r.data.retainedMedia : []),
    ]),
  ];
  return preserveMedia(items, {
    reportId: reportRef('ncii', reportId),
    reason: `possible minor report #${reportId}: all media of creator ${creatorId}`,
    client,
  });
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
