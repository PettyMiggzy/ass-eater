import { put } from '@vercel/blob';
import { readLimitedBody, acceptedUploadType, UPLOAD_TYPE_MESSAGE, UPLOAD_SIZE_MESSAGE } from '../../../lib/upload-guard';
import { addGalleryItem } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const creatorId = req.headers['x-creator-id'];
  const fileName = req.headers['x-file-name'] || `upload-${Date.now()}`;
  const fileType = req.headers['x-file-type'] || 'image';
  const aiGenerated = req.headers['x-ai-generated'] === 'true';

  if (!creatorId) {
    return res.status(400).json({ error: 'Missing creator id' });
  }

  let knownGallery;
  try {
    if (req.headers['x-current-gallery']) {
      knownGallery = JSON.parse(req.headers['x-current-gallery']);
    }
  } catch {
    knownGallery = undefined;
  }

  // Allowlisted, not taken from the header -- see lib/upload-guard.js.
  const uploadType = acceptedUploadType(req);
  if (!uploadType) return res.status(400).json({ error: UPLOAD_TYPE_MESSAGE });

  try {
    const body = await readLimitedBody(req);
    if (!body) return res.status(413).json({ error: UPLOAD_SIZE_MESSAGE });
    const blob = await put(`content/${creatorId}/${Date.now()}-${fileName}`, body, {
      access: 'public',
      contentType: uploadType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const creator = await addGalleryItem(
      creatorId,
      {
        type: fileType,
        src: blob.url,
        aiGenerated,
      },
      knownGallery
    );

    return res.status(200).json({ ok: true, blob, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
