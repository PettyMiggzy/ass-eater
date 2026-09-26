import { refuseMalformedText } from '../../../lib/field-validation';
import { getListings } from '../../../lib/listings-store';
import { getCreators } from '../../../lib/creators-store';
import { isPubliclyVisible, toPublicListing, isDemoListing, listingHasDeliverable } from '../../../lib/creator-status';
import { categoriesOf, categoryFromQuery, creatorInCategory } from '../../../lib/categories';

/**
 * GET /api/marketplace/list?q=&category= -> { listings: PublicListing[] }
 * PublicListing = toPublicListing(listing) + { creatorName, creatorHandle,
 * creatorCategories, demo }. A listing has no category of its own: it
 * inherits its seller's (lib/categories.js), and ?category= filters on that.
 * An unknown ?category= value is ignored (no filter), never an error.
 * A digital listing with no files yet is left out: checkout refuses it
 * (nothing to deliver), so it must not be offered. `demo` marks a listing the
 * site shows as "Demo — not for sale" (checkout refuses those too).
 * Unauthenticated, so it NEVER carries a media src -- only { type, preview,
 * aiGenerated } per item. It used to return every listing's full-resolution
 * file URLs to anyone, with a CSS blur as the only "lock".
 */
export default async function handler(req, res) {
  // NUL / half an emoji in a query value is a 400, never a 500 from pg (round-11 fix-up).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const [listings, creators] = await Promise.all([getListings(), getCreators()]);
  const q = (typeof req.query.q === 'string' ? req.query.q : '').toLowerCase().trim();
  const category = categoryFromQuery(req.query.category);

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
    .filter(listingHasDeliverable)
    .filter((l) => creatorInCategory(visible.get(String(l.creatorId)), category))
    .filter((l) => !q || String(l.title || '').toLowerCase().includes(q) || String(l.description || '').toLowerCase().includes(q))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((l) => {
      const creator = visible.get(String(l.creatorId));
      return { ...toPublicListing(l, creator), creatorName: creator.name, creatorHandle: creator.handle || '', creatorCategories: categoriesOf(creator), demo: isDemoListing(l, creator) };
    });

  return res.status(200).json({ listings: active });
}
