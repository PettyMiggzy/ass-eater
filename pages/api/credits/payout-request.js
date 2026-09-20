import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { requestPayout, getBalanceCents, INSUFFICIENT_BALANCE } from '../../../lib/credits-store';

/**
 * A creator cashes out their earned credits to real USDG. Uses the wallet
 * address already saved on their profile (dashboard's Payout section) --
 * they don't type one in per request. Debits the balance immediately;
 * sending the actual USDG is a manual admin step (see lib/db.js's
 * payout_requests comment for why).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  if (!ctx.creator.walletAddress) {
    return res.status(400).json({ error: 'Add a payout wallet address in your profile before cashing out' });
  }

  const { amountCents } = req.body || {};
  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(cents) || cents <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const request = await requestPayout({ userId: ctx.user.id, cents, payoutWallet: ctx.creator.walletAddress });
    const balanceCents = await getBalanceCents(ctx.user.id);
    return res.status(200).json({ ok: true, request, balanceCents });
  } catch (err) {
    if (err.code === INSUFFICIENT_BALANCE) return res.status(402).json({ error: 'Not enough credits' });
    return res.status(500).json({ error: err.message });
  }
}
