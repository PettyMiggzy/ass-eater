import { deleteCreator } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { creatorId } = req.body || {};
  if (!creatorId) {
    return res.status(400).json({ error: 'Missing creatorId' });
  }

  try {
    const creators = await deleteCreator(creatorId);
    return res.status(200).json({ ok: true, creators });
  } catch (err) {
    console.error('[admin/delete] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
