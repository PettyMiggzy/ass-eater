import { updateViolationStatus } from '../../../lib/violations-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { refuseMalformedText } from '../../../lib/field-validation';

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { id, action } = req.body || {};
  if (!/^[1-9]\d{0,17}$/.test(String(id ?? '')) || !['dismiss', 'confirmed'].includes(action)) {
    return res.status(400).json({ error: 'Missing violation id or invalid action (dismiss | confirmed)' });
  }

  try {
    const updated = await updateViolationStatus(String(id), action, 'admin');
    // Someone else resolved it first: the first decision stands.
    if (!updated) return res.status(409).json({ code: 'already_resolved', error: 'This violation was already resolved. Reload the queue.' });
    return res.status(200).json({ ok: true, violation: updated });
  } catch (err) {
    if (err.message === 'Violation not found') return res.status(404).json({ error: 'Violation not found' });
    console.error('[admin/violations-resolve] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
