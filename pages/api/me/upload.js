import { put } from '@vercel/blob';
import { readLimitedBody, acceptedUploadType, UPLOAD_TYPE_MESSAGE, UPLOAD_SIZE_MESSAGE } from '../../../lib/upload-guard';
import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { addGalleryItem } from '../../../lib/creators-store';

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

  let knownGallery;
  try {
    if (req.headers['x-current-gallery']) {
      knownGallery = JSON.parse(req.headers['x-current-gallery']);
    }
  } catch {
    knownGallery = undefined;
  }

  // Bumped way up from the original 4/10 -- creators bringing an existing back-
  // catalog need real headroom, not a handful of slots. Still capped (not
  // unlimited) since Vercel Blob storage cost scales with what's actually
  // uploaded -- revisit these two numbers if real usage says otherwise.
  //
  // The limit check must use ctx.creator.gallery (freshly fetched by
  // requireCreatorOwner for THIS request), never the client-supplied
  // x-current-gallery header -- that header is just a snapshot the
  // browser sends, and trusting it here meant sending an empty array
  // bypassed the slot limit entirely, for anyone.
  const limit = ctx.creator.premium ? 200 : 50;
  const used = (ctx.creator.gallery || []).length;
  if (used >= limit) {
    return res.status(403).json({
      error: ctx.creator.premium
        ? `You've used all ${limit} of your Premium content slots.`
        : `Free accounts get ${limit} content slots. Upgrade to Premium for 200.`,
      limit,
      used,
    });
  }

  const fileName = req.headers['x-file-name'] || `upload-${Date.now()}`;
  const fileType = req.headers['x-file-type'] || 'image';
  const aiGenerated = req.headers['x-ai-generated'] === 'true';

  // Allowlisted, not taken from the header -- see lib/upload-guard.js.
  const uploadType = acceptedUploadType(req);
  if (!uploadType) return res.status(400).json({ error: UPLOAD_TYPE_MESSAGE });

  try {
    const body = await readLimitedBody(req);
    if (!body) return res.status(413).json({ error: UPLOAD_SIZE_MESSAGE });
    const blob = await put(`content/${ctx.creator.id}/${Date.now()}-${fileName}`, body, {
      access: 'public',
      contentType: uploadType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const creator = await addGalleryItem(ctx.creator.id, { type: fileType, src: blob.url, aiGenerated }, knownGallery);
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
