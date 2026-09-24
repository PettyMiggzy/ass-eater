import { rejectPayout, PAYOUT_NOT_PENDING } from '../../../lib/credits-store';
import { requireAdminKey } from '../../../lib/admin-auth';

/**
 * Admin refuses a pending payout request -- a wallet nobody can send to, a
 * banned or suspended account, suspected fraud. In one transaction the
 * request becomes 'rejected' and the reserved credits go back to the
 * creator's balance (as withdrawable again, 'payout_reversed' in the
 * ledger). For a banned/suspended account that refund is held: a frozen
 * balance can't be spent or cashed out.
 *
 * Body: { id, reason } -- reason is required (shown to the creator).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAdminKey(req, res)) return;

  const { id, reason } = req.body || {};
  const idOk = (typeof id === 'string' && /^\d{1,18}$/.test(id)) || (Number.isSafeInteger(id) && id > 0);
  if (!idOk) return res.status(400).json({ error: 'Missing or invalid payout id' });
  if (typeof reason !== 'string' || !reason.trim()) return res.status(400).json({ error: 'A reason is required' });

  try {
    const request = await rejectPayout(id, reason);
    return res.status(200).json({ ok: true, request });
  } catch (err) {
    if (err.code === PAYOUT_NOT_PENDING) return res.status(409).json({ error: err.message });
    console.error('[admin/payouts-reject] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
