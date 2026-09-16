import { updateCreatorProfile, sanitizeSocials } from '../../../lib/creators-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { creatorId, fields } = req.body || {};
  if (!creatorId || !fields) {
    return res.status(400).json({ error: 'Missing creatorId or fields' });
  }

  const allowed = ['name', 'handle', 'bio', 'price', 'subs', 'posts', 'likes', 'locked', 'trending', 'status', 'payoutMethod', 'walletAddress', 'img', 'premium'];
  const safeFields = {};
  for (const key of allowed) {
    if (key in fields) safeFields[key] = fields[key];
  }
  if ('socials' in fields) safeFields.socials = sanitizeSocials(fields.socials);

  try {
    const creator = await updateCreatorProfile(creatorId, safeFields);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
