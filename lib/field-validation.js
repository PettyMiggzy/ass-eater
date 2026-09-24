import { isAddress } from 'viem';

/**
 * Type and length checks for text fields that arrive straight off a request
 * body and end up stored in jsonb and rendered server-side.
 *
 * The reason this exists as its own module rather than a check per route:
 * a non-string that reaches the store is not a cosmetic bug. Several public
 * pages call `.toLowerCase()` on a creator's name and a listing's title
 * inside `getServerSideProps` -- optional chaining does not save a `{}` --
 * so one bad write from one signed-in account 500s `/search` and the
 * marketplace for every visitor on the site. `detectPaymentCircumvention`
 * cannot catch it either: it does `String(text || '')`, which turns an
 * object into the harmless-looking `"[object Object]"`.
 */

export const FIELD_LIMITS = {
  name: 80,
  handle: 40,
  bio: 1000,
  price: 40,
  payoutMethod: 24,
  walletAddress: 120,
  img: 1000,
  title: 140,
  description: 4000,
  location: 80,
};

/**
 * Checks every key of `fields` that has a limit defined and is present.
 * Returns an error string, or null when everything is acceptable.
 * Keys with no limit (booleans, numbers, already-sanitised structures) are
 * left alone -- this is deliberately not a whole-body schema.
 */
export function validateTextFields(fields, keys) {
  for (const key of keys) {
    if (!fields || !(key in fields)) continue;
    const value = fields[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string') {
      return `${key} must be text`;
    }
    const max = FIELD_LIMITS[key];
    if (max && value.length > max) {
      return `${key} must be ${max} characters or fewer`;
    }
  }
  return null;
}

/**
 * Creator handles have ONE canonical stored form: "@" + a body of letters,
 * digits, ".", "_" or "-", 2 to 30 characters.
 *
 * Before this, signup stored "@alice" while the two profile editors stored
 * whatever was typed, so "alice" and "@alice" were different rows to the
 * unique index and both matched ?ref=alice -- referral credit went to
 * whichever creator sorted first, and two public profiles could show the same
 * handle. The index is now on the stripped, lowercased body
 * (creators_handle_norm_unique_idx in lib/db.js) and every write path
 * normalises through here, so the two agree.
 *
 * Returns `{ handle }` or `{ error }`. Leading "@"s are stripped however many
 * there are; surrounding whitespace is ignored. `allowBlank` is for the admin
 * paths only, where "no handle yet" is a real state for a pending model.
 */
export const HANDLE_BODY_RE = /^[A-Za-z0-9._-]{2,30}$/;

export function normalizeHandle(input, { allowBlank = false } = {}) {
  if (typeof input !== 'string') return { error: 'handle must be text' };
  const body = input.trim().replace(/^@+/, '');
  if (!body) {
    return allowBlank ? { handle: '' } : { error: 'A handle is required.' };
  }
  if (!HANDLE_BODY_RE.test(body)) {
    return { error: 'Handles are 2-30 characters: letters, numbers, ".", "_" or "-".' };
  }
  return { handle: `@${body}` };
}

/** The comparison form: what the unique index and referral lookup compare. */
export function handleKey(handle) {
  return String(handle || '').trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Where a creator's avatar is allowed to point.
 *
 * An avatar is rendered as <img src> for every visitor on Explore, search,
 * favorites, the marketplace and the profile. Letting it be an arbitrary URL
 * turned every page view into a request to a server the creator controls --
 * the IP and user agent of every fan browsing an adult platform, logged by a
 * third party -- and skipped the upload type allowlist and every moderation
 * and takedown tool, which only see files in our own store.
 *
 * So only two shapes are accepted:
 *   - an uploaded avatar served through our own media route, under THIS
 *     creator's own folder: /api/media/avatars/<creatorId>/<file>
 *   - a local image shipped with the site: /images/<file> (placeholders and
 *     the seed roster's photos)
 * `creatorId` null (a creator that doesn't exist yet) allows only the second.
 */
const LOCAL_IMAGE_RE = /^\/images\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const MEDIA_FILE_RE = /^[A-Za-z0-9._-]+$/;

export function isAllowedAvatarSrc(src, creatorId = null) {
  if (typeof src !== 'string' || !src || src.includes('..')) return false;
  if (LOCAL_IMAGE_RE.test(src)) return true;
  if (creatorId === null || creatorId === undefined) return false;
  const prefix = `/api/media/avatars/${encodeURIComponent(String(creatorId))}/`;
  return src.startsWith(prefix) && MEDIA_FILE_RE.test(src.slice(prefix.length));
}

/**
 * What a fan pays to message this creator, in credits (cents). null means
 * "the platform floor" (99). Anything else must be a whole number of cents
 * from 99 to 50000 -- the upper cap is there because a fat-fingered extra
 * zero here is charged to a fan who never saw it coming.
 */
export const DM_PRICE_MIN_CENTS = 99;
export const DM_PRICE_MAX_CENTS = 50000;

export function sanitizeDmPriceCents(input) {
  if (input === null || input === undefined || input === '') return { value: null };
  const n = typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < DM_PRICE_MIN_CENTS || n > DM_PRICE_MAX_CENTS) {
    return { error: `Message price must be a whole number of cents from ${DM_PRICE_MIN_CENTS} to ${DM_PRICE_MAX_CENTS}, or blank for the default.` };
  }
  return { value: n };
}

/**
 * A fan who signs up with a plain username instead of an email is shown by
 * that username on wall comments and DMs (lib/users-store.js displayNameFor),
 * so it is public text and is capped like one. An email-shaped identifier is
 * never shown, and just gets a sane upper bound.
 */
export const USERNAME_MAX = 40;
export const EMAIL_IDENTIFIER_MAX = 200;
export const USERNAME_RE = /^[A-Za-z0-9._-]{3,40}$/;

export function isEmailIdentifier(identifier) {
  return String(identifier || '').includes('@');
}

/**
 * Payout details on a creator record. Only USDG is paid out (ETH was removed
 * everywhere), so `payoutMethod` is always stored as 'usdg' whatever is
 * posted -- an old panel still offering ETH can't write a method nothing
 * will ever honour. The wallet must be blank or a real EVM address; a typo'd
 * address is money sent nowhere, and it is far cheaper to refuse it here
 * than to find out after a payout.
 *
 * Mutates and returns an error string or null.
 */
export function sanitizePayoutFields(safeFields) {
  if ('payoutMethod' in safeFields) safeFields.payoutMethod = 'usdg';
  if ('walletAddress' in safeFields) {
    const wallet = String(safeFields.walletAddress ?? '').trim();
    if (wallet && !isAddress(wallet, { strict: false })) {
      return 'Payout wallet must be a valid wallet address (0x followed by 40 hex characters).';
    }
    safeFields.walletAddress = wallet;
  }
  return null;
}
