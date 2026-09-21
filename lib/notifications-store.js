import { query } from './db';

/**
 * In-app notifications only -- no email provider exists on this stack (see
 * MEMORY.md). Recording the row is the whole feature; a delivery channel can
 * be added later without touching any of the call sites below.
 *
 * Deliberately best-effort: a notification failing to write must never break
 * the real, money-moving action it's attached to (a sale, a payout). Errors
 * are logged and swallowed, same reasoning as the server/'s notify design
 * ("a message the fan paid for must not roll back because a mail API was
 * down" -- here it's "an order must not roll back because a notifications
 * insert failed").
 *
 * `client`, when given, runs the insert inside the caller's own transaction
 * (e.g. the same one that just charged a buyer and paid a seller) so the
 * notification and the event it describes are never out of sync with each
 * other -- if the transaction rolls back, no notification for it exists either.
 */
export async function createNotification({ userId, type, message, meta = {} }, client = null) {
  try {
    // JSON.stringify has to run INSIDE the try -- a bad meta value (e.g.
    // circular) throws synchronously, and this function's whole contract is
    // that nothing it does can escape and break the caller's transaction.
    const sql = 'insert into notifications (user_id, type, message, meta) values ($1, $2, $3, $4)';
    const params = [String(userId), type, message, JSON.stringify(meta)];
    if (client) await client.query(sql, params);
    else await query(sql, params);
  } catch (err) {
    console.error('[notifications] failed to record:', err.message);
  }
}

export async function getNotificationsForUser(userId, limit = 30) {
  const { rows } = await query(
    'select id, type, message, meta, created_at, read_at from notifications where user_id = $1 order by id desc limit $2',
    [String(userId), limit],
  );
  return rows;
}

export async function getUnreadCount(userId) {
  const { rows } = await query(
    'select count(*)::int as n from notifications where user_id = $1 and read_at is null',
    [String(userId)],
  );
  return rows[0].n;
}

/** Marks everything read at once -- there's no per-notification action to take, just acknowledging the list. */
export async function markAllRead(userId) {
  await query('update notifications set read_at = now() where user_id = $1 and read_at is null', [String(userId)]);
}
