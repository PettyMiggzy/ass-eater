import { updateViolationStatus } from '../../../lib/violations-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { id, action } = req.body || {};
  if (!id || !['dismiss', 'confirmed'].includes(action)) {
    return res.status(400).json({ error: 'Missing violation id or invalid action (dismiss | confirmed)' });
  }

  try {
    const updated = await updateViolationStatus(id, action, 'admin');
    return res.status(200).json({ ok: true, violation: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
