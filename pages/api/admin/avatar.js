import { setCreatorAvatar, getCreatorById } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { mediaSrc, parseMediaPathname, verifyUploadedBlob, deleteBlobQuietly, MediaRejected } from '../../../lib/media';

/**
 * POST /api/admin/avatar -- admin finalize of a creator's avatar upload.
 * Header x-admin-key. JSON { creatorId, pathname } -> 200 { ok: true, creator }
 * Token from POST /api/media/upload-token with the admin key and
 * { purpose: 'avatar', creatorId, ... }.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { creatorId, pathname } = req.body && typeof req.body === 'object' ? req.body : {};
  if ((typeof creatorId !== 'string' && typeof creatorId !== 'number') || !String(creatorId)) {
    return res.status(400).json({ error: 'Missing creator id' });
  }
  const parsed = parseMediaPathname(pathname);
  if (!parsed || parsed.purpose !== 'avatar' || parsed.creatorId !== String(creatorId)) {
    return res.status(400).json({ error: "That upload is not this creator's profile photo." });
  }

  try {
    if (!(await getCreatorById(String(creatorId)))) {
      await deleteBlobQuietly(pathname);
      return res.status(404).json({ error: 'Creator not found' });
    }
    await verifyUploadedBlob(pathname, 'avatar');
    const creator = await setCreatorAvatar(String(creatorId), mediaSrc(pathname));
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    if (err instanceof MediaRejected) return res.status(err.status).json({ error: err.message });
    console.error('[admin/avatar] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
