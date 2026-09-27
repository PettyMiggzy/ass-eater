import { refuseMalformedText } from '../../../lib/field-validation';
import { refuseCrossSite } from '../../../lib/same-origin';
import { MAX_SCENE_TEXT, requestCustomMedia } from '../../../lib/ai-chat';
import { resolveChat, refuseTooFast, refuseScreened, sendChatError } from '../../../lib/ai-chat-api';

export const config = { maxDuration: 60 };

/**
 * POST { creatorId, kind: 'photo' | 'video', scene } -- a paid custom photo
 * or video of an AI house model, described by the fan. Screened before
 * anything is charged; a failure is refunded. A photo comes back finished; a
 * video comes back 'pending' and arrives through GET /api/ai-chat/thread.
 */
export default async function handler(req, res) {
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (refuseCrossSite(req, res)) return;
  const { creatorId, kind, scene } = req.body || {};
  const ctx = await resolveChat(req, res, creatorId);
  if (!ctx) return;
  if (kind !== 'photo' && kind !== 'video') return res.status(400).json({ error: 'kind must be photo or video' });
  const text = typeof scene === 'string' ? scene.trim() : '';
  if (text.length < 3) return res.status(400).json({ error: 'Describe what you want to see.' });
  if (text.length > MAX_SCENE_TEXT) return res.status(400).json({ error: `Keep it under ${MAX_SCENE_TEXT} characters.` });
  if (refuseTooFast(res, ctx.user, 'media', 6)) return;
  if (await refuseScreened(res, ctx.user, text, 'ai_chat_request')) return;
  try {
    return res.status(200).json(await requestCustomMedia({ user: ctx.user, creator: ctx.creator, kind, scene: text }));
  } catch (err) {
    return sendChatError(res, err, 'ai-chat/request');
  }
}
