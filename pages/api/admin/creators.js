import { getCreators } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  try {
    const creators = await getCreators();
    return res.status(200).json({ creators });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
