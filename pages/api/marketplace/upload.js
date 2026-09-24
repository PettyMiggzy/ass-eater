import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { addListingMediaForOwner, MEDIA_CAP_EXCEEDED, LISTING_NOT_EDITABLE } from '../../../lib/listings-store';
import { LISTING_LIMITS, isValidListingPreview } from '../../../lib/creator-status';
import { mediaSrc, parseMediaPathname, verifyUploadedBlob, deleteBlobQuietly, MediaRejected } from '../../../lib/media';

const MEDIA_CAP_MESSAGE = `Listings can have up to ${LISTING_LIMITS.maxMedia} items.`;

/**
 * POST /api/marketplace/upload -- finalize one listing media upload.
 * JSON { listingId, pathname, preview?, aiGenerated? } -> 200 { ok: true, listing, item }
 *
 * Token from POST /api/media/upload-token { purpose: 'listing', listingId, ... }.
 * `preview` is the tiny blurred JPEG/WebP data URL (<= 16KB) the creator's
 * browser renders from the file before uploading it. It is the ONLY image of
 * this media any non-buyer ever receives (lib/creator-status.js
 * toPublicListing); the file itself is served only to the owner, admins and
 * buyers with a digital order (pages/api/media/[...path].js).
 *
 * Ownership, the 10-item cap, and "not sold / not moderated" are enforced
 * inside the write (addListingMediaForOwner).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { listingId, pathname, preview, aiGenerated } = req.body && typeof req.body === 'object' ? req.body : {};
  const parsed = parseMediaPathname(pathname);
  if (
    !parsed ||
    parsed.purpose !== 'listing' ||
    parsed.creatorId !== String(ctx.creator.id) ||
    parsed.listingId !== String(listingId ?? '')
  ) {
    return res.status(400).json({ error: 'That upload does not belong to this listing.' });
  }
  if (preview != null && !isValidListingPreview(preview)) {
    return res.status(400).json({ error: 'The preview image is invalid or too large.' });
  }

  try {
    const { kind } = await verifyUploadedBlob(pathname, 'listing');
    const item = {
      type: kind,
      src: mediaSrc(pathname),
      preview: preview ?? null,
      aiGenerated: aiGenerated === true,
    };
    try {
      const listing = await addListingMediaForOwner(parsed.listingId, ctx.creator.id, item, undefined, LISTING_LIMITS.maxMedia);
      return res.status(200).json({ ok: true, listing, item });
    } catch (err) {
      if (err.code === MEDIA_CAP_EXCEEDED || err.code === LISTING_NOT_EDITABLE || err.message === 'Listing not found') {
        await deleteBlobQuietly(pathname);
        if (err.code === MEDIA_CAP_EXCEEDED) return res.status(403).json({ error: MEDIA_CAP_MESSAGE });
        if (err.code === LISTING_NOT_EDITABLE) return res.status(403).json({ error: 'This listing can no longer be edited.' });
        return res.status(404).json({ error: 'Listing not found' });
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof MediaRejected) return res.status(err.status).json({ error: err.message });
    console.error('[marketplace/upload] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
