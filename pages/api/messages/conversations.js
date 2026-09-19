import { getVerifiedSessionUserId } from '../../../lib/session';
import { getConversationsForUser } from '../../../lib/messages-store';
import { findUserById } from '../../../lib/users-store';
import { getCreators } from '../../../lib/creators-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const [conversations, creators] = await Promise.all([
    getConversationsForUser(uid),
    getCreators(),
  ]);

  // One row per counterpart, not the whole users table. This endpoint is
  // polled for an inbox, and getUsers() pulled every account -- including
  // every bcrypt hash -- into memory on each call. Nothing was returned to
  // the client that shouldn't be; it was the read itself that was wrong.
  const otherIds = [...new Set(
    conversations
      .map((c) => c.participantIds.find((id) => String(id) !== String(uid)))
      .filter((id) => id !== undefined && id !== null)
      .map(String),
  )];
  const others = new Map(
    (await Promise.all(otherIds.map((id) => findUserById(id))))
      .filter(Boolean)
      .map((u) => [String(u.id), u]),
  );

  const enriched = conversations.map((c) => {
    const otherId = c.participantIds.find((id) => String(id) !== String(uid));
    const otherUser = others.get(String(otherId));
    const otherCreator = otherUser?.creatorId
      ? creators.find((cr) => String(cr.id) === String(otherUser.creatorId))
      : null;
    // otherUser.email can be a real email address (see MEMORY.md's
    // anonymous-fan-signup feature) -- only show it when it has no "@",
    // meaning it's actually the plain username a fan chose to be shown
    // by, never a real address someone didn't intend to expose.
    const safeFanName = otherUser?.email && !otherUser.email.includes('@') ? otherUser.email : null;
    return {
      ...c,
      other: {
        userId: otherId,
        name: otherCreator?.name || safeFanName || 'Unknown',
        handle: otherCreator?.handle || null,
        img: otherCreator?.img || null,
      },
    };
  });

  return res.status(200).json({ conversations: enriched });
}
