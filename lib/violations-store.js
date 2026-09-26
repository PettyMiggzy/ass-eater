import { query, rowToRecord, rowsToRecords } from './db';
import { sliceText } from './unicode-text';

export async function getViolations() {
  const { rows } = await query('select id, data from violations order by id');
  return rowsToRecords(rows);
}

/** Logs a blocked send for admin visibility -- the message/post itself was never stored, only this record of who tried and why it was flagged. */
export async function addViolation({ userId, context, reasons, snippet }) {
  const entry = {
    userId,
    context, // 'message' | 'wall_post' | 'bio' | 'name' | 'handle' | 'listing_title' | ...
    reasons,
    snippet: sliceText(snippet || '', 200),
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  const { rows } = await query('insert into violations (data) values ($1) returning id, data', [entry]);
  return rowToRecord(rows[0]);
}

/**
 * Resolves an OPEN violation. Guarded on it still being open inside the
 * UPDATE: returns null when it exists but was already resolved (a second
 * admin, a stale tab), so the caller answers 409 rather than overwriting the
 * first decision. Throws 'Violation not found' for no such row.
 */
export async function updateViolationStatus(id, status, resolvedBy) {
  const { rows } = await query(
    `update violations
        set data = data || jsonb_build_object('status', $2::text, 'resolvedBy', $3::text, 'resolvedAt', $4::text)
      where id = $1
        and data->>'status' = 'open'
      returning id, data`,
    [id, status, resolvedBy ?? null, new Date().toISOString()],
  );
  if (rows.length) return rowToRecord(rows[0]);
  const { rows: exists } = await query('select 1 from violations where id = $1', [id]);
  if (!exists.length) throw new Error('Violation not found');
  return null;
}

export async function countOpenViolationsForUser(userId) {
  const { rows } = await query(
    `select count(*)::int as c from violations
      where data->>'userId' = $1 and data->>'status' = 'open'`,
    [String(userId)],
  );
  return rows[0].c;
}
