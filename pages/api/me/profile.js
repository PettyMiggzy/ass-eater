import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { updateCreatorProfile } from '../../../lib/creators-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { fields } = req.body || {};
  const allowed = ['name', 'handle', 'bio', 'price', 'payoutMethod', 'walletAddress', 'img'];
  const safeFields = {};
  for (const key of allowed) {
    if (fields && key in fields) safeFields[key] = fields[key];
  }

  try {
    const creator = await updateCreatorProfile(ctx.creator.id, safeFields);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
