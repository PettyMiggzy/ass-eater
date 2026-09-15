import { getSessionUserId } from '../../../lib/session';
import { sendMessage } from '../../../lib/messages-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = getSessionUserId(req);
  if (!uid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { toUserId, text } = req.body || {};
  if (!toUserId || !text) {
    return res.status(400).json({ error: 'Missing toUserId or text' });
  }

  try {
    const conversation = await sendMessage(uid, toUserId, text);
    return res.status(200).json({ ok: true, conversation });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
