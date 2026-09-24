import { isTokenGated, formatGate } from '../../lib/token-gate';

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
 */
export function isDemoCreator(creator) {
  return !!creator && (creator.seed === true || creator.demo === true);
}

/** A listing is demo if it says so itself, or belongs to a demo creator. */
export function isDemoListing(listing, creator = null) {
  return !!listing && (listing.demo === true || listing.seed === true || isDemoCreator(creator));
}

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
    price: typeof pub.price === 'string' ? pub.price : null,
    founding: !!pub.founding,
    trending: !!pub.trending,
    premium: !!pub.premium,
    subs: pub.subs ?? null,
    tags: Array.isArray(pub.tags) ? pub.tags.filter((t) => typeof t === 'string') : [],
    galleryCount: gallery.length,
    gated,
    gateLabel: gated ? formatGate(pub) : '',
    demo: isDemoCreator(pub),
  };
}
