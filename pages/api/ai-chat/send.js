import { refuseMalformedText } from '../../../lib/field-validation';
import { refuseCrossSite } from '../../../lib/same-origin';
import { MAX_CHAT_TEXT, sendChatMessage } from '../../../lib/ai-chat';
import { resolveChat, refuseTooFast, refuseScreened, sendChatError } from '../../../lib/ai-chat-api';

export const config = { maxDuration: 60 };

/**
 * POST { creatorId, text } -- one paid message to an AI house model
 * (AI_CHAT_PRICES.messageCents). Screened before anything is charged; a reply
 * that fails is refunded. Answers { reply } with the model's message.
 */
export default async function handler(req, res) {
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (refuseCrossSite(req, res)) return;
  const { creatorId, text } = req.body || {};
  const ctx = await resolveChat(req, res, creatorId);
  if (!ctx) return;
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return res.status(400).json({ error: 'Type a message first.' });
  if (body.length > MAX_CHAT_TEXT) return res.status(400).json({ error: `That message is too long (${MAX_CHAT_TEXT} characters maximum).` });
  if (refuseTooFast(res, ctx.user, 'text', 20)) return;
  if (await refuseScreened(res, ctx.user, body, 'ai_chat')) return;
  try {
    return res.status(200).json(await sendChatMessage({ user: ctx.user, creator: ctx.creator, text: body }));
  } catch (err) {
    return sendChatError(res, err, 'ai-chat/send');
  }
}
