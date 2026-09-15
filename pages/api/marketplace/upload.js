import { put } from '@vercel/blob';
import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { getListings, addListingMedia } from '../../../lib/listings-store';

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

  const listingId = req.headers['x-listing-id'];
  if (!listingId) return res.status(400).json({ error: 'Missing listing id' });

  const listings = await getListings();
  const listing = listings.find((l) => String(l.id) === String(listingId));
  if (!listing || String(listing.creatorId) !== String(ctx.creator.id)) {
    return res.status(404).json({ error: 'Listing not found' });
  }
  if ((listing.media || []).length >= 10) {
    return res.status(403).json({ error: 'Listings can have up to 10 items.' });
  }

  const fileName = req.headers['x-file-name'] || `upload-${Date.now()}`;
  const fileType = req.headers['x-file-type'] || 'image';

  let knownMedia;
  try {
    if (req.headers['x-current-media']) knownMedia = JSON.parse(req.headers['x-current-media']);
  } catch {
    knownMedia = undefined;
  }

  try {
    const body = await readBody(req);
    const blob = await put(`listings/${ctx.creator.id}/${Date.now()}-${fileName}`, body, {
      access: 'public',
      contentType: req.headers['content-type'] || 'application/octet-stream',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const updated = await addListingMedia(listingId, { type: fileType, src: blob.url }, knownMedia);
    return res.status(200).json({ ok: true, listing: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
