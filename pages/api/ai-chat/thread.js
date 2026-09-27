import { refuseMalformedText } from '../../../lib/field-validation';
import { getBalanceCents } from '../../../lib/credits-store';
import { AI_CHAT_PRICES, MAX_CHAT_TEXT, MAX_SCENE_TEXT, getThread, advanceVideoJobs } from '../../../lib/ai-chat';
import { resolveChat, sendChatError } from '../../../lib/ai-chat-api';

export const config = { maxDuration: 60 };

/**
 * GET ?creatorId= -- the signed-in fan's chat with one AI house model, the
 * prices, and their balance. Collects any finished custom videos first
 * (lib/ai-chat.js advanceVideoJobs), so polling this is how a pending video
 * arrives.
 */
export default async function handler(req, res) {
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'private, no-store');
  const ctx = await resolveChat(req, res, req.query.creatorId);
  if (!ctx) return;
  try {
    await advanceVideoJobs(ctx.user.id, ctx.creator.id).catch((err) => console.error('[ai-chat/thread] videos:', err?.message));
    const [messages, balanceCents] = await Promise.all([getThread(ctx.user.id, ctx.creator.id), getBalanceCents(ctx.user.id)]);
    return res.status(200).json({
      messages,
      balanceCents,
      prices: AI_CHAT_PRICES,
      limits: { text: MAX_CHAT_TEXT, scene: MAX_SCENE_TEXT },
    });
  } catch (err) {
    return sendChatError(res, err, 'ai-chat/thread');
  }
}
