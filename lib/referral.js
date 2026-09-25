/**
 * Creator referral attribution.
 *
 * A creator shares joinonlyone.com/?ref=theirhandle (or whichever mirror
 * domain they're on -- the link is built from window.location.origin, never
 * hardcoded). Whoever arrives that way
 * has the handle stashed in a cookie, and if they sign up -- then, or days
 * later, from any page -- the new account records who sent them.
 *
 * A cookie rather than only reading the query string at signup, because
 * almost nobody lands on the referral link and immediately creates an
 * account. They land, they look around, they come back. Attribution that
 * only survives one page view mostly doesn't attribute anything.
 *
 * Deliberately a plain readable cookie, not a signed one: the worst a
 * forged value does is credit the wrong creator with a referral, and the
 * server resolves it against a real handle before storing anything. Worth
 * revisiting if referrals ever pay out real money, at which point someone
 * self-crediting becomes worth stopping.
 */

export const REFERRAL_COOKIE = 'oa_ref';
const MAX_AGE_DAYS = 30;

/**
 * Handles are '@name'; accept either form and store the bare one. Drops every
 * '@' (and anything else a handle cannot contain) -- the same comparison form
 * as handleKey() in lib/field-validation.js and the
 * creators_handle_norm_unique_idx index, so a code resolves to at most one
 * creator.
 */
export function normalizeReferralCode(value) {
  // Anything outside the handle alphabet (lib/field-validation.js
  // HANDLE_BODY_RE) is dropped BEFORE the length cap. Slicing first cut in
  // UTF-16 code units, so an emoji straddling character 40 left a lone
  // surrogate -- and encodeURIComponent throws on one, from inside _app's
  // useEffect, which crashed every page for anyone who opened a crafted
  // ?ref= link. No real handle contains anything this removes.
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 40);
}

export function readReferralCookie() {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(new RegExp(`(?:^|; )${REFERRAL_COOKIE}=([^;]*)`));
  if (!match) return '';
  // A malformed cookie (set by anything, e.g. a stray "%E0%A4%A") is ignored,
  // never thrown: this runs on every page load.
  try {
    return normalizeReferralCode(decodeURIComponent(match[1]));
  } catch {
    return '';
  }
}

/**
 * Stores a referral code, first one wins.
 *
 * First-touch rather than last-touch: if someone arrives through creator A
 * and later clicks creator B's link, A did the work of getting them here.
 * Last-touch would also let a creator overwrite everyone else's referrals
 * by getting their link in front of people who are already on the site.
 */
export function captureReferralFromQuery(query) {
  if (typeof document === 'undefined') return;
  // Never throws: this runs from _app on every page, and an exception here
  // replaces the whole site with Next's client-side error screen.
  try {
    const code = normalizeReferralCode(Array.isArray(query?.ref) ? query.ref[0] : query?.ref);
    if (!code) return;
    if (readReferralCookie()) return;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${REFERRAL_COOKIE}=${encodeURIComponent(code)}; Path=/; Max-Age=${MAX_AGE_DAYS * 24 * 60 * 60}; SameSite=Lax${secure}`;
  } catch {
    // a bad value is simply not a referral
  }
}
