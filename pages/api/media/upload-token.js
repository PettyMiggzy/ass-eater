import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { requireAdminKey } from '../../../lib/admin-auth';
import { consumeAttempt, clientIp } from '../../../lib/rate-limit';
import { getCreatorById } from '../../../lib/creators-store';
import { getListingById } from '../../../lib/listings-store';
import { LISTING_LIMITS } from '../../../lib/creator-status';
import {
  UPLOAD_PURPOSES,
  mediaKindFor,
  maxBytesFor,
  normalizeContentType,
  UPLOAD_TYPE_MESSAGE,
  AVATAR_TYPE_MESSAGE,
  uploadSizeMessage,
} from '../../../lib/upload-guard';
import { blobConfigured, galleryLimitFor, issueUploadToken, newMediaPathname } from '../../../lib/media';

/**
 * POST /api/media/upload-token
 * JSON { purpose: 'gallery'|'avatar'|'listing', contentType, size, listingId?, creatorId? }
 *   -> 200 { pathname, clientToken, contentType, maxBytes, validUntil }
 *
 * Issues a Vercel Blob client token for ONE server-chosen pathname in the
 * caller's own prefix. The browser then uploads straight to the private store
 * (see lib/media.js for the whole flow) and calls the matching finalize route.
 *
 * Auth: a creator session (pending creators may upload so they can finish
 * their profile before approval; suspended/banned may not -- that is
 * requireCreatorOwner's rule), or the admin key header with `creatorId`.
 *
 * Caps are checked here as a cheap early refusal so nothing gets uploaded that
 * would be refused anyway; the authoritative checks run again at finalize,
 * against fresh state, inside the write.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_CREATOR = 60;
const MAX_PER_ADMIN_IP = 200;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { purpose, size } = body;
  const contentType = normalizeContentType(body.contentType);

  const asAdmin = typeof req.headers['x-admin-key'] === 'string' && req.headers['x-admin-key'] !== '';
  let creator;
  let rateKey;
  let rateLimit;
  if (asAdmin) {
    if (!requireAdminKey(req, res)) return;
    const cid = body.creatorId;
    if ((typeof cid !== 'string' && typeof cid !== 'number') || !String(cid)) {
      return res.status(400).json({ error: 'Missing creatorId' });
    }
    creator = await getCreatorById(String(cid));
    if (!creator) return res.status(404).json({ error: 'Creator not found' });
    rateKey = `media-token:admin-ip:${clientIp(req)}`;
    rateLimit = MAX_PER_ADMIN_IP;
  } else {
    const ctx = await requireCreatorOwner(req, res);
    if (!ctx) return;
    creator = ctx.creator;
    rateKey = `media-token:creator:${creator.id}`;
    rateLimit = MAX_PER_CREATOR;
  }

  if (typeof purpose !== 'string' || !UPLOAD_PURPOSES.includes(purpose)) {
    return res.status(400).json({ error: 'Unknown upload purpose' });
  }
  // There is no admin finalize route for listing media -- listings are the
  // creator's own shop -- so an admin token for one would only strand a file.
  if (asAdmin && purpose === 'listing') {
    return res.status(400).json({ error: 'Listing media is uploaded by the creator.' });
  }
  if (!mediaKindFor(purpose, contentType)) {
    return res.status(400).json({ error: purpose === 'avatar' ? AVATAR_TYPE_MESSAGE : UPLOAD_TYPE_MESSAGE });
  }
  const maxBytes = maxBytesFor(purpose, contentType);
  if (!Number.isSafeInteger(size) || size <= 0) return res.status(400).json({ error: 'Missing file size' });
  if (size > maxBytes) return res.status(413).json({ error: uploadSizeMessage(purpose, contentType), maxBytes });

  if (!blobConfigured()) {
    console.error('[media/upload-token] BLOB_READ_WRITE_TOKEN is not set');
    return res.status(503).json({ error: 'Uploads are temporarily unavailable.' });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(rateKey, { limit: rateLimit, windowMs: WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many uploads. Please wait a few minutes and try again.' });
  }

  let listingId;
  if (purpose === 'gallery') {
    const limit = asAdmin ? 200 : galleryLimitFor(creator);
    const used = Array.isArray(creator.gallery) ? creator.gallery.length : 0;
    if (used >= limit) {
      return res.status(403).json({
        error: creator.premium || asAdmin
          ? `All ${limit} content slots are in use.`
          : `Free accounts get ${limit} content slots. Upgrade to Premium for 200.`,
        limit,
        used,
      });
    }
  } else if (purpose === 'listing') {
    const listing = await getListingById(body.listingId);
    if (!listing || String(listing.creatorId) !== String(creator.id)) {
      return res.status(404).json({ error: 'Listing not found' });
    }
    if (listing.status === 'sold' || listing.moderationRemoved) {
      return res.status(403).json({ error: 'This listing can no longer be edited.' });
    }
    if ((Array.isArray(listing.media) ? listing.media.length : 0) >= LISTING_LIMITS.maxMedia) {
      return res.status(403).json({ error: `Listings can have up to ${LISTING_LIMITS.maxMedia} items.` });
    }
    listingId = String(listing.id);
  }

  const pathname = newMediaPathname({ purpose, creatorId: creator.id, listingId, contentType });
  if (!pathname) return res.status(400).json({ error: 'Could not prepare that upload.' });

  try {
    const { clientToken, validUntil } = await issueUploadToken({ pathname, contentType, maxBytes });
    return res.status(200).json({ pathname, clientToken, contentType, maxBytes, validUntil });
  } catch (err) {
    console.error('[media/upload-token] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
