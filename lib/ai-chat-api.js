/**
 * Shared request handling for /api/ai-chat/* (server-only): who is asking,
 * which house model, and the error answers. The chat logic itself is
 * lib/ai-chat.js.
 */
import { getSessionUser } from './session';
import { getCreatorById } from './creators-store';
import { canSellAsHouse, INSUFFICIENT_BALANCE, ACCOUNT_FROZEN, RECIPIENT_UNAVAILABLE } from './credits-store';
import { chatPersonaFor, screenFanText } from './ai-chat';
import { addViolation } from './violations-store';
import { consumeAttempt } from './rate-limit';

/** The signed-in fan and the chattable house model, or an answer already sent (null). */
export async function resolveChat(req, res, creatorId) {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'Log in to chat.' });
    return null;
  }
  if (typeof creatorId !== 'string' && typeof creatorId !== 'number') {
    res.status(400).json({ error: 'Missing creatorId' });
    return null;
  }
  const creator = /^[0-9A-Za-z_-]{1,64}$/.test(String(creatorId)) ? await getCreatorById(String(creatorId)) : null;
  if (!creator || !chatPersonaFor(creator) || !canSellAsHouse(creator)) {
    res.status(404).json({ error: 'This model isn’t available to chat.' });
    return null;
  }
  return { user, creator };
}

/** Per-fan rate limit for paid actions; true when the answer was sent. */
export function refuseTooFast(res, user, bucket, limit) {
  const { limited, retryAfterSeconds } = consumeAttempt(`aichat:${bucket}:${user.id}`, { limit, windowMs: 60 * 1000 });
  if (!limited) return false;
  res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(429).json({ error: 'Slow down a little -- give it a moment.' });
  return true;
}

/** Screens fan text; true when it was refused (and the answer sent). */
export async function refuseScreened(res, user, text, context) {
  const hit = screenFanText(text);
  if (!hit) return false;
  if (hit.log) {
    await addViolation({ userId: user.id, context, reasons: hit.reasons, snippet: text }).catch((err) =>
      console.error('[ai-chat] violation log failed:', err?.message));
  }
  res.status(400).json({ error: hit.message, code: 'ai_chat_refused' });
  return true;
}

/** Maps a thrown error to an answer. */
export function sendChatError(res, err, where) {
  if (err?.code === INSUFFICIENT_BALANCE) return res.status(402).json({ error: 'Not enough credits.', code: err.code });
  if (err?.code === ACCOUNT_FROZEN) return res.status(403).json({ error: 'Your account is restricted right now.', code: err.code });
  if (err?.code === RECIPIENT_UNAVAILABLE) return res.status(409).json({ error: 'This model isn’t available right now.', code: err.code });
  if (err?.status && err?.code) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`[${where}] unexpected error:`, err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
