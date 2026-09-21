import { getVerifiedSessionUserId } from '../../../lib/session';
import { sendMessage } from '../../../lib/messages-store';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';
import { consumeAttempt } from '../../../lib/rate-limit';

// Per sender, not per IP: the abuse this bounds is one free account writing
// conversation rows (and, when a send trips the circumvention filter,
// violations rows) as fast as it can against arbitrary recipient ids. A
// person having a conversation does not send 60 messages a minute.
const MAX_MESSAGES = 60;
const MESSAGE_WINDOW_MS = 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { toUserId, text } = req.body || {};
  if (!toUserId || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing toUserId or text' });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: 'That message is too long (5000 characters maximum).' });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(`dm:user:${uid}`, {
    limit: MAX_MESSAGES,
    windowMs: MESSAGE_WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'You are sending messages too quickly. Give it a moment.' });
  }

  const check = detectPaymentCircumvention(text);
  if (check.flagged) {
    await addViolation({ userId: uid, context: 'message', reasons: check.reasons, snippet: text });
    return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
  }

  try {
    const conversation = await sendMessage(uid, toUserId, text);
    return res.status(200).json({ ok: true, conversation });
  } catch (err) {
    if (err.message === 'Message cannot be empty' || err.message === 'Cannot message yourself') {
      return res.status(400).json({ error: err.message });
    }
    console.error('[messages/send] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
