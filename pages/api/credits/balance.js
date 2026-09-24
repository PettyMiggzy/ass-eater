import { getVerifiedSessionUserId } from '../../../lib/session';
import { getBalanceSummary, accountStanding, isFrozenStanding } from '../../../lib/credits-store';

// `withdrawableCents` is the part of the balance that may be cashed out --
// credits earned from fans. Deposited credits are spend-only. `frozen` is true
// for a suspended or banned creator account: its credits can't be spent,
// cashed out or topped up (the buy flow refuses), so /credits should say so
// instead of offering a Pay button.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to see your balance' });
  const [{ balanceCents, withdrawableCents }, standing] = await Promise.all([getBalanceSummary(uid), accountStanding(uid)]);
  return res.status(200).json({ balanceCents, withdrawableCents, frozen: isFrozenStanding(standing) });
}
