import { query, withTransaction } from './db';
import { lockAuthorRow } from './author-lock';
import { isPubliclyVisible } from './creator-status';

/** Thrown by toggleFavorite when an ADD names no existing, publicly visible creator. */
export const FAVORITE_CREATOR_NOT_FOUND = 'favorite_creator_not_found';

// Every creator id comes from an identity sequence (or the numeric seed ids),
// so anything else is not a creator. Checked here as well as in the route so
// no caller can store "[object Object]" or a 3 KB string (round-22 media#0).
const CREATOR_ID_RE = /^[1-9][0-9]{0,17}$/;

/** The canonical string form of a creator id, or null when `value` cannot be one. */
export function normalizeFavoriteCreatorId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value);
  return CREATOR_ID_RE.test(s) ? s : null;
}

/** One row per (fan, creator) pair -- simplest possible shape, easy to filter either direction. */
export async function getFavorites() {
  const { rows } = await query('select fan_id, creator_id, created_at from favorites order by created_at');
  return rows.map((r) => ({ fanId: r.fan_id, creatorId: r.creator_id, createdAt: r.created_at.toISOString() }));
}

export async function getFavoriteCreatorIds(fanId) {
  const { rows } = await query('select creator_id from favorites where fan_id = $1 order by created_at', [String(fanId)]);
  return rows.map((r) => r.creator_id);
}

export async function isFavorite(fanId, creatorId) {
  const { rows } = await query('select 1 from favorites where fan_id = $1 and creator_id = $2', [
    String(fanId),
    String(creatorId),
  ]);
  return rows.length > 0;
}

/**
 * Adding twice, or removing something never added, are both harmless no-ops --
 * the button on the page just toggles, it doesn't need to know which state it
 * started in.
 *
 * Done in one transaction so two fast clicks can't both read "not favorited"
 * and both insert. The delete/insert pair decides against the row it just
 * locked, not against a snapshot read earlier.
 *
 * The fan's users row is taken FOR KEY SHARE first (lib/author-lock.js,
 * round-21 media#2): a toggle racing the fan's own account deletion either
 * lands before the purge (and is purged with the rest) or waits for it and is
 * refused with AUTHOR_ACCOUNT_GONE -- never inserted after the purge's
 * favorites DELETE ran, where it would outlive the account.
 */
export async function toggleFavorite(fanId, creatorId) {
  const id = normalizeFavoriteCreatorId(creatorId);
  if (!id) {
    const err = new Error('Creator not found');
    err.code = FAVORITE_CREATOR_NOT_FOUND;
    throw err;
  }
  return withTransaction(async (client) => {
    await lockAuthorRow(client, String(fanId));
    // Removal is unconditional: a favorite can always be taken back, even
    // after that creator was hidden or deleted.
    const { rowCount } = await client.query(
      'delete from favorites where fan_id = $1 and creator_id = $2',
      [String(fanId), id],
    );
    if (rowCount > 0) return { favorited: false };
    // An ADD only for a creator that exists and is publicly visible (round-22
    // media#0 / social#0): an arbitrary id used to be inserted as-is, one junk
    // row per request. FOR KEY SHARE so a concurrent delete of that creator
    // either lands first (and we refuse) or waits for this insert.
    const { rows } = await client.query('select data from creators where id = $1 for key share', [id]);
    if (!rows.length || !isPubliclyVisible(rows[0].data)) {
      const err = new Error('Creator not found');
      err.code = FAVORITE_CREATOR_NOT_FOUND;
      throw err;
    }
    await client.query(
      'insert into favorites (fan_id, creator_id) values ($1, $2) on conflict do nothing',
      [String(fanId), id],
    );
    return { favorited: true };
  });
}
