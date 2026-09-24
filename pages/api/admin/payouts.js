import {
  getPendingPayoutRequests,
  getRecentPaidPayoutRequests,
  getRecentRejectedPayoutRequests,
  describePayoutRows,
} from '../../../lib/credits-store';
import { requireAdminKey } from '../../../lib/admin-auth';

// Used to return pending-only, so a request VANISHED from the admin UI the
// moment it was marked paid (the row survived in Postgres, nothing ever read
// it back) -- no way to do reconciliation without querying the database by
// hand. Now returns the pending queue to work plus recent paid and rejected
// history to check against.
//
// Every row carries `account` ({ email, creatorId, creatorName,
// creatorHandle, status, seed }) and `frozen` -- true when the owner is no
// longer an active creator (banned, suspended, pending, deleted). A frozen
// request can't be marked paid without an explicit override; the normal
// action for it is Reject (returns the credits, still frozen, to the balance).
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAdminKey(req, res)) return;

  const [pending, paid, rejected] = await Promise.all([
    getPendingPayoutRequests(),
    getRecentPaidPayoutRequests(50),
    getRecentRejectedPayoutRequests(50),
  ]);
  const [requests, paidRows, rejectedRows] = await Promise.all([
    describePayoutRows(pending),
    describePayoutRows(paid),
    describePayoutRows(rejected),
  ]);
  return res.status(200).json({ requests, paid: paidRows, rejected: rejectedRows });
}
