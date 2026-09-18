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

// Fields that must never reach a public page's props/HTML -- payout details
// and a pending applicant's private contact email. Anything returned from
// getCreators() is a raw internal record; every public-facing page/API must
// pass creators through toPublicCreator before sending them to the client.
const PRIVATE_CREATOR_FIELDS = ['walletAddress', 'payoutMethod', 'contactEmail'];

export function toPublicCreator(creator) {
  if (!creator) return creator;
  const pub = { ...creator };
  for (const key of PRIVATE_CREATOR_FIELDS) delete pub[key];
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
export function sanitizeTags(input) {
  const raw = typeof input === 'string' ? input.split(',') : Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
