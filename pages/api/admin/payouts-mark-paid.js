import { markPayoutPaid } from '../../../lib/credits-store';
import { requireAdminKey } from '../../../lib/admin-auth';

// Manual step, deliberately: the admin has ALREADY sent the real USDG by
// hand before calling this -- it only records that it happened, requiring
// a real transaction hash as proof. See lib/db.js's payout_requests comment
// for why sending is manual rather than something this endpoint triggers.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAdminKey(req, res)) return;

  const { id, txHash } = req.body || {};
  if (!id || !txHash) return res.status(400).json({ error: 'Missing id or transaction hash' });

  try {
    const request = await markPayoutPaid(id, txHash);
    return res.status(200).json({ ok: true, request });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
