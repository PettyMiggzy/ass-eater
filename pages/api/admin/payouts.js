import { getPendingPayoutRequests, getRecentPaidPayoutRequests } from '../../../lib/credits-store';
import { requireAdminKey } from '../../../lib/admin-auth';

// Used to return pending-only, so a request VANISHED from the admin UI the
// moment it was marked paid (the row survived in Postgres, nothing ever read
// it back) -- no way to do reconciliation without querying the database by
// hand. Now returns both: the pending queue to work, and recent paid history
// to check against.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAdminKey(req, res)) return;

  const [requests, paid] = await Promise.all([getPendingPayoutRequests(), getRecentPaidPayoutRequests(50)]);
  return res.status(200).json({ requests, paid });
}
