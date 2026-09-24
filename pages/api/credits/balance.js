import { getVerifiedSessionUserId } from '../../../lib/session';
import { getBalanceSummary } from '../../../lib/credits-store';

// `withdrawableCents` is the part of the balance that may be cashed out --
// credits earned from fans. Deposited credits are spend-only.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to see your balance' });
  const { balanceCents, withdrawableCents } = await getBalanceSummary(uid);
  return res.status(200).json({ balanceCents, withdrawableCents });
}
