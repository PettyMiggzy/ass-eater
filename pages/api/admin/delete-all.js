import { deleteAllCreators } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { deliverFor, reportPushFailure } from '../../../lib/server-api';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * POST /api/admin/delete-all
 * Header x-admin-key. JSON { includeSeed?: boolean, force?: boolean } (or ?includeSeed=true)
 *   -> 200 { ok: true, creators, skipped: Obligation[], stranded: Obligation[] }
 * Obligation = { creatorId, name, balanceCents, pendingPayouts, pendingPayoutCents, pendingShipments }
 *
 * Defaults to wiping only real (non-seed) creators, so a routine cleanup
 * can't accidentally erase the launch demo roster along with everything
 * else -- pass includeSeed=true explicitly to also remove the seed rows.
 * Creators with money or unshipped orders attached are SKIPPED and listed,
 * unless force is true, in which case they are deleted and listed as stranded.
 */
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const includeSeed = req.query.includeSeed === 'true' || req.body?.includeSeed === true;
  const force = req.body?.force === true;

  try {
    const { creators, skipped, stranded, removedUserIds } = await deleteAllCreators(includeSeed, { force });
    // Each deleted login's server/ account is stopped too: queued as banned
    // in the delete's own commit, delivered here (retried by the cron if
    // this fails -- lib/standing-outbox.js).
    reportPushFailure(await deliverFor(removedUserIds), 'delete-all');
    return res.status(200).json({ ok: true, creators, skipped, stranded });
  } catch (err) {
    console.error('[admin/delete-all] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
