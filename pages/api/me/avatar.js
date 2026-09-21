import { put } from '@vercel/blob';
import { readLimitedBody, acceptedUploadType, UPLOAD_TYPE_MESSAGE, UPLOAD_SIZE_MESSAGE } from '../../../lib/upload-guard';
import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { setCreatorAvatar } from '../../../lib/creators-store';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const fileName = req.headers['x-file-name'] || `avatar-${Date.now()}`;

  // Allowlisted, not taken from the header -- see lib/upload-guard.js.
  const uploadType = acceptedUploadType(req);
  if (!uploadType) return res.status(400).json({ error: UPLOAD_TYPE_MESSAGE });

  try {
    const body = await readLimitedBody(req);
    if (!body) return res.status(413).json({ error: UPLOAD_SIZE_MESSAGE });
    const blob = await put(`avatars/${ctx.creator.id}/${Date.now()}-${fileName}`, body, {
      access: 'public',
      contentType: uploadType,
      allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const creator = await setCreatorAvatar(ctx.creator.id, blob.url);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    console.error('[me/avatar] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
