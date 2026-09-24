import { removeGalleryItem, GALLERY_ITEM_GONE } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';

/**
 * POST /api/admin/gallery-delete
 * Header x-admin-key. JSON { creatorId, src, index? }
 *   -> 200 { ok: true, creator } | 409 when that item is no longer there
 *
 * See pages/api/me/gallery-delete.js. This is the path an admin uses to take a
 * reported photo down, so it matters most here that the item removed is the
 * one that was clicked -- the admin panel's roster is loaded once and goes
 * stale while creators keep editing -- and that the file itself is deleted
 * from storage, not just the reference (removeGalleryItem does both).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { creatorId, src, index: rawIndex } = req.body && typeof req.body === 'object' ? req.body : {};
  if ((typeof creatorId !== 'string' && typeof creatorId !== 'number') || !String(creatorId)) {
    return res.status(400).json({ error: 'Missing creatorId' });
  }
  if (typeof src !== 'string' || !src || src.length > 2048) {
    return res.status(400).json({ error: 'Missing the item to delete' });
  }
  const index = Number.isInteger(rawIndex) ? rawIndex : undefined;

  try {
    const creator = await removeGalleryItem(String(creatorId), { src, index });
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    if (err.code === GALLERY_ITEM_GONE) {
      return res.status(409).json({ error: 'That item is no longer in the gallery. Refresh and try again.' });
    }
    if (err.message === 'Creator not found') return res.status(404).json({ error: 'Creator not found' });
    console.error('[admin/gallery-delete] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
