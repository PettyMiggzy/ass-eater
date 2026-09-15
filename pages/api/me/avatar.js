import { put } from '@vercel/blob';
import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { setCreatorAvatar } from '../../../lib/creators-store';

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

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const fileName = req.headers['x-file-name'] || `avatar-${Date.now()}`;

  try {
    const body = await readBody(req);
    const blob = await put(`avatars/${ctx.creator.id}/${Date.now()}-${fileName}`, body, {
      access: 'public',
      contentType: req.headers['content-type'] || 'application/octet-stream',
      allowOverwrite: true,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const creator = await setCreatorAvatar(ctx.creator.id, blob.url);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
