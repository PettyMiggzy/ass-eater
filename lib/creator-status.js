/**
 * Pure creator status / visibility / sanitisation helpers.
 *
 * Deliberately in their own module with NO database import. These are used
 * by client-rendered pages as well as server code (pages/admin/index.js
 * renders a creator's effective status in the browser), and importing them
 * from lib/creators-store.js would drag the Postgres driver into the client
 * bundle -- which fails the build outright, because `pg` needs node's net/tls/dns.
 *
 * lib/creators-store.js re-exports everything here, so server-side callers
 * can keep importing from the store and nothing had to change at those call
 * sites. Client code must import from THIS file.
 */

import { isTokenGated } from './token-gate';

// Fields that must never reach a public page's props/HTML: payout details, a
// pending applicant's private contact email, and moderation history. Once a
// 30-day suspension lifts itself the record still carries
// contentViolationCount, the stored status 'suspended' and suspendedUntil --
// publishing those told anyone viewing page source that this creator had been
// sanctioned for a confirmed NCII/AI-labelling violation. Anything returned
// from getCreators() is a raw internal record; every public-facing page/API
// must pass creators through toPublicCreator before sending them to the client.
const PRIVATE_CREATOR_FIELDS = [
  'walletAddress',
  'payoutMethod',
  'contactEmail',
  'contentViolationCount',
  'suspendedUntil',
  'mockTest',
];

/**
 * The public projection of a creator record.
 *
 * - Private and moderation fields are removed (see above), and `status` is
 *   replaced by the EFFECTIVE status, so a lapsed suspension reads 'active'
 *   rather than leaking the stored 'suspended'.
 * - A token-gated creator's gallery keeps only what the page needs to draw
 *   locked tiles (count, type, AI label) -- never a src. The hero video goes
 *   too. The avatar stays: it is the card on every browse page.
 *   `viewerMayUnlock` lets a server caller that has ALREADY verified the viewer
 *   holds enough (lib/holder-access.js) or owns the page keep the srcs.
 * - The platform's own seed/demo creators are AI-generated imagery, so every
 *   one of their gallery items is labelled aiGenerated regardless of what the
 *   stored row says (Terms section 7 requires the label; the platform must not
 *   be the one account exempt from it).
 */
export function toPublicCreator(creator, { viewerMayUnlock = false } = {}) {
  if (!creator) return creator;
  const pub = { ...creator };
  for (const key of PRIVATE_CREATOR_FIELDS) delete pub[key];
  pub.status = effectiveCreatorStatus(creator) ?? null;
  const gallery = Array.isArray(creator.gallery) ? creator.gallery : [];
  const seed = creator.seed === true;
  const gated = isTokenGated(creator);
  pub.gallery = gallery
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const aiGenerated = seed || !!item.aiGenerated;
      if (gated && !viewerMayUnlock) {
        return { type: item.type === 'video' ? 'video' : 'image', aiGenerated, locked: true };
      }
      return { ...item, aiGenerated };
    });
  if (gated && !viewerMayUnlock) pub.video = null;
  return pub;
}

/**
 * Listing limits shared by the create/update routes and the UI.
 * The price ceiling exists because one absurd price used to set the whole
 * range of the marketplace's MAX PRICE slider for every visitor.
 */
export const LISTING_LIMITS = {
  minPriceCents: 100,
  maxPriceCents: 1_000_000, // $10,000
  maxShippingCents: 100_000, // $1,000
  maxMedia: 10,
  maxPreviewBytes: 16 * 1024,
};

const PREVIEW_RE = /^data:image\/(jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * A listing's public preview is a tiny, heavily blurred JPEG/WebP the
 * creator's browser renders at upload time. It is the ONLY image of a
 * listing's media a non-buyer ever receives. Validated strictly so it cannot
 * be used to smuggle anything else (another URL, SVG, a full-size image).
 */
export function isValidListingPreview(value) {
  return typeof value === 'string' && value.length <= LISTING_LIMITS.maxPreviewBytes && PREVIEW_RE.test(value);
}

// Internal bookkeeping on a listing record that no public payload needs.
const PRIVATE_LISTING_FIELDS = ['moderationRemoved', 'mediaDeletedAt'];

/**
 * The public projection of a listing: everything the marketplace card needs,
 * and NEVER a media src. Paid media used to ship in page props and a public
 * JSON API with only a CSS blur over it. Each media item becomes
 * { type, preview, aiGenerated } where preview is the creator-supplied blurred
 * data URL (or null). Buyers get the real files through
 * /api/marketplace/orders/delivery, which the media route authorizes by order.
 *
 * Pure -- safe to import from React components.
 */
export function toPublicListing(listing) {
  if (!listing) return listing;
  const pub = { ...listing };
  for (const key of PRIVATE_LISTING_FIELDS) delete pub[key];
  const media = Array.isArray(listing.media) ? listing.media : [];
  pub.media = media
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      type: m.type === 'video' ? 'video' : 'image',
      preview: isValidListingPreview(m.preview) ? m.preview : null,
      aiGenerated: !!(m.aiGenerated || listing.aiGenerated),
    }));
  pub.mediaCount = pub.media.length;
  return pub;
}

// A suspension lifts itself once suspendedUntil passes -- there's no cron
// job un-suspending anyone, every check just compares against the clock.
// Use this (not creator.status directly) anywhere enforcement or public
// visibility depends on whether a creator is currently in good standing.
export function effectiveCreatorStatus(creator) {
  if (!creator) return creator?.status;
  if (creator.status === 'suspended' && creator.suspendedUntil && new Date(creator.suspendedUntil) <= new Date()) {
    return 'active';
  }
  return creator.status;
}

export function isPubliclyVisible(creator) {
  const status = effectiveCreatorStatus(creator);
  return status !== 'pending' && status !== 'suspended' && status !== 'banned';
}

const SOCIAL_HANDLE_KEYS = ['twitter', 'instagram', 'tiktok', 'reddit'];

// Plain links only -- no OAuth/API integration with any social platform.
// Handles are stored bare (no @, no full URL) and the display URL is built
// from a fixed, trusted base on our side, so a creator pasting a full URL
// or a "javascript:" string can never end up as a raw href.
export function sanitizeSocials(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const key of SOCIAL_HANDLE_KEYS) {
    const raw = input[key];
    if (typeof raw !== 'string') continue;
    const handle = raw.trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/^@/, '').replace(/\/+$/, '');
    if (handle) out[key] = handle.slice(0, 50);
  }
  if (typeof input.website === 'string') {
    const site = input.website.trim();
    if (/^https:\/\/[^\s]+$/i.test(site)) out.website = site.slice(0, 200);
  }
  return out;
}

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 24;

/**
 * Accepts either a comma-separated string (what the dashboard's tag input
 * sends) or an array, and normalizes either into a clean, deduped,
 * lowercase array -- so creators can be found by what they're actually
 * about ("cosplay", "gym", "asmr", ...) via /search?tag=.
 */
/**
 * Profile details a creator states about themselves.
 *
 * `age` is NOT decoration. A creator record claiming an age under 18 is
 * refused outright rather than clamped or quietly dropped -- on this platform
 * that claim is the single most consequential thing anyone can type, and a
 * silent correction would leave a profile that says one thing and a record
 * that says another. The caller surfaces the refusal.
 *
 * It is self-reported and is NOT identity verification. Real age/ID checking
 * is AgeChecker on the fan side and KYC (not built) on the creator side --
 * this field must never be mistaken for either.
 *
 * Lives here rather than in creators-store.js because it is pure and is used
 * inside React components -- importing it from the store would pull the
 * Postgres driver into the client bundle and break the build on net/tls/dns.
 */
export const MIN_CREATOR_AGE = 18;
export const MAX_CREATOR_AGE = 99;

export class UnderageProfile extends Error {
  constructor() {
    super('age_below_18');
  }
}

export function sanitizeAge(input) {
  if (input === null || input === undefined) return null;
  // Trim BEFORE the null check: Number(' ') is 0, which is under 18, so a
  // creator who tapped this optional field and left a space behind could not
  // save their profile at all -- the whole save was refused as underage.
  if (typeof input === 'string' && input.trim() === '') return null;
  const age = Math.floor(Number(input));
  if (!Number.isFinite(age)) return null;
  if (age < MIN_CREATOR_AGE) throw new UnderageProfile();
  return Math.min(age, MAX_CREATOR_AGE);
}

export function sanitizeLocation(input) {
  return String(input ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * Tags are shown publicly as #tag chips and sidebar categories, so they are
 * reduced to letters, digits, spaces and hyphens -- '@', '$' and '.' (the
 * pieces of "venmo @jane", "cashapp $jane", "555.123.4567") cannot be stored
 * at all. The routes ALSO run the payment-circumvention filter over the raw
 * input, because a digit run or an app name survives this on its own.
 */
export function sanitizeTags(input) {
  const raw = typeof input === 'string' ? input.split(',') : Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item
      .toLowerCase()
      .replace(/[^\p{L}\p{N} -]+/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TAG_LENGTH)
      .trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
