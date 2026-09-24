// Signed "this visitor passed real age verification" cookie. Written using
// the Web Crypto API (not Node's crypto module) so the exact same code runs
// both in API routes (Node) and proxy.js (Edge runtime), which can't use
// Node's crypto -- see MEMORY.md for why this exists (state age-verification
// laws) and lib/session.js for the sibling pattern this mirrors.

export const AGE_VERIFIED_COOKIE_NAME = 'oa_age_verified';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 6 months

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

// Derives a purpose-bound key from the shared root secret instead of using
// it directly -- deliberately NOT the same key lib/session.js derives from
// the same root secret. Without this, an age-verification token and a
// login-session token were byte-for-byte interchangeable (same secret,
// same HMAC scheme, both payloads just needed an `exp` field): copying an
// ordinary login cookie into the age-verification cookie slot was accepted
// as proof of real age verification, defeating the state-law geoblock
// entirely. The `typ` check below is a second, independent layer of the
// same fix.
async function hmacKey(secret) {
  const rootKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', rootKey, new TextEncoder().encode('oa:age-verification:v1'));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createAgeVerificationToken(secret, meta = {}, { maxAgeSeconds = MAX_AGE_SECONDS } = {}) {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ typ: 'age_verified', exp: Date.now() + maxAgeSeconds * 1000, ...meta })));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${toBase64Url(sig)}`;
}

// ---------------------------------------------------------------------------
// BYPASS COOKIES ARE REVOCABLE
// ---------------------------------------------------------------------------
// The owner key, the reviewer key and the owner wallet each mint an ordinary
// age-verification cookie that skips AgeChecker. Before this, such a cookie
// was only an HMAC over {typ, exp, via}: rotating or deleting the credential
// that minted it stopped NEW cookies and left every issued one -- and every
// copy of it -- valid for six months. An owner key has been published before,
// so "rotate it" has to actually end access, not just stop new uses.
//
// Each bypass token now carries `kf`, a fingerprint of the credential that
// minted it, and verification recomputes it from the CURRENT env value. Unset
// or change the env var and every cookie it minted stops passing on the very
// next request. A bypass token with no `kf` (minted before this change) fails
// too, deliberately: those are exactly the cookies nobody could revoke.
//
// Keyed with the age-verification HMAC key, never a bare SHA-256 of the
// credential: the token payload is readable base64, and a plain hash of a
// short, memorable key is crackable offline in seconds. An HMAC under the
// server secret gives whoever holds the cookie nothing to brute-force.
//
// Web Crypto only, and env read at call time -- this runs in proxy.js on the
// Edge runtime.
export const BYPASS_SOURCES = {
  owner: 'OWNER_ACCESS_KEY',
  reviewer: 'REVIEWER_ACCESS_KEY',
  'owner-wallet': 'OWNER_WALLET_ADDRESS',
};

export const AGE_VERIFIED_MAX_AGE_SECONDS = MAX_AGE_SECONDS;
// A reviewer is a third party looking at a merchant application for days, not
// months. Six months of a bypass in a stranger's browser after the review is
// over was never the intent.
export const REVIEWER_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

export function bypassMaxAgeSeconds(via) {
  return via === 'reviewer' ? REVIEWER_MAX_AGE_SECONDS : MAX_AGE_SECONDS;
}

// Static `process.env.NAME` references on purpose, not process.env[name]:
// the Edge bundler records which variables edge code reads by scanning for
// literal references, and a computed lookup can come back undefined there --
// which here would silently revoke every bypass cookie.
function bypassEnvValue(via) {
  if (via === 'owner') return process.env.OWNER_ACCESS_KEY;
  if (via === 'reviewer') return process.env.REVIEWER_ACCESS_KEY;
  if (via === 'owner-wallet') return process.env.OWNER_WALLET_ADDRESS;
  return undefined;
}

function bypassCredential(via) {
  if (!Object.prototype.hasOwnProperty.call(BYPASS_SOURCES, via)) return null;
  const raw = bypassEnvValue(via);
  if (typeof raw !== 'string' || !raw.trim()) return null;
  // Addresses are case-insensitive (EIP-55 checksum casing is cosmetic), so
  // re-saving the same address checksummed must not revoke the owner's cookie.
  return via === 'owner-wallet' ? raw.trim().toLowerCase() : raw;
}

async function bypassFingerprint(secret, via, credential) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`oa:bypass-kf:v1:${via}:${credential}`));
  return toBase64Url(sig).slice(0, 22);
}

/**
 * Mint a bypass cookie value for `via` ('owner' | 'reviewer' |
 * 'owner-wallet'), bound to the credential currently configured for it.
 * Throws if that credential is unset -- every calling route 404s before this
 * in that case, so reaching here without one is a bug, not a request.
 */
export async function createBypassAgeVerificationToken(secret, via) {
  const credential = bypassCredential(via);
  if (!credential) throw new Error(`No bypass credential configured for "${via}"`);
  const kf = await bypassFingerprint(secret, via, credential);
  return createAgeVerificationToken(secret, { via, kf }, { maxAgeSeconds: bypassMaxAgeSeconds(via) });
}

export async function verifyAgeVerificationToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, fromBase64Url(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (!data || data.typ !== 'age_verified') return null;
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    if (data.via !== undefined) {
      // Any `via` is a bypass. An unknown one is refused rather than waved
      // through: a door this code does not know how to revoke is not a door.
      if (typeof data.via !== 'string' || !Object.prototype.hasOwnProperty.call(BYPASS_SOURCES, data.via)) return null;
      const credential = bypassCredential(data.via);
      if (!credential || typeof data.kf !== 'string') return null;
      if ((await bypassFingerprint(secret, data.via, credential)) !== data.kf) return null;
    }
    return data;
  } catch {
    return null;
  }
}

// See lib/session.js for why the hardcoded fallback is production-only
// disallowed -- same reasoning applies here.
export function ageVerificationSecret() {
  const secret =
    process.env.SESSION_SECRET ||
    process.env.ADMIN_UPLOAD_KEY ||
    (process.env.NODE_ENV === 'production' ? null : 'onlyone-dev-secret');
  if (!secret) {
    throw new Error('SESSION_SECRET (or ADMIN_UPLOAD_KEY) must be set in production -- refusing to sign age-verification tokens with no real secret.');
  }
  return secret;
}
