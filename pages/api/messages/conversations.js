import { refuseMalformedText } from '../../../lib/field-validation';
import { getVerifiedSessionUserId } from '../../../lib/session';
import {
  getConversationsForUser,
  projectConversation,
  isBlockOnlyFor,
  projectBlockOnlyConversation,
  encodeConversationCursor,
  listWallBlocksFor,
  SUMMARY_MESSAGES,
} from '../../../lib/messages-store';
import { inboxNameFor, findUserById } from '../../../lib/users-store';
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
 * The viewer's WALL blocks (lib/messages-store.js setWallBlocked) are appended
 * to the FIRST page only (no `before`), after its threads, as { id:
 * <blockHandle>, blockHandle, blockOnly: true, wallBlock: true, blockedByMe:
 * true, messages: [], other: { userId: null, name: 'A blocked account', ... } }
 * -- never the counterpart's account id. They are not threads and take no
 * part in paging; unblock one with POST /api/messages/block { blockHandle,
 * blocked: false }. A named thread never shows a wall block (blockedByMe
 * reflects DM blocks made by user id only), so a wall block cannot name the
 * anonymous commenter behind it (round-10 social#0). A legacy block-only row
 * is projected the same opaque way.
 *
 * This used to return every message of every conversation, so one sender
 * could grow a single conversation until this response blew past the
 * platform's size limit and the recipient's whole inbox stopped loading.
 */
export default async function handler(req, res) {
  // NUL / half an emoji in a query value is a 400, never a 500 from pg (round-11 fix-up).
  if (refuseMalformedText(req, res)) return;
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
    // Block-only rows (lib/messages-store.js isBlockOnlyFor) are projected
    // WITHOUT their counterpart: no account id, no name, no "Fan #" label --
    // for a wall commenter that would name the anonymous "Someone" the wall
    // is built never to reveal. So their counterpart is never looked up either.
    const otherIds = [...new Set(
      conversations
        .filter((c) => !isBlockOnlyFor(c, uid))
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

    // A fan's name: their screened username, or a stable "Fan #…" label
    // derived from their id (lib/users-store.js inboxNameFor) -- never the
    // email. Every email-registered fan used to read as the same "Unknown",
    // and a raw username skipped the screen displayNameFor applies.
    const names = new Map(
      await Promise.all([...others.values()].map(async (u) => [String(u.id), await inboxNameFor(u)])),
    );

    const enriched = conversations.map((c) => {
      if (isBlockOnlyFor(c, uid)) {
        // Unblock it with POST /api/messages/block { blockHandle, blocked: false }.
        return {
          ...projectBlockOnlyConversation(c, uid),
          other: { userId: null, name: 'A blocked account', handle: null, img: null, isCreator: false },
        };
      }
      const otherId = (c.participantIds || []).find((id) => String(id) !== String(uid));
      const otherUser = others.get(String(otherId));
      const otherCreator = otherUser?.creatorId ? creators.get(String(otherUser.creatorId)) : null;
      return {
        ...projectConversation(c, uid, { limit: SUMMARY_MESSAGES }),
        other: {
          userId: otherId,
          name: otherCreator?.name || names.get(String(otherId)) || 'Unknown',
          handle: otherCreator?.handle || null,
          img: otherCreator?.img || null,
          isCreator: !!otherCreator,
        },
      };
    });

    const blockedAccount = { userId: null, name: 'A blocked account', handle: null, img: null, isCreator: false };
    const wallBlocks = before ? [] : (await listWallBlocksFor(uid)).map((row) => ({ ...row, other: blockedAccount }));

    const last = conversations[conversations.length - 1];
    return res.status(200).json({
      conversations: [...enriched, ...wallBlocks],
      nextBefore: conversations.length === limit ? encodeConversationCursor(last) : null,
    });
  } catch (err) {
    console.error('[messages/conversations] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
