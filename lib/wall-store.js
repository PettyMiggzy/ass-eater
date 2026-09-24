import { query, rowToRecord, rowsToRecords, withTransaction } from './db';

export const MAX_TEXT_LENGTH = 500;
// A wall is read a page at a time, newest first. Both the profile's
// server render and /api/wall/list used to return EVERY comment ever posted,
// so one account posting at the rate limit for a day serialised megabytes
// into __NEXT_DATA__ and the creator's public page stopped loading.
export const WALL_PAGE_SIZE = 50;
const WALL_PAGE_MAX = 100;
// How many comments one account may leave on one wall in 24 hours. Counted in
// the database, so it holds across serverless instances -- the per-minute
// limit in pages/api/wall/post.js is in memory per instance and is not a
// ceiling on its own.
export const WALL_DAILY_CAP_PER_AUTHOR = 50;
export const WALL_DAILY_CAP_MESSAGE = "You've left the maximum number of comments on this wall for today. Try again tomorrow.";

export async function getWallPosts() {
  const { rows } = await query('select id, data from wall_posts order by id');
  return rowsToRecords(rows);
}

export async function getWallPostById(id) {
  if (!/^[1-9]\d{0,17}$/.test(String(id ?? ''))) return null;
  const { rows } = await query('select id, data from wall_posts where id = $1', [String(id)]);
  return rows.length ? rowToRecord(rows[0]) : null;
}

/**
 * One page of a creator's wall, newest first: `limit` posts (default
 * WALL_PAGE_SIZE, at most 100) older than the post id `before` (the cursor --
 * the id of the last post on the previous page). Ordered by the identity id,
 * never by the createdAt text. Returns { posts, hasMore, nextBefore }.
 */
export async function getWallPageForCreator(creatorId, { limit = WALL_PAGE_SIZE, before = null } = {}) {
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || WALL_PAGE_SIZE, 1), WALL_PAGE_MAX);
  const cursor = /^[1-9]\d{0,17}$/.test(String(before ?? '')) ? String(before) : null;
  const { rows } = await query(
    `select id, data from wall_posts
      where data->>'creatorId' = $1
        and ($2::bigint is null or id < $2::bigint)
      order by id desc
      limit $3`,
    [String(creatorId), cursor, size + 1],
  );
  const hasMore = rows.length > size;
  const posts = rowsToRecords(rows.slice(0, size));
  return { posts, hasMore, nextBefore: hasMore && posts.length ? String(posts[posts.length - 1].id) : null };
}

/** The newest page of a creator's wall (bounded -- see WALL_PAGE_SIZE). */
export async function getWallPostsForCreator(creatorId, options = {}) {
  return (await getWallPageForCreator(creatorId, options)).posts;
}

/**
 * The shape the public sees. A commenter's account id is NOT part of it:
 * the unauthenticated wall list used to hand out every commenter's user id,
 * which was all anyone needed to target them. The viewer instead learns
 * whether a comment is `mine` (computed server-side against their session).
 *
 * `authorId` is present ONLY on the viewer's own comments, where it is the
 * viewer's own id -- nothing they don't already know. That keeps clients
 * that still compare `authorId` to the viewer's id (the creator profile's
 * Wall, until it switches to `mine`) showing Delete on their own comments
 * and Report on everyone else's, without handing out anyone else's id.
 */
export function toPublicWallPost(post, viewerId = null) {
  const mine = viewerId != null && String(post.authorId) === String(viewerId);
  return {
    id: post.id,
    creatorId: post.creatorId,
    authorName: post.authorName,
    text: post.text,
    createdAt: post.createdAt,
    mine,
    ...(mine ? { authorId: String(viewerId) } : {}),
  };
}

/**
 * `isWallOwner` (the creator posting on their own wall, as decided by the
 * caller from the session) skips the daily cap: the cap exists to stop one
 * fan flooding someone else's profile, and a creator answering their own
 * fans would otherwise be locked out of their own comments after 50 replies.
 * The per-minute rate limit in the route still applies to everyone.
 */
export async function addWallPost({ creatorId, authorId, authorName, text, isWallOwner = false }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Comment cannot be empty');
  const entry = {
    creatorId,
    authorId,
    authorName: String(authorName || 'Someone').slice(0, 60),
    text: trimmed.slice(0, MAX_TEXT_LENGTH),
    createdAt: new Date().toISOString(),
  };
  // The daily cap is checked and the row inserted under one advisory lock
  // per (author, wall), so parallel requests can't all read "under the cap".
  if (isWallOwner) {
    const { rows } = await query('insert into wall_posts (data) values ($1) returning id, data', [entry]);
    return rowToRecord(rows[0]);
  }
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`wall:${authorId}:${creatorId}`]);
    const { rows: counted } = await client.query(
      `select count(*)::int as n from wall_posts
        where data->>'authorId' = $1 and data->>'creatorId' = $2
          and created_at > now() - interval '24 hours'`,
      [String(authorId), String(creatorId)],
    );
    if (counted[0].n >= WALL_DAILY_CAP_PER_AUTHOR) {
      throw Object.assign(new Error(WALL_DAILY_CAP_MESSAGE), { code: 'WALL_DAILY_CAP' });
    }
    const { rows } = await client.query('insert into wall_posts (data) values ($1) returning id, data', [entry]);
    return rowToRecord(rows[0]);
  });
}

/**
 * Deleting is allowed for the comment's own author, or the creator whose wall
 * it's on -- same as an IG/FB page owner moderating their own comments.
 * Platform admins can go further via the existing report/ban tooling.
 *
 * The authorization check is part of the DELETE rather than a separate read
 * first, so there is no window between "may they?" and "do it" in which the
 * post could change underneath.
 */
export async function deleteWallPost(id, requesterId, { isWallOwner } = {}) {
  const { rows } = await query('select id, data from wall_posts where id = $1', [id]);
  if (!rows.length) throw new Error('Comment not found');
  const post = rowToRecord(rows[0]);
  if (String(post.authorId) !== String(requesterId) && !isWallOwner) {
    throw new Error('Not authorized to delete this comment');
  }
  const { rowCount } = await query(
    `delete from wall_posts
      where id = $1 and ($2::boolean or data->>'authorId' = $3)`,
    [id, !!isWallOwner, String(requesterId)],
  );
  if (!rowCount) throw new Error('Comment not found');
  return true;
}
