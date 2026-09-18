import { query, withTransaction } from './db';

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
 */
export async function toggleFavorite(fanId, creatorId) {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(
      'delete from favorites where fan_id = $1 and creator_id = $2',
      [String(fanId), String(creatorId)],
    );
    if (rowCount > 0) return { favorited: false };
    await client.query(
      'insert into favorites (fan_id, creator_id) values ($1, $2) on conflict do nothing',
      [String(fanId), String(creatorId)],
    );
    return { favorited: true };
  });
}
