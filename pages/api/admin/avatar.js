import { put } from '@vercel/blob';
import { setCreatorAvatar } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const creatorId = req.headers['x-creator-id'];
  const fileName = req.headers['x-file-name'] || `avatar-${Date.now()}`;

  if (!creatorId) {
    return res.status(400).json({ error: 'Missing creator id' });
  }

  try {
    const body = await readBody(req);
    const blob = await put(`avatars/${creatorId}/${Date.now()}-${fileName}`, body, {
      access: 'public',
      contentType: req.headers['content-type'] || 'application/octet-stream',
      allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const creator = await setCreatorAvatar(creatorId, blob.url);

    return res.status(200).json({ ok: true, blob, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
