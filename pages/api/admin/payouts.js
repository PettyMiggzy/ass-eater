import { getPendingPayoutRequests } from '../../../lib/credits-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAdminKey(req, res)) return;

  const requests = await getPendingPayoutRequests();
  return res.status(200).json({ requests });
}
