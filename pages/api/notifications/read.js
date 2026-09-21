import { getVerifiedSessionUserId } from '../../../lib/session';
import { markAllRead } from '../../../lib/notifications-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in first' });

  await markAllRead(uid);
  return res.status(200).json({ ok: true });
}
