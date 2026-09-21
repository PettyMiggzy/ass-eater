import { createCreator } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { validateTextFields } from '../../../lib/field-validation';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const profile = req.body || {};
  // createCreator() allocates the next free id and then spreads the submitted
  // profile over it, so an `id` in the body wins -- submitting one that's
  // already taken produced two creators sharing an id, which every lookup in
  // the app resolves by findIndex/filter on id (edits would hit whichever
  // came first, a delete would remove both). Ids are the platform's to
  // assign; the admin panel never sends one.
  if ('id' in profile) {
    return res.status(400).json({ error: 'id is assigned automatically and cannot be set' });
  }

  // Same crash class as pages/api/admin/profile.js -- this writes a brand
  // new creator's name/handle/bio straight through with no type check at
  // all, and a non-string value here 500s /search and /creators the moment
  // this creator is publicly visible.
  const invalid = validateTextFields(profile, ['name', 'handle', 'bio', 'price', 'payoutMethod', 'walletAddress', 'img']);
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    const creator = await createCreator(profile);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
