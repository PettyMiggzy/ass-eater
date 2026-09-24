import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { getListings } from '../../../lib/listings-store';

/**
 * GET /api/marketplace/mine -> { listings: Listing[] }
 * The creator's OWN listings, full records including media srcs
 * (/api/media/... paths, which the media route serves to the owner) and the
 * `moderationRemoved` flag so the dashboard can hide Reactivate for a listing
 * moderation took down.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const listings = await getListings();
  const mine = listings
    .filter((l) => String(l.creatorId) === String(ctx.creator.id))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return res.status(200).json({ listings: mine });
}
