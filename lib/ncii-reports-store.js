import { query, rowToRecord, rowsToRecords } from './db';

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

export async function updateNciiReportStatus(id, status, resolvedBy) {
  const { rows } = await query(
    `update ncii_reports
        set data = data || jsonb_build_object('status', $2::text, 'resolvedBy', $3::text, 'resolvedAt', $4::text)
      where id = $1
      returning id, data`,
    [id, status, resolvedBy ?? null, new Date().toISOString()],
  );
  if (!rows.length) throw new Error('Report not found');
  return rowToRecord(rows[0]);
}
