import { getCreators, saveCreators } from '../../../lib/creators-store';

// Defaults to wiping only real (non-seed) creators, so a routine cleanup
// can't accidentally erase the launch demo roster along with everything
// else -- pass includeSeed=true explicitly to also remove the seed rows.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const includeSeed = req.query.includeSeed === 'true' || req.body?.includeSeed === true;

  try {
    const remaining = includeSeed ? [] : (await getCreators()).filter((c) => c.seed);
    await saveCreators(remaining);
    return res.status(200).json({ ok: true, creators: remaining });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
