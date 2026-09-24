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
 * Handles are '@name'; accept either form and store the bare one. Strips
 * every leading '@' -- the same comparison form as handleKey() in
 * lib/field-validation.js and the creators_handle_norm_unique_idx index, so
 * a code resolves to at most one creator.
 */
export function normalizeReferralCode(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .slice(0, 40)
    .toLowerCase();
}

export function readReferralCookie() {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(new RegExp(`(?:^|; )${REFERRAL_COOKIE}=([^;]*)`));
  return match ? normalizeReferralCode(decodeURIComponent(match[1])) : '';
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
  const code = normalizeReferralCode(query?.ref);
  if (!code) return;
  if (readReferralCookie()) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${REFERRAL_COOKIE}=${encodeURIComponent(code)}; Path=/; Max-Age=${MAX_AGE_DAYS * 24 * 60 * 60}; SameSite=Lax${secure}`;
}
