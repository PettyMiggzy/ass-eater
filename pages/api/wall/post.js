import { getSessionUser } from '../../../lib/session';
import { displayNameFor } from '../../../lib/users-store';
import { addWallPost } from '../../../lib/wall-store';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Log in to post on a wall' });
  const uid = user.id;

  const { creatorId, text } = req.body || {};
  if (!creatorId || !text) return res.status(400).json({ error: 'Missing creatorId or text' });

  const check = detectPaymentCircumvention(text);
  if (check.flagged) {
    await addViolation({ userId: uid, context: 'wall_post', reasons: check.reasons, snippet: text });
    return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
  }

  try {
    const post = await addWallPost({ creatorId, authorId: uid, authorName: await displayNameFor(user), text });
    return res.status(200).json({ ok: true, post });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
