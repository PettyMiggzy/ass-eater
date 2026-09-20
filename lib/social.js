/**
 * The platform's own social accounts, in one place.
 *
 * One file because these end up in three unrelated spots -- page footers,
 * the Organization JSON-LD on the landing page, and anywhere a share kit
 * eventually references them -- and a handle that changes in two of three
 * is worse than one that was never listed.
 *
 * IMPORTANT: the Facebook URL is the numeric `profile.php?id=` form, which
 * is what Facebook serves when a Page has no username set. It works and it
 * is permanent, but the moment a username exists, swap this for
 * https://www.facebook.com/joinonlyone -- the vanity URL is what belongs in
 * a bio, a press mention and the JSON-LD below, and the numeric one keeps
 * redirecting so nothing breaks in the swap.
 *
 * These are PLATFORM accounts, not creator accounts. Nothing here is
 * user-supplied, so none of it goes through the payment-circumvention
 * filter -- if that ever stops being true, it needs to.
 */
export const SOCIAL_LINKS = [
  { name: 'Instagram', url: 'https://www.instagram.com/joinonlyone/' },
  { name: 'Facebook', url: 'https://www.facebook.com/profile.php?id=61594626598071' },
];

export const CONTACT_EMAIL = 'team@onlyone1.fun';
export const CANONICAL_ORIGIN = 'https://www.joinonlyone.com';

/**
 * Organization structured data for the public landing page.
 *
 * `sameAs` is the part that earns its place: it is how a search engine ties
 * these social profiles to this domain as one entity rather than three
 * unrelated things, which is the cheapest real SEO available to a site with
 * no inbound links yet.
 *
 * Deliberately no `logo` until real brand art exists at a stable URL -- a
 * schema field pointing at nothing is worse than an absent one, and the
 * only images in this repo are creator content, which must never be the
 * thing a search engine or a link preview expands.
 */
export function organizationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'OnlyOne',
    url: `${CANONICAL_ORIGIN}/`,
    description:
      'A creator platform for women, men, couples and everyone. Creators keep 90%. 18+ only.',
    email: CONTACT_EMAIL,
    sameAs: SOCIAL_LINKS.map((s) => s.url),
  };
}
