import { getSessionUser } from '../../../lib/session';
import { getCreatorById, isPubliclyVisible } from '../../../lib/creators-store';
import { getListingById } from '../../../lib/listings-store';
import { isTokenGated } from '../../../lib/token-gate';
import {
  parseMediaPathname,
  mediaSrc,
  sendMedia,
  hasAdminMediaSession,
  buyerHasDigitalOrder,
  canViewGatedCreatorMedia,
} from '../../../lib/media';

/**
 * GET /api/media/<pathname> -- the only way any uploaded file is served.
 *
 * Entitlement is decided here, per request, and then the viewer is sent a
 * ~10 minute presigned URL (or the bytes are streamed). The store is private,
 * so there is no permanent URL to leak, and removing a reference really does
 * cut access.
 *
 *   avatars/<creatorId>/...        anyone, if the creator is publicly visible
 *                                  and it is their current avatar; else owner/admin
 *   gallery/<creatorId>/...        owner/admin always; otherwise the creator must
 *                                  be publicly visible, the item still in their
 *                                  gallery, and (if token-gated) the viewer must
 *                                  pass canViewGatedCreatorMedia
 *   listings/<cid>/<lid>/...       owner, admin, or a buyer holding a paid DIGITAL
 *                                  order for that listing -- never anyone else,
 *                                  and never once moderation removed it
 *
 * Everything unentitled answers 404, not 403: "does this file exist" is not
 * something to confirm to someone who may not see it. proxy.js already puts
 * /api/* behind the state age-verification gate.
 */
// Streaming fallback can send files far larger than Next's default 4MB API
// response warning threshold.
export const config = { api: { responseLimit: false } };

function notFound(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(404).json({ error: 'Not found' });
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parts = Array.isArray(req.query.path) ? req.query.path : [];
  const parsed = parseMediaPathname(parts.join('/'));
  if (!parsed) return notFound(res);

  try {
    const creator = await getCreatorById(parsed.creatorId);
    if (!creator) return notFound(res);

    const admin = hasAdminMediaSession(req);
    const user = admin ? null : await getSessionUser(req);
    const owner = !!user && user.role === 'creator' && String(user.creatorId) === String(creator.id);
    const src = mediaSrc(parsed.pathname);

    let allowed = admin || owner;
    if (!allowed) {
      if (parsed.purpose === 'avatar') {
        allowed = isPubliclyVisible(creator) && creator.img === src;
      } else if (parsed.purpose === 'gallery') {
        const inGallery = (Array.isArray(creator.gallery) ? creator.gallery : []).some((g) => g && g.src === src);
        allowed =
          inGallery &&
          isPubliclyVisible(creator) &&
          (!isTokenGated(creator) || (await canViewGatedCreatorMedia(req, creator)));
      } else if (parsed.purpose === 'listing') {
        const listing = await getListingById(parsed.listingId);
        const inListing =
          !!listing &&
          String(listing.creatorId) === String(creator.id) &&
          !listing.moderationRemoved &&
          (Array.isArray(listing.media) ? listing.media : []).some((m) => m && m.src === src);
        allowed = inListing && !!user && (await buyerHasDigitalOrder(user.id, listing.id));
      }
    }
    if (!allowed) return notFound(res);

    return await sendMedia(req, res, parsed.pathname);
  } catch (err) {
    console.error('[media] unexpected error:', err);
    if (!res.headersSent) return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
