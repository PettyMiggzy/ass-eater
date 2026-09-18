import { put } from '@vercel/blob';
import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { getListings, addListingMediaForOwner, MEDIA_CAP_EXCEEDED } from '../../../lib/listings-store';

export const config = {
  api: {
    bodyParser: false,
  },
};

const MAX_LISTING_MEDIA = 10;
const MEDIA_CAP_MESSAGE = `Listings can have up to ${MAX_LISTING_MEDIA} items.`;

// Same ceiling pages/api/creator/submit.js reads with. Vercel's own
// request-body limit is stricter in production; this bounds what any other
// deployment (and local dev) will buffer into memory before rejecting.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// Whatever is stored here is served straight back from a public blob URL with
// the Content-Type we save it under, so that is an allowlist, not "whatever
// the caller sent" -- text/html renders as a document on the blob origin, and
// SVG is an image that can carry script, so it is excluded on purpose. Mirrors
// the check pages/api/creator/submit.js runs on the public application form.
const ALLOWED_UPLOAD_TYPE = /^(image|video)\//;
const SVG_TYPE = /^image\/svg/;

/** Returns null (rather than throwing) once the request body passes MAX_UPLOAD_BYTES. */
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) return null;
    chunks.push(chunk);
  }
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

  // Cheap pre-check so an over-cap upload doesn't get written to blob storage
  // first and rejected after. The authoritative count is the one inside the
  // guarded write below.
  const listings = await getListings();
  const listing = listings.find((l) => String(l.id) === String(listingId));
  if (!listing || String(listing.creatorId) !== String(ctx.creator.id)) {
    return res.status(404).json({ error: 'Listing not found' });
  }
  if ((listing.media || []).length >= MAX_LISTING_MEDIA) {
    return res.status(403).json({ error: MEDIA_CAP_MESSAGE });
  }

  // Parameters stripped first -- browsers send "video/mp4; codecs=..." and the
  // whole header is what gets stored on the blob.
  const uploadType = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!ALLOWED_UPLOAD_TYPE.test(uploadType) || SVG_TYPE.test(uploadType)) {
    return res.status(400).json({ error: 'Only image and video uploads are accepted.' });
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
    if (!body) {
      return res.status(413).json({ error: `File is too large (limit ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB).` });
    }
    const blob = await put(`listings/${ctx.creator.id}/${Date.now()}-${fileName}`, body, {
      access: 'public',
      contentType: uploadType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    // Ownership and the 10-item cap are both enforced inside the write
    // itself -- see addListingMediaForOwner. Two uploads racing cannot both
    // pass a check at 9 items and leave the listing at 11.
    const updated = await addListingMediaForOwner(
      listingId,
      ctx.creator.id,
      { type: fileType, src: blob.url },
      knownMedia,
      MAX_LISTING_MEDIA,
    );

    return res.status(200).json({ ok: true, listing: updated });
  } catch (err) {
    if (err.code === MEDIA_CAP_EXCEEDED) return res.status(403).json({ error: MEDIA_CAP_MESSAGE });
    return res.status(500).json({ error: err.message });
  }
}
