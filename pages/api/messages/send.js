import { getSessionUser } from '../../../lib/session';
import { displayNameFor } from '../../../lib/users-store';
import {
  sendDirectMessage,
  projectConversation,
  DM_ERRORS,
  MAX_MESSAGE_LENGTH,
} from '../../../lib/messages-store';
import { createNotification } from '../../../lib/notifications-store';
import { RECIPIENT_UNAVAILABLE, ACCOUNT_FROZEN } from '../../../lib/credits-store';
import { screenPublicText } from '../../../lib/prohibited-terms';
import { addViolation } from '../../../lib/violations-store';
import { consumeAttempt } from '../../../lib/rate-limit';
import { refuseMalformedText } from '../../../lib/field-validation';

// Per sender, not per IP: the abuse this bounds is one account writing
// conversation rows (and, when a send trips the circumvention filter,
// violations rows) as fast as it can. A person having a conversation does
// not send 60 messages a minute.
const MAX_MESSAGES = 60;
const MESSAGE_WINDOW_MS = 60 * 1000;

const STATUS_FOR = {
  [DM_ERRORS.EMPTY]: 400,
  [DM_ERRORS.TOO_LONG]: 400,
  [DM_ERRORS.MALFORMED]: 400,
  [DM_ERRORS.SELF]: 400,
  [DM_ERRORS.RECIPIENT_NOT_FOUND]: 404,
  [DM_ERRORS.RECIPIENT_UNAVAILABLE]: 409,
  [DM_ERRORS.FAN_TO_FAN]: 403,
  [DM_ERRORS.NOT_ALLOWED]: 403,
  [DM_ERRORS.SENDER_RESTRICTED]: 403,
  [DM_ERRORS.INSUFFICIENT_BALANCE]: 402,
  [DM_ERRORS.PRICE_CHANGED]: 409,
  [DM_ERRORS.BLOCKED]: 403,
  // Thrown by transferWithFee itself when standing changes between the
  // pre-check above and the locked transfer (the creator is suspended or
  // banned in that window, or the sender's own credits are frozen). Their
  // messages are fixed strings, but they get fixed copy here anyway.
  [RECIPIENT_UNAVAILABLE]: 409,
  [ACCOUNT_FROZEN]: 403,
};

const MESSAGE_FOR = {
  [DM_ERRORS.INSUFFICIENT_BALANCE]: 'Not enough credits to send this message.',
  [RECIPIENT_UNAVAILABLE]: "This creator isn't accepting messages right now.",
  [ACCOUNT_FROZEN]: 'Your account is restricted and can’t send paid messages right now.',
};

/**
 * POST { toUserId, text, clientMessageId?, expectedPriceCents? }
 *
 * `expectedPriceCents` is the price the sender was shown (from
 * GET /api/messages/with/<id>'s dmPriceCents). It is required for a paid
 * send: if it is missing or differs from the creator's price now, the answer
 * is 409 { code: 'dm_price_changed', currentPriceCents } and nothing is
 * charged -- show the new price and ask again. Free sends ignore it.
 *
 * Messaging a creator costs credits (see lib/messages-store.js for the full
 * rule set); the charge and the message commit together. Answers
 * { ok, conversation, message, chargedCents, duplicate } -- `conversation`
 * is the paginated projection (last page of messages), never the full
 * stored history.
 */
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // The full, revocation-aware user record: the send rules depend on the
  // sender's role and creator profile, not just an id.
  const user = await getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const uid = user.id;

  const { toUserId, text, clientMessageId } = req.body || {};
  // A number, or a numeric string from a form; anything else is "not
  // stated", which a paid send treats as a mismatch.
  const rawExpected = req.body?.expectedPriceCents;
  const expectedPriceCents = typeof rawExpected === 'number' && Number.isInteger(rawExpected)
    ? rawExpected
    : typeof rawExpected === 'string' && /^\d{1,7}$/.test(rawExpected.trim()) ? Number(rawExpected.trim()) : undefined;
  if ((typeof toUserId !== 'string' && typeof toUserId !== 'number') || String(toUserId).trim() === ''
    || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing toUserId or text' });
  }
  // One limit, enforced here and in the store, with a clear refusal -- this
  // used to accept 5000 characters and then silently keep 2000.
  if (text.trim().length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `That message is too long (${MAX_MESSAGE_LENGTH} characters maximum).` });
  }
  if (clientMessageId !== undefined && clientMessageId !== null && typeof clientMessageId !== 'string') {
    return res.status(400).json({ error: 'Invalid clientMessageId' });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(`dm:user:${uid}`, {
    limit: MAX_MESSAGES,
    windowMs: MESSAGE_WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'You are sending messages too quickly. Give it a moment.' });
  }

  // Both screens every other free-text surface runs (wall, bio, listings):
  // the prohibited-terms list as well as payment circumvention. A DM is where
  // an "I'm 16" or a solicitation would actually be sent, and it used to get
  // only the payment check. A hit is refused and logged to the violations
  // queue, the same as on the wall.
  const hit = screenPublicText(text);
  if (hit) {
    await addViolation({ userId: uid, context: 'message', reasons: hit.reasons, snippet: text });
    return res.status(400).json({ error: hit.message });
  }

  let result;
  try {
    result = await sendDirectMessage({ sender: user, recipientId: String(toUserId), text, clientMessageId, expectedPriceCents });
  } catch (err) {
    const status = STATUS_FOR[err.code];
    if (err.code === DM_ERRORS.PRICE_CHANGED) {
      return res.status(409).json({ error: err.message, code: err.code, currentPriceCents: err.currentPriceCents });
    }
    if (status) {
      return res.status(status).json({ error: MESSAGE_FOR[err.code] || err.message, code: err.code });
    }
    console.error('[messages/send] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  // Outside the money transaction and after it committed: a notification
  // failing must never undo a paid message. No message text goes into it,
  // and a burst from one sender folds into a single unread notification.
  if (!result.duplicate) {
    try {
      await createNotification({
        userId: String(toUserId),
        type: 'message',
        message: `New message from ${await displayNameFor(user)}`,
        meta: { fromUserId: String(uid) },
        coalesceKey: 'fromUserId',
      });
    } catch (err) {
      console.error('[messages/send] notification failed:', err?.message);
    }
  }

  return res.status(200).json({
    ok: true,
    conversation: projectConversation(result.conversation, uid),
    message: result.message,
    chargedCents: result.chargedCents,
    duplicate: result.duplicate,
  });
}
