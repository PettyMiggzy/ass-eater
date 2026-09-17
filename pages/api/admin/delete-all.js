import { deleteAllCreators } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';

// Defaults to wiping only real (non-seed) creators, so a routine cleanup
// can't accidentally erase the launch demo roster along with everything
// else -- pass includeSeed=true explicitly to also remove the seed rows.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const includeSeed = req.query.includeSeed === 'true' || req.body?.includeSeed === true;

  try {
    const remaining = await deleteAllCreators(includeSeed);
    return res.status(200).json({ ok: true, creators: remaining });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
