import { addGalleryItem, getCreatorById, GALLERY_CAP_EXCEEDED } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { resolvePerformerAttestation } from '../../../lib/performer-attestation';
import { PREMIUM_GALLERY_SLOTS, mediaSrc, parseMediaPathname, verifyUploadedBlob, deleteUnfinalizedUpload, MediaRejected } from '../../../lib/media';

/**
 * POST /api/admin/upload -- admin finalize of a gallery upload for a creator.
 * Header x-admin-key. JSON { creatorId, pathname, othersAppear, coPerformerRecordIds?, aiGenerated? }
 *   -> 200 { ok: true, creator, item }
 *
 * `othersAppear` is required. When true, `coPerformerRecordIds` must list the
 * §2257 record (non-archived, ID on file) of every other person in the file
 * (lib/performer-attestation.js); the admin path is the only one that can
 * publish co-performer content.
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
      await deleteUnfinalizedUpload(pathname);
      return res.status(404).json({ error: 'Creator not found' });
    }
    const attested = await resolvePerformerAttestation(req.body, { admin: true, creatorId: String(creatorId) });
    if (attested.error) {
      // Not deleted: the admin can correct the record ids and finalize the
      // same upload again (an abandoned one is swept as an orphan).
      return res.status(attested.status).json({ error: attested.error });
    }
    const { kind } = await verifyUploadedBlob(pathname, 'gallery');
    const item = { type: kind, src: mediaSrc(pathname), aiGenerated: aiGenerated === true, performers: attested.attestation };
    let creator;
    try {
      creator = await addGalleryItem(String(creatorId), item, undefined, PREMIUM_GALLERY_SLOTS);
    } catch (err) {
      if (err.code === GALLERY_CAP_EXCEEDED) {
        await deleteUnfinalizedUpload(pathname);
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
