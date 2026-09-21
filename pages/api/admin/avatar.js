import { put } from '@vercel/blob';
import { readLimitedBody, acceptedUploadType, UPLOAD_TYPE_MESSAGE, UPLOAD_SIZE_MESSAGE } from '../../../lib/upload-guard';
import { setCreatorAvatar } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { consumeAttempt, clientIp } from '../../../lib/rate-limit';

export const config = {
  api: {
    bodyParser: false,
  },
};

// Same gap as me/avatar.js: the blob path is timestamp-named, so
// allowOverwrite never actually caps how many blobs get written. Admin-key
// gated already, but a compromised key or a runaway admin-panel bug
// shouldn't be able to write unbounded blob storage either.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 20;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { limited, retryAfterSeconds } = consumeAttempt(`admin-avatar:ip:${clientIp(req)}`, {
    limit: MAX_PER_IP,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  const creatorId = req.headers['x-creator-id'];
  const fileName = req.headers['x-file-name'] || `avatar-${Date.now()}`;

  if (!creatorId) {
    return res.status(400).json({ error: 'Missing creator id' });
  }

  // Allowlisted, not taken from the header -- see lib/upload-guard.js.
  const uploadType = acceptedUploadType(req);
  if (!uploadType) return res.status(400).json({ error: UPLOAD_TYPE_MESSAGE });

  try {
    const body = await readLimitedBody(req);
    if (!body) return res.status(413).json({ error: UPLOAD_SIZE_MESSAGE });
    const blob = await put(`avatars/${creatorId}/${Date.now()}-${fileName}`, body, {
      access: 'public',
      contentType: uploadType,
      allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const creator = await setCreatorAvatar(creatorId, blob.url);

    return res.status(200).json({ ok: true, blob, creator });
  } catch (err) {
    console.error('[admin/avatar] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
