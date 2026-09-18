import { query, rowToRecord, rowsToRecords } from './db';

export async function getReports() {
  const { rows } = await query('select id, data from reports order by id');
  return rowsToRecords(rows);
}

export async function addReport(report) {
  // `...report` last, matching the previous behaviour: a caller may override
  // the defaults above it (a backfill supplying its own createdAt/status).
  const entry = { createdAt: new Date().toISOString(), status: 'open', ...report };
  delete entry.id; // the column is the id; a caller-supplied one would be ignored anyway
  const { rows } = await query('insert into reports (data) values ($1) returning id, data', [entry]);
  return rowToRecord(rows[0]);
}

export async function updateReportStatus(id, status, resolvedBy) {
  const { rows } = await query(
    `update reports
        set data = data || jsonb_build_object('status', $2::text, 'resolvedBy', $3::text, 'resolvedAt', $4::text)
      where id = $1
      returning id, data`,
    [id, status, resolvedBy ?? null, new Date().toISOString()],
  );
  if (!rows.length) throw new Error('Report not found');
  return rowToRecord(rows[0]);
}
