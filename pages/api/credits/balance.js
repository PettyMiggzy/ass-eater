import { getVerifiedSessionUserId } from '../../../lib/session';
import { getBalanceCents } from '../../../lib/credits-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to see your balance' });
  const balanceCents = await getBalanceCents(uid);
  return res.status(200).json({ balanceCents });
}
