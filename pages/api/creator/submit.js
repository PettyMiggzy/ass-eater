import { put } from '@vercel/blob';
import { addPendingCreator } from '../../../lib/creators-store';

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readMultipart(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Expected multipart/form-data' });
    }

    const body = await readMultipart(req);
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) return res.status(400).json({ error: 'No boundary found' });
    const boundary = '--' + boundaryMatch[1];

    const parts = body.toString('binary').split(boundary).slice(1, -1);
    const fields = {};
    const files = [];

    for (const part of parts) {
      const [rawHeaders, ...rest] = part.split('\r\n\r\n');
      const content = rest.join('\r\n\r\n').slice(0, -2);
      const nameMatch = rawHeaders.match(/name="([^"]+)"/);
      const filenameMatch = rawHeaders.match(/filename="([^"]+)"/);
      if (!nameMatch) continue;

      if (filenameMatch && filenameMatch[1]) {
        const fileTypeMatch = rawHeaders.match(/Content-Type: (.+)/);
        files.push({
          field: nameMatch[1],
          filename: filenameMatch[1],
          contentType: fileTypeMatch ? fileTypeMatch[1].trim() : 'application/octet-stream',
          buffer: Buffer.from(content, 'binary'),
        });
      } else {
        fields[nameMatch[1]] = content;
      }
    }

    if (!fields.name || !fields.handle || !fields.bio) {
      return res.status(400).json({ error: 'Missing required fields (name, handle, bio)' });
    }

    let avatarUrl = null;
    const gallery = [];

    for (const file of files) {
      const blob = await put(`pending-creators/${Date.now()}-${file.filename}`, file.buffer, {
        access: 'public',
        contentType: file.contentType,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      if (file.field === 'avatar') {
        avatarUrl = blob.url;
      } else {
        gallery.push({ type: file.contentType.startsWith('video') ? 'video' : 'image', src: blob.url });
      }
    }

    const creator = await addPendingCreator({
      name: fields.name,
      handle: fields.handle.startsWith('@') ? fields.handle : `@${fields.handle}`,
      bio: fields.bio,
      contactEmail: fields.email || null,
      img: avatarUrl || '/images/mascot.png',
      video: null,
      price: fields.price ? `${fields.price} $ONLYASS` : '1M $ONLYASS',
      gallery,
    });

    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
