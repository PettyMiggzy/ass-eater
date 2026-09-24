import { getVerifiedSessionUserId } from '../../../../lib/session';
import { getConversationBetween, projectConversation, markConversationRead, quoteDmPrice } from '../../../../lib/messages-store';
import { findUserById } from '../../../../lib/users-store';

/**
 * GET /api/messages/with/<userId>?limit=50&before=<messageId>
 *
 * One page of the thread (oldest first within the page), plus `hasMore` for
 * older messages. Opening the thread marks it read for the viewer.
 * `dmPriceCents` is what the viewer would pay to message this person (0
 * when it is free for them), so the UI can say so before they send -- and
 * the value to send back as `expectedPriceCents`. It comes from
 * quoteDmPrice(), the same rules the send applies, so a pending creator
 * account (which pays like a fan) is shown the price it will be charged.
 * `canSend` / `cannotSendReason` say when the send would be refused outright
 * (a creator who isn't accepting messages, fan -> fan, a restricted sender).
 * If `conversation.stale` is true, the `before` message has aged out of
 * storage: reload from the newest page instead of prepending.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { userId, limit, before } = req.query;
  if (typeof userId !== 'string' || !userId.trim()) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  try {
    const [conversation, viewer, other] = await Promise.all([
      getConversationBetween(uid, userId),
      findUserById(uid),
      findUserById(userId),
    ]);

    const quote = viewer && other
      ? await quoteDmPrice(viewer, other)
      : { allowed: false, priceCents: 0, reason: 'That account does not exist.' };
    const dmPriceCents = quote.priceCents;

    if (conversation && conversation.messages?.length) {
      await markConversationRead(uid, userId);
    }

    const projected = conversation
      ? projectConversation(conversation, uid, { limit, before: typeof before === 'string' ? before : null })
      : { id: null, participantIds: [String(uid), String(userId)], messages: [], hasMore: false, lastMessage: null, unreadCount: 0, updatedAt: null };
    // Opening the thread just read it.
    projected.unreadCount = 0;
    return res.status(200).json({
      conversation: projected,
      dmPriceCents,
      canSend: quote.allowed,
      cannotSendReason: quote.allowed ? null : quote.reason,
    });
  } catch (err) {
    console.error('[messages/with] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
