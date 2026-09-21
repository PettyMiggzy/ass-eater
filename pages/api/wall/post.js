import { getSessionUser } from '../../../lib/session';
import { displayNameFor } from '../../../lib/users-store';
import { addWallPost } from '../../../lib/wall-store';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';
import { consumeAttempt } from '../../../lib/rate-limit';

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
  if (!creatorId || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing creatorId or text' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'That post is too long (2000 characters maximum).' });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(`wall:user:${uid}`, {
    limit: MAX_POSTS,
    windowMs: POST_WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'You are posting too quickly. Give it a moment.' });
  }

  const check = detectPaymentCircumvention(text);
  if (check.flagged) {
    await addViolation({ userId: uid, context: 'wall_post', reasons: check.reasons, snippet: text });
    return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
  }

  try {
    const post = await addWallPost({ creatorId, authorId: uid, authorName: await displayNameFor(user), text });
    return res.status(200).json({ ok: true, post });
  } catch (err) {
    if (err.message === 'Comment cannot be empty') return res.status(400).json({ error: err.message });
    console.error('[wall/post] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
