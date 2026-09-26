import { getSessionUser } from '../../../lib/session';
import { getWallPostById, wallPostIdsByAuthor } from '../../../lib/wall-store';
import { setWallBlocked, DM_ERRORS } from '../../../lib/messages-store';
import { consumeAttempt } from '../../../lib/rate-limit';

/**
 * POST /api/wall/block { postId, blocked?: boolean (default true) }
 *   -> 200 { ok: true, blocked, postIds: string[] }
 *      postIds: every comment by the same author on this wall (newest
 *      first, capped) -- a block is per author, so the wall flips all of
 *      them at once. Comment ids only; the author's account id never
 *      leaves the server. Only when the call actually CHANGED the block
 *      (blocking someone not yet blocked, or lifting a block this owner
 *      made); otherwise postIds is [], so the endpoint can't be used to
 *      group anonymous comments by author without blocking anyone.
 *   -> 403 not the owner of the wall this comment is on
 *   -> 404 no such comment (or its author's account is gone)
 *
 * Lets a creator block the author of a comment on their OWN wall. A wall
 * block (lib/messages-store.js setWallBlocked) stops that account commenting
 * on this wall and messaging the creator. It is kept apart from DM blocks and
 * never reported on a DM thread, so it cannot name the commenter; the inbox
 * lists it only as an opaque row that can be unblocked.
 *
 * Why it goes through a comment id: the public wall deliberately never
 * carries a commenter's account id (lib/wall-store.js toPublicWallPost), so
 * there is nothing else to block BY -- the author is resolved here, server
 * side, and never sent back. Blocking a commenter used to be impossible
 * unless they had also DMed the creator, and most wall harassers never have.
 */
const MAX_BLOCKS = 30;
const WINDOW_MS = 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const { postId, blocked = true } = req.body && typeof req.body === 'object' ? req.body : {};
  if ((typeof postId !== 'string' && typeof postId !== 'number') || !/^[1-9]\d{0,17}$/.test(String(postId))) {
    return res.status(400).json({ error: 'Missing comment id' });
  }
  if (typeof blocked !== 'boolean') return res.status(400).json({ error: 'blocked must be true or false' });

  const { limited, retryAfterSeconds } = consumeAttempt(`wall-block:user:${user.id}`, { limit: MAX_BLOCKS, windowMs: WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many requests. Give it a moment.' });
  }

  try {
    const post = await getWallPostById(String(postId));
    if (!post) return res.status(404).json({ error: 'Comment not found' });
    const isWallOwner = user.role === 'creator' && !!user.creatorId && String(user.creatorId) === String(post.creatorId);
    if (!isWallOwner) return res.status(403).json({ error: 'Only the owner of this wall can block its commenters.' });
    if (!post.authorId || String(post.authorId) === String(user.id)) {
      return res.status(400).json({ error: 'You cannot block yourself.' });
    }
    // A WALL block (lib/messages-store.js setWallBlocked), its own record --
    // never the DM block on the pair row. Only a wall block is read back here,
    // so a DM block the owner made by user id can't be used to test which
    // anonymous comments belong to that account, and a wall block never shows
    // up on a named DM thread (round-10 social#0).
    const { changed } = await setWallBlocked(user.id, String(post.authorId), blocked);
    if (!changed) return res.status(200).json({ ok: true, blocked, postIds: [] });
    // The block itself is done; failing to list the author's other comments
    // only means the page flips this one, so it never fails the request.
    const postIds = await wallPostIdsByAuthor(post.creatorId, post.authorId).catch((err) => {
      console.error('[wall/block] listing the author\'s comments failed:', err);
      return [String(post.id)];
    });
    return res.status(200).json({ ok: true, blocked, postIds });
  } catch (err) {
    if (err.code === DM_ERRORS.RECIPIENT_NOT_FOUND) {
      // An author whose account is gone.
      return res.status(blocked ? 404 : 200).json(blocked ? { error: 'That account no longer exists.' } : { ok: true, blocked: false });
    }
    if (err.code === DM_ERRORS.SELF) return res.status(400).json({ error: 'You cannot block yourself.' });
    console.error('[wall/block] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
