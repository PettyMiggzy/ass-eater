import { getListings } from '../../../lib/listings-store';
import { getCreators } from '../../../lib/creators-store';
import { isPubliclyVisible } from '../../../lib/creator-status';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const [listings, creators] = await Promise.all([getListings(), getCreators()]);
  const q = (req.query.q || '').toLowerCase().trim();

  // Resolved against the PUBLICLY VISIBLE roster, and a listing whose seller
  // isn't on it is dropped entirely rather than shown with the name masked.
  // Both halves were wrong: this unauthenticated endpoint used the unfiltered
  // roster, so a suspended, banned or still-pending creator's real name and
  // handle were readable here; and a banned creator's merch stayed on sale
  // with only the seller name changed to "Unknown".
  const visible = new Map(
    creators.filter(isPubliclyVisible).map((c) => [String(c.id), c]),
  );

  const active = listings
    .filter((l) => l.status === 'active')
    .filter((l) => visible.has(String(l.creatorId)))
    .filter((l) => !q || String(l.title || '').toLowerCase().includes(q) || String(l.description || '').toLowerCase().includes(q))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((l) => {
      const creator = visible.get(String(l.creatorId));
      return { ...l, creatorName: creator.name, creatorHandle: creator.handle || '' };
    });

  return res.status(200).json({ listings: active });
}
