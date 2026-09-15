import { removeGalleryItem } from '../../../lib/creators-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { creatorId, index } = req.body || {};
  if (!creatorId || index === undefined) {
    return res.status(400).json({ error: 'Missing creatorId or index' });
  }

  try {
    const creator = await removeGalleryItem(creatorId, index);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
