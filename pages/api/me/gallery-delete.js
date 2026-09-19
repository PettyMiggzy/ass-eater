import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { removeGalleryItem } from '../../../lib/creators-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  // Range-checked, not just present. `removeGalleryItem` splices: index -1
  // deletes the LAST item and a non-numeric index coerces to 0 and deletes
  // the first, so a typo or a stale client silently removes the wrong photo.
  const { index: rawIndex, knownGallery } = req.body || {};
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0 || index >= (ctx.creator.gallery || []).length) {
    return res.status(400).json({ error: 'That item is no longer in your gallery' });
  }

  try {
    const creator = await removeGalleryItem(ctx.creator.id, index, knownGallery);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
