import { getVerifiedSessionUserId } from '../../../lib/session';
import {
  getConversationsForUser,
  projectConversation,
  encodeConversationCursor,
  SUMMARY_MESSAGES,
} from '../../../lib/messages-store';
import { findUserById } from '../../../lib/users-store';
import { getCreatorById } from '../../../lib/creators-store';

/**
 * GET /api/messages/conversations?limit=50&before=<nextBefore>
 *
 * A page of inbox SUMMARIES, most recent first: the other party, the last
 * few messages (for backwards compatibility with the current inbox UI;
 * fetch the full thread from /api/messages/with/<userId>), `lastMessage`,
 * `unreadCount` and `hasMore`. `nextBefore` (an opaque cursor string, null
 * on the last page) is passed back as `before` to continue the list.
 *
 * This used to return every message of every conversation, so one sender
 * could grow a single conversation until this response blew past the
 * platform's size limit and the recipient's whole inbox stopped loading.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const conversations = await getConversationsForUser(uid, { limit, before });

    // One row per counterpart, not the whole users table (every bcrypt hash
    // included) on each poll.
    const otherIds = [...new Set(
      conversations
        .map((c) => (c.participantIds || []).find((id) => String(id) !== String(uid)))
        .filter((id) => id !== undefined && id !== null)
        .map(String),
    )];
    const others = new Map(
      (await Promise.all(otherIds.map((id) => findUserById(id))))
        .filter(Boolean)
        .map((u) => [String(u.id), u]),
    );
    const creatorIds = [...new Set([...others.values()].map((u) => u.creatorId).filter(Boolean).map(String))];
    const creators = new Map(
      (await Promise.all(creatorIds.map((id) => getCreatorById(id))))
        .filter(Boolean)
        .map((c) => [String(c.id), c]),
    );

    const enriched = conversations.map((c) => {
      const otherId = (c.participantIds || []).find((id) => String(id) !== String(uid));
      const otherUser = others.get(String(otherId));
      const otherCreator = otherUser?.creatorId ? creators.get(String(otherUser.creatorId)) : null;
      // otherUser.email can be a real email address (see MEMORY.md's
      // anonymous-fan-signup feature) -- only show it when it has no "@",
      // meaning it's actually the plain username a fan chose to be shown
      // by, never a real address someone didn't intend to expose.
      const safeFanName = otherUser?.email && !otherUser.email.includes('@') ? otherUser.email : null;
      return {
        ...projectConversation(c, uid, { limit: SUMMARY_MESSAGES }),
        other: {
          userId: otherId,
          name: otherCreator?.name || safeFanName || 'Unknown',
          handle: otherCreator?.handle || null,
          img: otherCreator?.img || null,
          isCreator: !!otherCreator,
        },
      };
    });

    const last = conversations[conversations.length - 1];
    return res.status(200).json({
      conversations: enriched,
      nextBefore: conversations.length === limit ? encodeConversationCursor(last) : null,
    });
  } catch (err) {
    console.error('[messages/conversations] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
