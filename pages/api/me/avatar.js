import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { setCreatorAvatar } from '../../../lib/creators-store';
import { mediaSrc, parseMediaPathname, verifyUploadedBlob, MediaRejected } from '../../../lib/media';

/**
 * POST /api/me/avatar -- finalize an avatar upload.
 * JSON { pathname } -> 200 { ok: true, creator }
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
    await verifyUploadedBlob(pathname, 'avatar');
    const creator = await setCreatorAvatar(ctx.creator.id, mediaSrc(pathname));
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    if (err instanceof MediaRejected) return res.status(err.status).json({ error: err.message });
    console.error('[me/avatar] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
