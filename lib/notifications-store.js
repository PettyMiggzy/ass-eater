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
export async function createNotification({ userId, type, message, meta = {}, coalesceKey = null, actorId = null }, client = null) {
  try {
    // JSON.stringify has to run INSIDE the try -- a bad meta value (e.g.
    // circular) throws synchronously, and this function's whole contract is
    // that nothing it does can escape and break the caller's transaction.
    //
    // `coalesceKey` (a key of `meta`) folds a burst into one row. Twenty
    // messages from one fan are one "New message from X", not twenty bells.
    // Round 19 (public-pages#0): the fold REPLACES the older unread row with a
    // fresh one (new id, new time) instead of skipping the insert. Skipping
    // left the one unread row where it was, so once it slid below the newest
    // page the bell shows, it could never be seen or cleared -- and every later
    // message from that sender folded into it, silently, forever. Now the
    // unread notice for a sender is always the newest of its kind. Done in the
    // same statement as the insert rather than read-then-write; a concurrent
    // pair may leave two rows, which the next fold collapses again.
    //
    // Only for an account that still EXISTS (round-15 legal-journeys#2): the
    // notifications table has no foreign key to users, and an order keeps its
    // buyerId after the buyer deletes their account (it is a financial
    // record), so a later ship notice or tracking correction inserted a row for
    // the deleted uid that nobody could ever read or delete -- after the
    // privacy policy promised the account's notifications were deleted with
    // it. Checked in the same statement as the insert, for every caller.
    //
    // The check takes a FOR KEY SHARE lock on the users row (round-16
    // social#0 / legal-journeys#1). A plain read did not serialize with an
    // account deletion in progress: deleteFanAccount locks the row FOR UPDATE,
    // purges this user's notifications part-way through, and deletes the users
    // row only at the end, so an insert landing in between still saw the
    // (uncommitted-deleted) row and left an orphan the purge had already
    // passed. KEY SHARE conflicts with FOR UPDATE and with the DELETE, so the
    // insert now waits for the deletion and, once it commits, the re-check
    // finds no row and inserts nothing. The wait is as long as a deletion
    // transaction -- short -- and a deadlock here is caught by the savepoint
    // below like any other failure.
    //
    // `actorId` (round-20 social#1): the account the notification NAMES
    // ("New message from alice_nyc", "alice_nyc commented on your wall") --
    // written only while that account still exists, under the same FOR KEY
    // SHARE lock. These are inserted after the send/post committed, so a
    // deletion of the sender landing in between used to leave a row naming a
    // deleted account that the purge had already anonymised past.
    const params = [String(userId), type, message, JSON.stringify(meta), coalesceKey ? String(coalesceKey) : null,
      actorId === null || actorId === undefined || actorId === '' ? null : String(actorId)];
    const live = `exists (select 1 from users where id = $1::text for key share)
                  and ($6::text is null or exists (select 1 from users where id = $6::text for key share))`;
    let sql = `insert into notifications (user_id, type, message, meta)
               select $1::text, $2::text, $3::text, $4::jsonb
                where ${live} and $5::text is null`; // ($5, the fold key, is null here; referenced so pg can type it)
    if (coalesceKey) {
      sql = `with folded as (
               delete from notifications
                where user_id = $1::text and type = $2::text and read_at is null
                  and meta->>($5::text) is not distinct from ($4::jsonb)->>($5::text)
                  and ${live}
             )
             insert into notifications (user_id, type, message, meta)
             select $1::text, $2::text, $3::text, $4::jsonb
              where ${live}`;
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

/**
 * What the bell shows (round-19 public-pages#0): EVERY unread row (up to
 * `unreadCap`, 200) plus the newest `limit` rows, newest first, deduplicated.
 * The bell used to fetch only the newest 30, so an unread row older than that
 * could never be displayed -- and it marked read only what it displayed, so
 * that row stayed unread for good. The caller marks exactly the ids it shows
 * (markReadIds).
 */
export async function getNotificationsPage(userId, { limit = 30, unreadCap = 200 } = {}) {
  const { rows } = await query(
    `select id, type, message, meta, created_at, read_at from (
        (select id, type, message, meta, created_at, read_at from notifications
          where user_id = $1 and read_at is null order by id desc limit $3)
        union
        (select id, type, message, meta, created_at, read_at from notifications
          where user_id = $1 order by id desc limit $2)
      ) shown
      order by id desc`,
    [String(userId), limit, unreadCap],
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

/**
 * Marks read exactly the rows `ids` names (round-19 public-pages#0) -- the
 * ids the bell displayed, never a min..max range, so a gap in the displayed
 * list (older read rows between unread ones) cannot sweep in a row nobody saw.
 * Scoped to the user and to unread rows; non-integer ids are ignored; at most
 * 500 per call. Returns how many were marked.
 */
export async function markReadIds(userId, ids) {
  if (!Array.isArray(ids)) return 0;
  const list = [...new Set(ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 500);
  if (!list.length) return 0;
  const { rowCount } = await query(
    'update notifications set read_at = now() where user_id = $1 and read_at is null and id = any($2::bigint[])',
    [String(userId), list],
  );
  return rowCount;
}

/**
 * Marks every unread row read -- the bell's explicit "Mark all as read"
 * (POST /api/notifications/read { all: true }), so a stale badge can always
 * be cleared. Returns how many were marked.
 */
export async function markAllRead(userId) {
  const { rowCount } = await query('update notifications set read_at = now() where user_id = $1 and read_at is null', [String(userId)]);
  return rowCount;
}
