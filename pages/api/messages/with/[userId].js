import { getVerifiedSessionUserId } from '../../../../lib/session';
import { getConversationBetween, projectConversation, markConversationRead, dmPriceCentsFor } from '../../../../lib/messages-store';
import { findUserById } from '../../../../lib/users-store';
import { getCreatorById } from '../../../../lib/creators-store';

/**
 * GET /api/messages/with/<userId>?limit=50&before=<messageId>
 *
 * One page of the thread (oldest first within the page), plus `hasMore` for
 * older messages. Opening the thread marks it read for the viewer.
 * `dmPriceCents` is what the viewer would pay to message this person (0
 * when it is free for them), so the UI can say so before they send.
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

    let dmPriceCents = 0;
    const viewerIsCreator = viewer?.role === 'creator' && viewer?.creatorId;
    if (!viewerIsCreator && other?.role === 'creator' && other?.creatorId) {
      dmPriceCents = dmPriceCentsFor(await getCreatorById(other.creatorId));
    }

    if (conversation && conversation.messages?.length) {
      await markConversationRead(uid, userId);
    }

    const projected = conversation
      ? projectConversation(conversation, uid, { limit, before: typeof before === 'string' ? before : null })
      : { id: null, participantIds: [String(uid), String(userId)], messages: [], hasMore: false, lastMessage: null, unreadCount: 0, updatedAt: null };
    // Opening the thread just read it.
    projected.unreadCount = 0;
    return res.status(200).json({ conversation: projected, dmPriceCents });
  } catch (err) {
    console.error('[messages/with] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
