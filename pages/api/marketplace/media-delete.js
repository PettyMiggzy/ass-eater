import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import {
  removeListingMediaForOwner,
  LISTING_NOT_EDITABLE,
  MEDIA_ITEM_GONE,
} from '../../../lib/listings-store';
import { consumeAttempt } from '../../../lib/rate-limit';

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_CREATOR = 120;

/**
 * POST /api/marketplace/media-delete -- the owner removes ONE photo/video from
 * their listing.
 * JSON { listingId, src } -> 200 { ok: true, listing, retained }
 *   403 sold or removed-by-moderation listing; 404 not their listing, or the
 *   item is no longer on it.
 *
 * `src` (the stored /api/media/... path) identifies the item, not a position,
 * so a stale dashboard can never remove a different file from the one
 * clicked. If nobody has bought the listing the file is deleted from storage.
 * If someone has, the item comes off the listing (it is no longer for sale or
 * previewed) but the file is kept for the buyers who paid before this moment
 * -- `retained: true` tells the dashboard to say so. See
 * lib/listings-store.js removeListingMediaForOwner.
 *
 * Before this existed a wrong upload -- even one showing someone who never
 * consented -- could only be dealt with by pulling the whole listing, and the
 * file stayed in storage either way.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { listingId, src } = req.body && typeof req.body === 'object' ? req.body : {};
  const idOk = (typeof listingId === 'string' && /^\d{1,18}$/.test(listingId)) || (Number.isSafeInteger(listingId) && listingId > 0);
  if (!idOk || typeof src !== 'string' || !src || src.length > 512) {
    return res.status(400).json({ error: 'Missing listing or item' });
  }

  const { limited, retryAfterSeconds } = consumeAttempt(`marketplace-media-delete:creator:${ctx.creator.id}`, {
    limit: MAX_PER_CREATOR,
    windowMs: WINDOW_MS,
  });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many edits recently. Please wait a while and try again.' });
  }

  try {
    const { listing, retained } = await removeListingMediaForOwner(String(listingId), ctx.creator.id, src);
    return res.status(200).json({ ok: true, listing, retained });
  } catch (err) {
    if (err.code === LISTING_NOT_EDITABLE) return res.status(403).json({ error: 'This listing can no longer be edited.' });
    if (err.code === MEDIA_ITEM_GONE) return res.status(404).json({ error: 'That item is no longer on this listing.' });
    if (err.message === 'Listing not found') return res.status(404).json({ error: 'Listing not found' });
    console.error('[marketplace/media-delete] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
