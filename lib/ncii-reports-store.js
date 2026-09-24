import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import { removeListingsForCreator } from './listings-store';

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

export async function addNciiReport({ reporterName, reporterContact, contentLocation, description, consentStatement }) {
  const entry = {
    reporterName: String(reporterName || '').slice(0, 200),
    reporterContact: String(reporterContact || '').slice(0, 200),
    contentLocation: String(contentLocation || '').slice(0, 500),
    description: String(description || '').slice(0, 1000),
    consentStatement: !!consentStatement,
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
 * report open so the admin can simply try again. (A ban's listing takedown
 * and file deletion follow the commit; see below.)
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

    const creator = attributed ? await applyLadderInTransaction(client, creatorId, id) : null;
    return { report: rowToRecord(rows[0]), creator };
  });

  // A ban also takes the creator's listings off sale and deletes their files.
  // That runs after COMMIT: file deletion cannot be rolled back, and a ban is
  // already enforced without it (a banned creator is hidden everywhere and
  // checkout refuses any seller who is not active). So a failure here is
  // logged and never un-resolves the report or re-runs the ladder.
  if (result.creator?.status === 'banned') {
    try {
      await removeListingsForCreator(String(result.creator.id), { moderation: true });
    } catch (err) {
      console.error('[ncii-reports-store] listing takedown after ban failed:', err?.message);
      result.listingTakedownFailed = true;
    }
  }
  return result;
}

const NCII_SUSPENSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, as in creators-store's ladder

/**
 * The confirmed-content-violation ladder (1st = 30-day suspension, 2nd =
 * permanent ban; same rule as creators-store's applyContentViolation), run on
 * the resolve transaction's own client.
 *
 * applyContentViolation() runs on its own pool connection and autocommits, so
 * calling it here committed the count BEFORE the report's status change; a
 * failure after it left the report open with the violation already counted,
 * and the admin's retry counted it again -- a first-offence suspension became
 * a permanent ban off one report. Running the UPDATE on `client` makes the
 * count, the creator's status and the report's status one commit.
 *
 * Belt and braces: the report id is recorded on the creator in the same
 * statement, and the WHERE refuses a report id that is already there, so one
 * report can never count twice however it is retried.
 *
 * TODO: collapse back to applyContentViolation(creatorId, client) once that
 * accepts a client (cross-package request).
 */
async function applyLadderInTransaction(client, creatorId, reportId) {
  const { rows } = await client.query(
    `update creators
        set data = data || (
              case
                when coalesce((data->>'contentViolationCount')::int, 0) + 1 >= 2
                  then jsonb_build_object(
                    'contentViolationCount', coalesce((data->>'contentViolationCount')::int, 0) + 1,
                    'status', 'banned',
                    'suspendedUntil', null
                  )
                else jsonb_build_object(
                    'contentViolationCount', coalesce((data->>'contentViolationCount')::int, 0) + 1,
                    'status', 'suspended',
                    'suspendedUntil', $2::text
                  )
              end
            ) || jsonb_build_object(
              'appliedNciiReportIds',
              coalesce(data->'appliedNciiReportIds', '[]'::jsonb) || jsonb_build_array($3::text)
            ),
            updated_at = now()
      where id = $1
        and not (coalesce(data->'appliedNciiReportIds', '[]'::jsonb) ? $3::text)
      returning id, data`,
    [String(creatorId), new Date(Date.now() + NCII_SUSPENSION_MS).toISOString(), String(reportId)],
  );
  if (!rows.length) {
    const { rows: again } = await client.query('select id, data from creators where id = $1', [String(creatorId)]);
    if (!again.length) throw Object.assign(new Error('That creator no longer exists.'), { code: NCII_CREATOR_NOT_FOUND });
    // Already counted for this report: idempotent, return the creator as is.
    return rowToRecord(again[0]);
  }
  return rowToRecord(rows[0]);
}
