import { isAddress } from 'viem';
import { normalizeForMatching } from './payment-circumvention-filter.js';
import { isWellFormedText } from './unicode-text.js';

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
  // Matches lib/creator-status.js MAX_LOCATION_LENGTH (what is stored): it
  // used to be 80 here and 60 there, so 61-80 characters were silently cut.
  location: 60,
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
    // Half an emoji (an unpaired surrogate, only ever sent on purpose) cannot
    // be stored as jsonb: refused here instead of failing the write with a 500.
    if (!isWellFormedText(value)) {
      return `${key} contains an invalid character`;
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
  // A handle is printed on every Explore, search and marketplace card, and a
  // bare digit run is the one handle with no reading but a phone number --
  // which the payment filter (rightly) lets through without a "call me" cue.
  if (looksLikePhoneNumber(body)) {
    return { error: PHONE_NAME_MESSAGE };
  }
  return { handle: `@${body}` };
}

/**
 * A public name that is a phone number: digits and the punctuation phone
 * numbers are written with (at least 7 digits), or any name with a run of 10+
 * digits in it. One rule for
 * every place a name is published -- creator handles (normalizeHandle), creator
 * display names and fan usernames (signup, the profile editors) -- so the fan
 * and creator paths can't disagree about what "a phone number" is.
 */
export const PHONE_NAME_MESSAGE = "That can't be a phone number -- names and handles are shown publicly.";
export function looksLikePhoneNumber(value) {
  const s = String(value ?? '').trim().replace(/^@+/, '');
  if (/^[\d.\-_ ()+]{7,}$/.test(s) && (s.match(/\d/g) || []).length >= 7) return true;
  // A phone number INSIDE a name: "text-617-555-1234", "call.6175551234",
  // "jane_617_555_1234". Handles and usernames allow ".", "_", "-" and digits,
  // so a cue word glued on the front walked past the digits-only rule above
  // and got published on every card and comment. Ten or more digits in one
  // run (single separators allowed between them) is a phone number's length;
  // ordinary handles ("jane2000", "mia_1999") carry far fewer.
  for (const run of s.match(/\d(?:[.\-_ ()]?\d)+/g) || []) {
    if ((run.match(/\d/g) || []).length >= 10) return true;
  }
  return false;
}

/**
 * Names the platform itself uses. A creator or fan presenting as "OnlyOne
 * Support" or "@onlyone_team" trades on the platform's authority -- the
 * classic "re-verify by sending USDG to this wallet" DM -- and nothing after
 * approval re-reviews a profile edit. Self-service paths (signup, the
 * creator's own editor) refuse these; the admin editor does not, so a real
 * official account can still be set up by hand.
 *
 * Matched on the same lookalike-folded text as the content filters, plus
 * "0"/"3"/"1" for o/e/l, so "0nly0ne" and "OnIyOne" (capital I for l) are
 * the same name:
 *   - the brand, anywhere, glued or spaced ("onlyone", "Only One Support",
 *     "theonlyone_team", "joinonlyone");
 *   - a staff word as a WHOLE word ("support", "admin", "staff", "official",
 *     "moderator"), never inside another word, so "Supportive Sam",
 *     "badminton" and "janeofficial" stay allowed.
 */
export const RESERVED_NAME_MESSAGE = "That name is reserved -- it reads as OnlyOne's own staff or brand. Pick another.";
const RESERVED_WORDS = new Set([
  'support', 'admin', 'admins', 'administrator', 'staff', 'official', 'officials', 'moderator', 'moderators',
  'helpdesk', 'onlyone', 'joinonlyone',
]);
export function isReservedName(value) {
  const folded = normalizeForMatching(value).replace(/0/g, 'o').replace(/3/g, 'e').replace(/1/g, 'l');
  // The glued brand is looked for inside ONE whitespace-separated token at a
  // time (punctuation inside the token is dropped, so "the_only_one" and
  // "O.n.l.y.O.n.e" still read as the brand). Gluing the whole string first
  // matched across ordinary word breaks: "Don Lyone", "Colonly Onex".
  const tokens = folded.split(/\s+/).map((t) => t.replace(/[^a-z]/g, '')).filter(Boolean);
  if (tokens.some((t) => /on[li][yi]one|onlyl$/.test(t))) return true;
  // The spaced brand: the whole words "only" then "one", next to each other.
  const words = folded.split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i + 1 < words.length; i++) {
    if (/^on[li][yi]$/.test(words[i]) && words[i + 1] === 'one') return true;
  }
  return words.some((w) => RESERVED_WORDS.has(w));
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
// Upper bound on a password, shared by signup and login. bcrypt only reads
// the first 72 bytes anyway; the cap exists so a megabyte "password" is
// refused before it reaches bcrypt or anything else.
export const PASSWORD_MAX = 1024;
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
    if (wallet) {
      const error = payoutWalletError(wallet);
      if (error) return error;
    }
    safeFields.walletAddress = wallet;
  }
  return null;
}

/**
 * Why a payout wallet can't be used, or null when it can. Shared by the two
 * profile editors (via sanitizePayoutFields) and lib/credits-store.js
 * normalizePayoutWallet, so the save and the payout agree.
 *
 * The EIP-55 checksum is the one typo detector an EVM address carries: a
 * MIXED-case address encodes a checksum, and one mistyped hex character makes
 * it fail. The old non-strict check accepted it and getAddress() then wrote a
 * fresh, valid-looking checksum over the typo -- so a USDG payout would go to
 * an address nobody controls. So:
 *   - all-lowercase or all-uppercase hex carries no checksum and is accepted;
 *   - mixed case must pass the checksum, or it is refused;
 *   - the zero address is refused (sending there burns the money).
 */
export const WALLET_FORMAT_MESSAGE = 'Payout wallet must be a valid wallet address (0x followed by 40 hex characters).';
export const WALLET_CHECKSUM_MESSAGE = "That wallet address's checksum doesn't match -- one character is probably mistyped. Re-copy the address from your wallet.";
export function payoutWalletError(wallet) {
  const raw = typeof wallet === 'string' ? wallet.trim() : '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return WALLET_FORMAT_MESSAGE;
  const hex = raw.slice(2);
  if (/^0+$/.test(hex)) return 'Payout wallet cannot be the zero address -- anything sent there is lost.';
  const mixed = /[a-f]/.test(hex) && /[A-F]/.test(hex);
  if (mixed ? !isAddress(raw, { strict: true }) : !isAddress(raw, { strict: false })) {
    return mixed ? WALLET_CHECKSUM_MESSAGE : WALLET_FORMAT_MESSAGE;
  }
  return null;
}
