/**
 * The platform's own social accounts, in one place.
 *
 * One file because these end up in three unrelated spots -- page footers,
 * the Organization JSON-LD on the landing page, and anywhere a share kit
 * eventually references them -- and a handle that changes in two of three
 * is worse than one that was never listed.
 *
 * Both URLs are the vanity form, matching the handle on each network. The
 * Facebook one was the numeric `profile.php?id=61594626598071` until the
 * Page username was set (2026-09-20); that old URL still redirects here, so
 * anything already sharing it keeps working.
 *
 * These are PLATFORM accounts, not creator accounts. Nothing here is
 * user-supplied, so none of it goes through the payment-circumvention
 * filter -- if that ever stops being true, it needs to.
 */
export const SOCIAL_LINKS = [
  { name: 'Instagram', url: 'https://www.instagram.com/joinonlyone/' },
  { name: 'Facebook', url: 'https://www.facebook.com/joinonlyone/' },
];

export const CONTACT_EMAIL = 'team@onlyone1.fun';
export const CANONICAL_ORIGIN = 'https://www.joinonlyone.com';

/**
 * Brand art for social cards and structured data.
 *
 * These are the ONLY images allowed in a link preview. The rule they exist
 * to enforce: the only other imagery in this project is creator content,
 * and an auto-expanded thumbnail of that in someone's timeline, Slack or
 * group chat is exactly what must never happen on an 18+ platform. If a
 * card ever needs a different image, it has to be drawn brand art too.
 *
 * Absolute URLs, not paths -- every scraper (Facebook, X, iMessage, Slack)
 * fetches og:image out of band with no page context to resolve a relative
 * one against, so a bare `/images/...` silently yields no card at all.
 */
export const OG_IMAGE = `${CANONICAL_ORIGIN}/images/og-onlyone.png`;
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_ALT = 'OnlyOne — exclusive content, real connections.';
export const LOGO_IMAGE = `${CANONICAL_ORIGIN}/images/logo-onlyone.png`;

/**
 * Organization structured data for the public landing page.
 *
 * `sameAs` is the part that earns its place: it is how a search engine ties
 * these social profiles to this domain as one entity rather than three
 * unrelated things, which is the cheapest real SEO available to a site with
 * no inbound links yet.
 *
 * `logo` was deliberately absent until real brand art existed at a stable
 * URL -- a schema field pointing at nothing is worse than an absent one.
 * The founder supplied the lockup on 2026-09-20, so it points at that.
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
    logo: LOGO_IMAGE,
    image: OG_IMAGE,
    sameAs: SOCIAL_LINKS.map((s) => s.url),
  };
}
