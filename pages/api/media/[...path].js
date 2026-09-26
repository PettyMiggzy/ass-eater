import { refuseMalformedText } from '../../../lib/field-validation';
import { getSessionUser } from '../../../lib/session';
import { getCreatorById, isPubliclyVisible } from '../../../lib/creators-store';
import { getListingById } from '../../../lib/listings-store';
import { effectiveCreatorStatus } from '../../../lib/creator-status';
import { gateConfigured } from '../../../lib/token-gate';
import {
  parseMediaPathname,
  mediaSrc,
  sendMedia,
  hasAdminMediaSession,
  buyerFirstDigitalOrderAt,
  canViewGatedCreatorMedia,
} from '../../../lib/media';
import { isMediaReaped, isOwnerUploadInProgress } from '../../../lib/media-refs';

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
 *   gallery/<creatorId>/...        admin always; the owner while it is on their record
 *                                  (or still uploading); otherwise the creator must
 *                                  be publicly visible, the item still in their
 *                                  gallery, and (if token-gated) the viewer must
 *                                  pass canViewGatedCreatorMedia
 *   listings/<cid>/<lid>/...       owner, admin, or a buyer holding a paid DIGITAL
 *                                  order for that listing -- never anyone else,
 *                                  and never once its files were deleted
 *                                  (mediaDeletedAt: a content takedown). A
 *                                  listing merely taken OFF SALE (the seller
 *                                  banned by hand, or deleted) still serves its
 *                                  buyers, even with no seller record left.
 *                                  An item the creator removed after a sale
 *                                  (retainedMedia) is served only to buyers
 *                                  whose order predates its removal.
 *
 * A BANNED creator is not treated as the owner of anything (round-16
 * media#0): a ban hides their gallery and avatar without deleting the files,
 * and the session a ban leaves signed in used to keep getting fresh presigned
 * URLs for exactly the image a takedown request was about. Admins still see
 * everything; a suspended creator still sees their own files.
 *
 * An owner is served only a file their record still points at, or an upload
 * still in progress (round-17 media#1, lib/media-refs.js
 * isOwnerUploadInProgress). A takedown drops the reference and leaves the
 * file itself to deleteMediaQuietly, which skips a file on a report hold and
 * leaves a failed delete to the daily sweep -- the owner path used to serve
 * any file in their prefix, so the uploader kept getting the exact file a
 * TAKE IT DOWN request recorded as removed until it was really gone.
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
  // NUL / half an emoji in a query value is a 400, never a 500 from pg (round-11 fix-up).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parts = Array.isArray(req.query.path) ? req.query.path : [];
  const parsed = parseMediaPathname(parts.join('/'));
  if (!parsed) return notFound(res);

  try {
    const admin = hasAdminMediaSession(req);
    const src = mediaSrc(parsed.pathname);

    if (parsed.purpose === 'listing') {
      // Resolved from the LISTING, not the creator: a buyer keeps what they
      // paid for even after the seller's record is deleted (their paid
      // listings keep their files -- lib/listings-store.js
      // removeListingsForCreator keepPaid), so a missing creator must not
      // turn a paid file into a 404.
      const listing = await getListingById(parsed.listingId);
      if (!listing || String(listing.creatorId) !== String(parsed.creatorId)) return notFound(res);
      if (admin) return await sendMedia(req, res, parsed.pathname);
      const user = await getSessionUser(req);
      const creator = await getCreatorById(parsed.creatorId);
      const owner = !!creator && !!user && user.role === 'creator' && String(user.creatorId) === String(creator.id)
        && effectiveCreatorStatus(creator) !== 'banned';
      if (owner) {
        // A file this app already DELETED is refused even while referenced:
        // an upload token can outlive its file and re-create it, and such a
        // re-upload is recorded nowhere. Otherwise the file must still be on
        // the listing (not a taken-down one), or be an upload in progress.
        if (await isMediaReaped(parsed.pathname)) return notFound(res);
        const onListing = !listing.mediaDeletedAt
          && [...(Array.isArray(listing.media) ? listing.media : []), ...(Array.isArray(listing.retainedMedia) ? listing.retainedMedia : [])]
            .some((m) => m && m.src === src);
        if (!onListing && !(await isOwnerUploadInProgress(parsed.pathname))) return notFound(res);
        return await sendMedia(req, res, parsed.pathname);
      }
      if (listing.mediaDeletedAt || !user) return notFound(res);
      const firstOrderAt = await buyerFirstDigitalOrderAt(user.id, listing.id);
      if (firstOrderAt === null) return notFound(res);
      const live = (Array.isArray(listing.media) ? listing.media : []).some((m) => m && m.src === src);
      const retained = (Array.isArray(listing.retainedMedia) ? listing.retainedMedia : []).some((m) => {
        if (!m || m.src !== src) return false;
        const gone = Date.parse(m.removedAt || '');
        return !Number.isNaN(gone) && firstOrderAt <= gone;
      });
      if (!live && !retained) return notFound(res);
      return await sendMedia(req, res, parsed.pathname);
    }

    const creator = await getCreatorById(parsed.creatorId);
    if (!creator) return notFound(res);

    const user = admin ? null : await getSessionUser(req);
    const owner = !!user && user.role === 'creator' && String(user.creatorId) === String(creator.id)
      && effectiveCreatorStatus(creator) !== 'banned';

    // Same rule as the listing branch: an owner is never served a file this
    // app has deleted (a token-replayed re-upload nothing records), and only
    // a file their record still points at or an upload in progress.
    let ownerMay = false;
    if (owner && !admin && !(await isMediaReaped(parsed.pathname))) {
      const onRecord = creator.img === src || creator.video === src
        || (Array.isArray(creator.gallery) ? creator.gallery : []).some((g) => g && g.src === src);
      ownerMay = onRecord || (await isOwnerUploadInProgress(parsed.pathname));
    }

    let allowed = admin || ownerMay;
    if (!allowed) {
      if (parsed.purpose === 'avatar') {
        allowed = isPubliclyVisible(creator) && creator.img === src;
      } else if (parsed.purpose === 'gallery') {
        const inGallery = (Array.isArray(creator.gallery) ? creator.gallery : []).some((g) => g && g.src === src);
        allowed =
          inGallery &&
          isPubliclyVisible(creator) &&
          // The raw setting, never isTokenGated (display only): a gated
          // creator with one legacy public-file src must not have every
          // private upload served to non-holders (fails closed).
          (!gateConfigured(creator) || (await canViewGatedCreatorMedia(req, creator)));
      }
    }
    if (!allowed) return notFound(res);

    return await sendMedia(req, res, parsed.pathname);
  } catch (err) {
    console.error('[media] unexpected error:', err);
    if (!res.headersSent) return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
