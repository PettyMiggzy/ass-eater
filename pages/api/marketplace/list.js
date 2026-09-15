import { getListings } from '../../../lib/listings-store';
import { getCreators } from '../../../lib/creators-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const [listings, creators] = await Promise.all([getListings(), getCreators()]);
  const q = (req.query.q || '').toLowerCase().trim();

  const active = listings
    .filter((l) => l.status === 'active')
    .filter((l) => !q || l.title.toLowerCase().includes(q) || (l.description || '').toLowerCase().includes(q))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((l) => {
      const creator = creators.find((c) => String(c.id) === String(l.creatorId));
      return { ...l, creatorName: creator?.name || 'Unknown', creatorHandle: creator?.handle || '' };
    });

  return res.status(200).json({ listings: active });
}
