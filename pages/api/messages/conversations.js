import { getSessionUserId } from '../../../lib/session';
import { getConversationsForUser } from '../../../lib/messages-store';
import { getUsers } from '../../../lib/users-store';
import { getCreators } from '../../../lib/creators-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = getSessionUserId(req);
  if (!uid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const [conversations, users, creators] = await Promise.all([
    getConversationsForUser(uid),
    getUsers(),
    getCreators(),
  ]);

  const enriched = conversations.map((c) => {
    const otherId = c.participantIds.find((id) => String(id) !== String(uid));
    const otherUser = users.find((u) => String(u.id) === String(otherId));
    const otherCreator = otherUser?.creatorId
      ? creators.find((cr) => String(cr.id) === String(otherUser.creatorId))
      : null;
    return {
      ...c,
      other: {
        userId: otherId,
        name: otherCreator?.name || otherUser?.email || 'Unknown',
        handle: otherCreator?.handle || null,
        img: otherCreator?.img || null,
      },
    };
  });

  return res.status(200).json({ conversations: enriched });
}
