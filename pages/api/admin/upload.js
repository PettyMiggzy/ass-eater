import { addGalleryItem, getCreatorById, GALLERY_CAP_EXCEEDED } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { PREMIUM_GALLERY_SLOTS, mediaSrc, parseMediaPathname, verifyUploadedBlob, deleteBlobQuietly, MediaRejected } from '../../../lib/media';

/**
 * POST /api/admin/upload -- admin finalize of a gallery upload for a creator.
 * Header x-admin-key. JSON { creatorId, pathname, aiGenerated? }
 *   -> 200 { ok: true, creator, item }
 *
 * The token comes from POST /api/media/upload-token with the admin key and
 * { purpose: 'gallery', creatorId, ... }. Same checks as the creator's own
 * finalize (pages/api/me/upload.js); the admin ceiling is the premium one.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { creatorId, pathname, aiGenerated } = req.body && typeof req.body === 'object' ? req.body : {};
  if ((typeof creatorId !== 'string' && typeof creatorId !== 'number') || !String(creatorId)) {
    return res.status(400).json({ error: 'Missing creator id' });
  }
  const parsed = parseMediaPathname(pathname);
  if (!parsed || parsed.purpose !== 'gallery' || parsed.creatorId !== String(creatorId)) {
    return res.status(400).json({ error: "That upload is not in this creator's gallery." });
  }

  try {
    const existing = await getCreatorById(String(creatorId));
    if (!existing) {
      await deleteBlobQuietly(pathname);
      return res.status(404).json({ error: 'Creator not found' });
    }
    const { kind } = await verifyUploadedBlob(pathname, 'gallery');
    const item = { type: kind, src: mediaSrc(pathname), aiGenerated: aiGenerated === true };
    let creator;
    try {
      creator = await addGalleryItem(String(creatorId), item, undefined, PREMIUM_GALLERY_SLOTS);
    } catch (err) {
      if (err.code === GALLERY_CAP_EXCEEDED) {
        await deleteBlobQuietly(pathname);
        return res.status(403).json({ error: `All ${PREMIUM_GALLERY_SLOTS} content slots are in use.` });
      }
      throw err;
    }
    return res.status(200).json({ ok: true, creator, item });
  } catch (err) {
    if (err instanceof MediaRejected) return res.status(err.status).json({ error: err.message });
    console.error('[admin/upload] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
