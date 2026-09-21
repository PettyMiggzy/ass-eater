import { getVerifiedSessionUserId } from '../../../lib/session';
import { getPayoutRequestsForUser } from '../../../lib/credits-store';

// A creator's own cash-out history -- pending, paid, everything. Before
// this, requestPayout's success only ever produced a one-time toast in
// dashboard.js's component state; refresh the page and there was no way to
// tell "still pending" from "already paid" from "did this even go through".
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to see your payout status' });

  const requests = await getPayoutRequestsForUser(uid, 25);
  return res.status(200).json({
    requests: requests.map((r) => ({
      id: r.id,
      amountCents: Number(r.amount_cents),
      status: r.status,
      payoutWallet: r.payout_wallet,
      txHash: r.tx_hash,
      createdAt: r.created_at,
      paidAt: r.paid_at,
    })),
  });
}
