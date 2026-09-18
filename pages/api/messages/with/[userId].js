import { getVerifiedSessionUserId } from '../../../../lib/session';
import { getConversationBetween } from '../../../../lib/messages-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { userId } = req.query;
  const conversation = await getConversationBetween(uid, userId);
  return res.status(200).json({ conversation: conversation || { participantIds: [String(uid), String(userId)], messages: [] } });
}
