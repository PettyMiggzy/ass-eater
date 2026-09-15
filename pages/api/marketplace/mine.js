import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { getListings } from '../../../lib/listings-store';

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
