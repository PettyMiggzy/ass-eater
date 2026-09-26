import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { removeGalleryItem, GALLERY_ITEM_GONE } from '../../../lib/creators-store';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * POST /api/me/gallery-delete
 * JSON { src, index? } -> 200 { ok: true, creator } | 409 when that item is no longer there
 *
 * Addressed by the item's `src` (its stable identity). `index` is optional and
 * only used when the item at that position has that same src. A bare index
 * used to be all this took, so a stale dashboard (another device, a second
 * tab) removed a different photo from the one clicked and reported success.
 * The file is deleted from storage once the change commits.
 */
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { src, index: rawIndex } = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof src !== 'string' || !src || src.length > 2048) {
    return res.status(400).json({ error: 'Missing the item to delete' });
  }
  const index = Number.isInteger(rawIndex) ? rawIndex : undefined;

  try {
    const creator = await removeGalleryItem(ctx.creator.id, { src, index });
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    if (err.code === GALLERY_ITEM_GONE) {
      return res.status(409).json({ error: 'That item is no longer in your gallery. Refresh and try again.' });
    }
    console.error('[me/gallery-delete] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
