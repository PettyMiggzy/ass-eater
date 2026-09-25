import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import { removeListingsForCreator } from './listings-store';
import { applyContentViolation } from './creators-store';
import { deleteMediaQuietly } from './blob-cleanup';

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
 * 30-day ladder); `outrightBan` in the result says it happened.
 *
 * The 'open' guard is still part of the UPDATE, so two concurrent resolves
 * of the same report cannot both run the ladder.
 */
export async function resolveNciiReport(id, action, { creatorId = null, resolvedBy = 'admin' } = {}) {
  const attributed = action === 'removed' && creatorId !== null && creatorId !== undefined && String(creatorId) !== '';
  const result = await withTransaction(async (client) => {
    if (attributed) {
      const { rows: found } = await client.query('select id from creators where id = $1', [String(creatorId)]);
      if (!found.length) throw Object.assign(new Error('That creator no longer exists.'), { code: NCII_CREATOR_NOT_FOUND });
    }

    const { rows } = await client.query(
      `update ncii_reports
          set data = data || jsonb_build_object(
                'status', $2::text, 'resolvedBy', $3::text, 'resolvedAt', $4::text,
                'attributedCreatorId', $5::text)
        where id = $1
          and data->>'status' = 'open'
        returning id, data`,
      [id, action, resolvedBy, new Date().toISOString(), attributed ? String(creatorId) : null],
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
    return { report: rowToRecord(rows[0]), creator, files, outrightBan: !!(outrightBan && creator) };
  });

  const { files, ...out } = result;
  if (files.length) await deleteMediaQuietly(files);
  return out;
}
