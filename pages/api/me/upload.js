import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { addGalleryItem, GALLERY_CAP_EXCEEDED } from '../../../lib/creators-store';
import { resolvePerformerAttestation } from '../../../lib/performer-attestation';
import { galleryLimitFor, mediaSrc, parseMediaPathname, verifyUploadedBlob, deleteUnfinalizedUpload, MediaRejected } from '../../../lib/media';
import { MEDIA_UPLOAD_EXPIRED, MEDIA_UPLOAD_EXPIRED_MESSAGE } from '../../../lib/media-refs';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * POST /api/me/upload -- finalize a gallery upload.
 * JSON { pathname, othersAppear, aiGenerated? } -> 200 { ok: true, creator, item }
 *
 * `othersAppear` (required, boolean): does anyone besides the account holder
 * appear in this file? `true` is refused (403) and the upload thrown away -- see
 * lib/performer-attestation.js for the §2257 rule. A refused upload is deleted
 * only while it is still unfinalized and unreferenced
 * (lib/media.js deleteUnfinalizedUpload) -- never a file already in use.
 *
 * The file itself was uploaded by the browser straight to the private Blob
 * store with a token from POST /api/media/upload-token (see lib/media.js).
 * This records it: the pathname must be a gallery path in the caller's OWN
 * prefix, the stored blob's real type and size are re-checked (and the blob
 * deleted if either is wrong), and the slot limit is enforced inside the
 * write against the fresh record -- never against anything the client sends.
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

  const { pathname, aiGenerated } = req.body && typeof req.body === 'object' ? req.body : {};
  const parsed = parseMediaPathname(pathname);
  if (!parsed || parsed.purpose !== 'gallery' || parsed.creatorId !== String(ctx.creator.id)) {
    return res.status(400).json({ error: 'That upload does not belong to your gallery.' });
  }

  try {
    const attested = await resolvePerformerAttestation(req.body);
    if (attested.error) {
      await deleteUnfinalizedUpload(pathname);
      return res.status(attested.status).json({ error: attested.error });
    }
    const { kind } = await verifyUploadedBlob(pathname, 'gallery');
    const limit = galleryLimitFor(ctx.creator);
    const item = { type: kind, src: mediaSrc(pathname), aiGenerated: aiGenerated === true, performers: attested.attestation };
    let creator;
    try {
      creator = await addGalleryItem(ctx.creator.id, item, undefined, limit);
    } catch (err) {
      if (err.code === GALLERY_CAP_EXCEEDED) {
        await deleteUnfinalizedUpload(pathname);
        return res.status(403).json({
          error: ctx.creator.premium
            ? `You've used all ${limit} of your Premium content slots.`
            : `Free accounts get ${limit} content slots. Upgrade to Premium for 200.`,
          limit,
        });
      }
      throw err;
    }
    return res.status(200).json({ ok: true, creator, item });
  } catch (err) {
    if (err instanceof MediaRejected) return res.status(err.status).json({ error: err.message });
    // The file was reaped by the orphan sweep before this finalize (lib/media-refs.js).
    if (err.code === MEDIA_UPLOAD_EXPIRED) return res.status(409).json({ error: MEDIA_UPLOAD_EXPIRED_MESSAGE });
    console.error('[me/upload] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
