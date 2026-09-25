import { getSessionUser } from '../../../lib/session';
import { displayNameFor, findUserByCreatorId } from '../../../lib/users-store';
import { addWallPost, toPublicWallPost, MAX_TEXT_LENGTH, WALL_DAILY_CAP_MESSAGE } from '../../../lib/wall-store';
import { getCreatorById } from '../../../lib/creators-store';
import { isPubliclyVisible, effectiveCreatorStatus } from '../../../lib/creator-status';
import { restrictionMessageFor, blockBetween } from '../../../lib/messages-store';
import { createNotification } from '../../../lib/notifications-store';
import { screenPublicText } from '../../../lib/prohibited-terms';
import { addViolation } from '../../../lib/violations-store';
import { consumeAttempt } from '../../../lib/rate-limit';
import { userWriteRestriction } from '../../../lib/user-moderation';

// Per author. A wall is public, so this is the surface where flooding is
// most visible to everyone else.
const MAX_POSTS = 20;
const POST_WINDOW_MS = 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Log in to post on a wall' });
  const uid = user.id;

  const { creatorId, text } = req.body || {};
  if ((typeof creatorId !== 'string' && typeof creatorId !== 'number') || String(creatorId).trim() === ''
    || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing creatorId or text' });
  }
  // One limit, refused clearly: the route used to accept 2000 characters
  // while the store kept 500, so a long comment lost its tail silently.
  if (text.trim().length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ error: `That post is too long (${MAX_TEXT_LENGTH} characters maximum).` });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(`wall:user:${uid}`, {
    limit: MAX_POSTS,
    windowMs: POST_WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'You are posting too quickly. Give it a moment.' });
  }

  try {
    // Account-level moderation first (any login, fans included --
    // lib/user-moderation.js): a fan an admin suspended can't keep posting
    // while moderators delete one comment at a time.
    const accountRestricted = userWriteRestriction(user);
    if (accountRestricted) return res.status(403).json({ error: accountRestricted });
    // A suspended or banned creator can't post anywhere (Terms section 7),
    // not just edit their own profile.
    if (user.creatorId) {
      const own = await getCreatorById(user.creatorId);
      const restricted = own ? restrictionMessageFor(own) : null;
      if (restricted) return res.status(403).json({ error: restricted });
    }

    // The wall has to belong to a real creator the poster can see: a public
    // profile, or their own while it is pending/suspended. This used to
    // accept any creatorId at all, including ones that do not exist.
    const wallCreator = await getCreatorById(String(creatorId));
    const isOwner = !!user.creatorId && wallCreator && String(user.creatorId) === String(wallCreator.id);
    if (!wallCreator || !(isPubliclyVisible(wallCreator) || (isOwner && effectiveCreatorStatus(wallCreator) !== 'banned'))) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    // A DM block is the remedy for an abusive account, and it used to stop
    // only DMs: a fan the creator blocked kept commenting on their public
    // wall, notifying them on every burst. Refused (and nobody notified) in
    // either direction, the same as a DM.
    let ownerUser = null;
    if (!isOwner) {
      ownerUser = await findUserByCreatorId(wallCreator.id);
      const block = ownerUser ? await blockBetween(uid, ownerUser.id) : null;
      if (block === 'them') return res.status(403).json({ error: "This creator isn't accepting comments from you." });
      if (block === 'me') return res.status(403).json({ error: 'You blocked this creator. Unblock them to comment on their wall.' });
    }

    // A wall comment is public text on the creator's profile, so it gets the
    // same screen as every other public field (bio, name, tags, listing
    // copy): payment circumvention AND the prohibited-terms list. It used to
    // run only the payment check, so "new teen set dropping tonight" was
    // refused in a bio and published on a wall.
    const hit = screenPublicText(text);
    if (hit) {
      await addViolation({ userId: uid, context: 'wall_post', reasons: hit.reasons, snippet: text });
      return res.status(400).json({ error: hit.message });
    }

    const authorName = await displayNameFor(user);
    const post = await addWallPost({ creatorId: String(wallCreator.id), authorId: uid, authorName, text, isWallOwner: !!isOwner });

    // Let the wall's creator know -- unless they wrote it themselves. A
    // burst of comments folds into one unread notification per wall.
    if (!isOwner) {
      try {
        if (ownerUser && String(ownerUser.id) !== String(uid)) {
          await createNotification({
            userId: String(ownerUser.id),
            type: 'wall_comment',
            message: `${authorName} commented on your wall`,
            meta: { creatorId: String(wallCreator.id) },
            coalesceKey: 'creatorId',
          });
        }
      } catch (err) {
        console.error('[wall/post] notification failed:', err?.message);
      }
    }

    return res.status(200).json({ ok: true, post: toPublicWallPost(post, uid) });
  } catch (err) {
    if (err.message === 'Comment cannot be empty') return res.status(400).json({ error: err.message });
    if (err.code === 'WALL_DAILY_CAP') return res.status(429).json({ error: WALL_DAILY_CAP_MESSAGE });
    console.error('[wall/post] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
