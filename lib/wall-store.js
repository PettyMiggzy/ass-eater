import { query, rowToRecord, rowsToRecords } from './db';

export const MAX_TEXT_LENGTH = 500;

export async function getWallPosts() {
  const { rows } = await query('select id, data from wall_posts order by id');
  return rowsToRecords(rows);
}

export async function getWallPostById(id) {
  if (!/^[1-9]\d{0,17}$/.test(String(id ?? ''))) return null;
  const { rows } = await query('select id, data from wall_posts where id = $1', [String(id)]);
  return rows.length ? rowToRecord(rows[0]) : null;
}

export async function getWallPostsForCreator(creatorId) {
  const { rows } = await query(
    `select id, data from wall_posts
      where data->>'creatorId' = $1
      order by data->>'createdAt' desc`,
    [String(creatorId)],
  );
  return rowsToRecords(rows);
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

export async function addWallPost({ creatorId, authorId, authorName, text }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Comment cannot be empty');
  const entry = {
    creatorId,
    authorId,
    authorName: String(authorName || 'Someone').slice(0, 60),
    text: trimmed.slice(0, MAX_TEXT_LENGTH),
    createdAt: new Date().toISOString(),
  };
  const { rows } = await query('insert into wall_posts (data) values ($1) returning id, data', [entry]);
  return rowToRecord(rows[0]);
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
