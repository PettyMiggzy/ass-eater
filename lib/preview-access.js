// Pre-launch preview gate: a signed "this visitor has the invite link"
// cookie. Same Web Crypto construction as lib/age-verification.js so the
// identical code runs in both API routes (Node) and proxy.js (Edge).
//
// WHAT THIS IS AND IS NOT. It hides an unfinished product from the public
// until launch. It is NOT a security boundary and NOT a content control:
// an invite link gets you to the real site, it does NOT get you past the
// 27-state age verification, which is a legal requirement and runs
// independently in proxy.js. Holding a preview cookie and holding an
// age-verification cookie are two separate facts and both are checked.
//
// Turn the whole thing off at launch by deleting PREVIEW_ACCESS_KEY from
// the environment. One variable, so the switch and the key can never
// disagree about whether preview mode is on.

export const PREVIEW_COOKIE_NAME = 'oa_preview';
export const PREVIEW_QUERY_PARAM = 'preview';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days
export const PREVIEW_COOKIE_MAX_AGE = MAX_AGE_SECONDS;

function toBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Purpose-bound, like the other two token types. Three tokens now sign off
// the same root secret -- login session, age verification, and this -- and
// the whole reason each derives its own key from its own context string is
// the bug already fixed once here: two token types sharing a key and a
// scheme were byte-for-byte interchangeable, so an ordinary login cookie
// pasted into the age-verification slot was accepted as proof of
// verification. A preview cookie must never be able to become an
// age-verification cookie by being moved between slots. The `typ` check in
// verify() is the second, independent layer of the same guard.
async function hmacKey(secret) {
  const rootKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', rootKey, new TextEncoder().encode('oa:preview:v1'));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Revocable, like the owner/reviewer bypass cookies (lib/age-verification.js):
// every invite cookie carries `kf`, a keyed fingerprint of the
// PREVIEW_ACCESS_KEY that minted it, and verification recomputes it against
// the key configured NOW. Rotating the key therefore ends every invite issued
// under the old one on the next request -- before this, a forwarded invite
// kept working for its full 90 days whatever the owner changed, and the only
// way to cut it off was rotating SESSION_SECRET and logging everyone out.
// Keyed off the preview-derived key, so the cookie never carries anything a
// guesser could test a candidate key against offline without the secret.
async function previewKeyFingerprint(secret, previewKey) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`oa:preview-kf:v1:${previewKey}`));
  return toBase64Url(sig).slice(0, 22);
}

export async function createPreviewToken(secret) {
  const previewKey = previewAccessKey();
  if (!previewKey) throw new Error('PREVIEW_ACCESS_KEY is not set -- there is no preview gate to issue an invite for.');
  const kf = await previewKeyFingerprint(secret, previewKey);
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ typ: 'preview_access', kf, exp: Date.now() + MAX_AGE_SECONDS * 1000 })));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${toBase64Url(sig)}`;
}

export async function verifyPreviewToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, fromBase64Url(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (!data || data.typ !== 'preview_access') return null;
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    // Bound to the key configured now. A cookie with no `kf` (minted before
    // this change) or one minted under a rotated key is refused.
    const previewKey = previewAccessKey();
    if (!previewKey || typeof data.kf !== 'string') return null;
    if ((await previewKeyFingerprint(secret, previewKey)) !== data.kf) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Compare the key from the link against the configured one over SHA-256
 * digests, so the loop always runs the same fixed length and cannot exit
 * early on the first wrong character. Mirrors lib/admin-auth.js.
 */
export async function previewKeyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function previewAccessKey() {
  return process.env.PREVIEW_ACCESS_KEY || '';
}

/**
 * Preview mode is on exactly when a key is configured. Launching is
 * therefore "delete PREVIEW_ACCESS_KEY and redeploy" -- no second flag to
 * forget, and no state where a key exists but the gate is off.
 *
 * Note which way this fails: with no key the site is fully public. That is
 * the right direction for THIS gate, because it only hides an unfinished
 * product -- the age verification that actually has to hold is a separate
 * check with its own secret, and it is unaffected by anything here.
 */
export function previewModeEnabled() {
  return !!previewAccessKey();
}

// proxy.js and lib/age-verification.js already agree on this root secret;
// reusing it keeps one secret to manage rather than three. The per-purpose
// derivation above is what keeps the three token types apart.
export function previewSecret() {
  const secret =
    process.env.SESSION_SECRET ||
    process.env.ADMIN_UPLOAD_KEY ||
    (process.env.NODE_ENV === 'production' ? null : 'onlyone-dev-secret');
  if (!secret) {
    throw new Error('SESSION_SECRET (or ADMIN_UPLOAD_KEY) must be set in production -- refusing to sign preview tokens with no real secret.');
  }
  return secret;
}
