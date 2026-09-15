import { put } from '@vercel/blob';
import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { addGalleryItem } from '../../../lib/creators-store';

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

  const limit = ctx.creator.premium ? 10 : 4;
  const used = ctx.creator.gallery?.length || 0;
  if (used >= limit) {
    return res.status(403).json({
      error: ctx.creator.premium
        ? `You've used all ${limit} of your Premium content slots.`
        : `Free accounts get ${limit} content slots. Upgrade to Premium for 10.`,
      limit,
      used,
    });
  }

  const fileName = req.headers['x-file-name'] || `upload-${Date.now()}`;
  const fileType = req.headers['x-file-type'] || 'image';

  try {
    const body = await readBody(req);
    const blob = await put(`content/${ctx.creator.id}/${Date.now()}-${fileName}`, body, {
      access: 'public',
      contentType: req.headers['content-type'] || 'application/octet-stream',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const creator = await addGalleryItem(ctx.creator.id, { type: fileType, src: blob.url });
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
