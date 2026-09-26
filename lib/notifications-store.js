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
 *
 * That same shared-transaction case is why the insert runs inside its own
 * SAVEPOINT: catching a JS exception does nothing for a Postgres-level
 * failure (a deadlock, a dropped connection, a statement timeout) -- once any
 * statement in a transaction errors server-side, EVERY later statement on
 * that connection fails too ("current transaction is aborted"), even though
 * the JS catch block already swallowed the original error. Without the
 * savepoint, a rare DB-level failure on this one insert would silently
 * poison the caller's whole transaction and roll back the real charge next
 * to it -- the exact thing this function's "never breaks the caller" promise
 * exists to prevent. Rolling back only to the savepoint keeps the rest of
 * the transaction usable no matter what happens here.
 */
export async function createNotification({ userId, type, message, meta = {}, coalesceKey = null }, client = null) {
  try {
    // JSON.stringify has to run INSIDE the try -- a bad meta value (e.g.
    // circular) throws synchronously, and this function's whole contract is
    // that nothing it does can escape and break the caller's transaction.
    //
    // `coalesceKey` (a key of `meta`) folds a burst into one row: nothing is
    // inserted while an UNREAD notification of the same type with the same
    // meta[coalesceKey] already exists. Twenty messages from one fan are one
    // "New message from X", not twenty bells. Checked in the same statement
    // as the insert rather than read-then-write.
    //
    // Only for an account that still EXISTS (round-15 legal-journeys#2): the
    // notifications table has no foreign key to users, and an order keeps its
    // buyerId after the buyer deletes their account (it is a financial
    // record), so a later ship notice or tracking correction inserted a row for
    // the deleted uid that nobody could ever read or delete -- after the
    // privacy policy promised the account's notifications were deleted with
    // it. Checked in the same statement as the insert, for every caller.
    let sql = `insert into notifications (user_id, type, message, meta)
               select $1::text, $2::text, $3::text, $4::jsonb
                where exists (select 1 from users where id = $1::text)`;
    const params = [String(userId), type, message, JSON.stringify(meta)];
    if (coalesceKey) {
      sql = `insert into notifications (user_id, type, message, meta)
             select $1::text, $2::text, $3::text, $4::jsonb
              where exists (select 1 from users where id = $1::text)
                and not exists (
                select 1 from notifications
                 where user_id = $1::text and type = $2::text and read_at is null
                   and meta->>($5::text) is not distinct from ($4::jsonb)->>($5::text))`;
      params.push(String(coalesceKey));
    }
    if (client) {
      await client.query('savepoint notification_insert');
      try {
        await client.query(sql, params);
        await client.query('release savepoint notification_insert');
      } catch (err) {
        await client.query('rollback to savepoint notification_insert');
        throw err;
      }
    } else {
      await query(sql, params);
    }
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

/**
 * Marks read only what the user was actually shown: every unread row with
 * fromId <= id <= upToId (the lowest and highest ids the bell displayed). Marking *everything*
 * also swallowed rows past the 30 the panel shows and any that arrived
 * between the fetch and this call. Without `upToId` nothing is marked -- a
 * caller that cannot say what it showed has not shown anything.
 */
export async function markReadUpTo(userId, upToId, fromId = null) {
  const max = Number(upToId);
  if (!Number.isSafeInteger(max) || max <= 0) return 0;
  // `fromId` (the lowest id displayed) bounds it from below too, so unread
  // rows older than the page the bell showed stay unread.
  const min = Number(fromId);
  const lower = Number.isSafeInteger(min) && min > 0 && min <= max ? min : 0;
  const { rowCount } = await query(
    'update notifications set read_at = now() where user_id = $1 and read_at is null and id <= $2 and id >= $3',
    [String(userId), max, lower],
  );
  return rowCount;
}

/** Marks every unread row read. Kept for callers that genuinely mean "all"; the bell uses markReadUpTo. */
export async function markAllRead(userId) {
  await query('update notifications set read_at = now() where user_id = $1 and read_at is null', [String(userId)]);
}
