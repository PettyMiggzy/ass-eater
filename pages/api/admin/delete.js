import { deleteCreator, CREATOR_HAS_OBLIGATIONS } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';

/**
 * POST /api/admin/delete
 * Header x-admin-key. JSON { creatorId, force? }
 *   -> 200 { ok: true, creators, stranded: Obligation[] }
 *   -> 409 { error, code: 'creator_has_obligations', obligations: Obligation[] }
 * Obligation = { creatorId, balanceCents, pendingPayouts, pendingPayoutCents, pendingShipments }
 *
 * Deleting a creator deletes their login, so a creator who still has a credit
 * balance, a pending payout or a paid order waiting to ship is refused unless
 * `force: true` is sent -- and a forced delete reports exactly what it left
 * behind. Ban or suspend instead to keep that money reachable.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { creatorId, force } = req.body && typeof req.body === 'object' ? req.body : {};
  if ((typeof creatorId !== 'string' && typeof creatorId !== 'number') || !String(creatorId)) {
    return res.status(400).json({ error: 'Missing creatorId' });
  }

  try {
    const { creators, stranded } = await deleteCreator(String(creatorId), { force: force === true });
    return res.status(200).json({ ok: true, creators, stranded });
  } catch (err) {
    if (err.code === CREATOR_HAS_OBLIGATIONS) {
      return res.status(409).json({
        error: 'This creator still has a credit balance, a pending payout or an unshipped order. Resolve those first, or delete with force to leave them behind.',
        code: CREATOR_HAS_OBLIGATIONS,
        obligations: err.obligations,
      });
    }
    console.error('[admin/delete] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
