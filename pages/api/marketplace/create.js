import { requireCreatorOwner } from '../../../lib/require-creator-owner';
import { createListing } from '../../../lib/listings-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireCreatorOwner(req, res);
  if (!ctx) return;

  const { title, description, priceCents, unlimited } = req.body || {};
  if (!title || !priceCents || priceCents < 100) {
    return res.status(400).json({ error: 'Title and a price of at least $1 are required' });
  }

  try {
    const listing = await createListing(ctx.creator.id, { title, description, priceCents, unlimited });
    return res.status(200).json({ ok: true, listing });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
