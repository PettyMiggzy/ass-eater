import { isTokenGated, formatGate } from '../../lib/token-gate';
import { isDemoCreator, isDemoListing } from '../../lib/creator-status';

/**
 * Pure helpers shared by the public browse pages (/home, /creators, /search,
 * /favorites, /marketplace, /creator/[id]). No database, no node imports --
 * safe in both getServerSideProps and the browser bundle.
 */

/**
 * The platform's own demo/seed profiles (data/creators.js, plus any record
 * an admin marked `demo`). They exist to show what a page looks like; nothing
 * of theirs can be bought -- checkout refuses them -- so every surface that
 * shows one labels it, and no surface offers a buy button for it.
 *
 * Re-exported from lib/creator-status.js rather than defined here: checkout,
 * transferWithFee and payouts use that one predicate, so the label on the page
 * and what the server refuses can never drift apart.
 */
export { isDemoCreator, isDemoListing };

export const DEMO_LABEL = 'Demo — not for sale';

/**
 * The card a browse page needs for one creator -- and nothing else. Input
 * must ALREADY be a toPublicCreator() projection (private fields gone, a
 * gated creator's media srcs gone). Shipping whole gallery arrays to every
 * visitor of a listing page was wasteful at best, and for a gated creator it
 * was the leak itself; a card needs a count, not the files.
 *
 * Every value is null rather than undefined: getServerSideProps refuses to
 * serialise undefined.
 */
export function toCreatorCard(pub) {
  if (!pub) return null;
  const gallery = Array.isArray(pub.gallery) ? pub.gallery : [];
  const gated = isTokenGated(pub);
  return {
    id: pub.id,
    name: typeof pub.name === 'string' ? pub.name : '',
    handle: typeof pub.handle === 'string' ? pub.handle : '',
    img: typeof pub.img === 'string' ? pub.img : null,
    // toPublicCreator already nulls this for a gated creator the viewer has
    // not unlocked; never send it on a card for a gated creator at all.
    video: !gated && typeof pub.video === 'string' ? pub.video : null,
    founding: !!pub.founding,
    trending: !!pub.trending,
    premium: !!pub.premium,
    tags: Array.isArray(pub.tags) ? pub.tags.filter((t) => typeof t === 'string') : [],
    galleryCount: gallery.length,
    gated,
    gateLabel: gated ? formatGate(pub) : '',
    demo: isDemoCreator(pub),
  };
}

/**
 * Where a listing tile (a creator's Marketplace tab, /search results) links:
 * the marketplace scoped to that creator and scrolled to the item, rather
 * than the unfiltered founding-first marketplace with no way to find it.
 * pages/marketplace.js reads both params server-side.
 */
export function marketplaceHrefFor(listing) {
  const params = new URLSearchParams();
  if (listing?.creatorId != null) params.set('creator', String(listing.creatorId));
  if (listing?.id != null) params.set('listing', String(listing.id));
  const qs = params.toString();
  return qs ? `/marketplace?${qs}` : '/marketplace';
}
