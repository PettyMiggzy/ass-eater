import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { setCreatorAvatar } from '../../../lib/creators-store';
import { mediaSrc, parseMediaPathname, verifyUploadedBlob, deleteUnfinalizedUpload, MediaRejected } from '../../../lib/media';
import { resolvePerformerAttestation } from '../../../lib/performer-attestation';
import { MEDIA_UPLOAD_EXPIRED, MEDIA_UPLOAD_EXPIRED_MESSAGE } from '../../../lib/media-refs';

/**
 * POST /api/me/avatar -- finalize an avatar upload.
 * JSON { pathname, othersAppear: false } -> 200 { ok: true, creator }
 *
 * `othersAppear` is required, exactly as on the gallery and marketplace
 * finalize routes (lib/performer-attestation.js): the avatar is the most
 * public image on the site, and /2257 says every upload asks. `true` is
 * refused for a creator (the upload is thrown away, if it is still an
 * unfinalized one -- lib/media.js deleteUnfinalizedUpload) -- a photo showing someone else
 * needs that person's §2257 record first, which is an admin step.
 *
 * Token from POST /api/media/upload-token { purpose: 'avatar', ... }. The
 * token route carries the rate limit (it is where a new file can be created);
 * this only records a file the caller already uploaded into their own avatar
 * prefix, re-checking its real type/size. The previous avatar file is deleted
 * once the change commits (setCreatorAvatar).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { pathname } = req.body && typeof req.body === 'object' ? req.body : {};
  const parsed = parseMediaPathname(pathname);
  if (!parsed || parsed.purpose !== 'avatar' || parsed.creatorId !== String(ctx.creator.id)) {
    return res.status(400).json({ error: 'That upload is not your profile photo.' });
  }

  try {
    const attested = await resolvePerformerAttestation(req.body);
    if (attested.error) {
      await deleteUnfinalizedUpload(pathname);
      return res.status(attested.status).json({ error: attested.error });
    }
    await verifyUploadedBlob(pathname, 'avatar');
    const creator = await setCreatorAvatar(ctx.creator.id, mediaSrc(pathname), { performers: attested.attestation });
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    if (err instanceof MediaRejected) return res.status(err.status).json({ error: err.message });
    // The file was reaped by the orphan sweep before this finalize (lib/media-refs.js).
    if (err.code === MEDIA_UPLOAD_EXPIRED) return res.status(409).json({ error: MEDIA_UPLOAD_EXPIRED_MESSAGE });
    console.error('[me/avatar] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
