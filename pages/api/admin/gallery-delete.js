import { removeGalleryItem, getCreatorById } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  // See pages/api/me/gallery-delete.js -- a negative or non-numeric index
  // splices out a different photo than the one that was clicked. Also
  // range-checked against the real current length, not just >= 0 --
  // `removeGalleryItem`'s splice silently no-ops on an out-of-range index,
  // which without this check returned {ok:true} having deleted nothing,
  // unlike the creator's own version of this endpoint which already caught
  // that case.
  const { creatorId, index: rawIndex, knownGallery } = req.body || {};
  const index = Number(rawIndex);
  if (!creatorId || !Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: 'Missing creatorId or a valid index' });
  }

  const creator = await getCreatorById(creatorId);
  if (!creator || index >= (creator.gallery || []).length) {
    return res.status(400).json({ error: 'That item is no longer in the gallery' });
  }

  try {
    const creator = await removeGalleryItem(creatorId, index, knownGallery);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    console.error('[admin/gallery-delete] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
