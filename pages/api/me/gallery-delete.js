import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { removeGalleryItem } from '../../../lib/creators-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { index } = req.body || {};
  if (index === undefined) {
    return res.status(400).json({ error: 'Missing index' });
  }

  try {
    const creator = await removeGalleryItem(ctx.creator.id, index);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
