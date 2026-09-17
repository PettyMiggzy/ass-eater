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

export async function createAgeVerificationToken(secret, meta = {}) {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ typ: 'age_verified', exp: Date.now() + MAX_AGE_SECONDS * 1000, ...meta })));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${toBase64Url(sig)}`;
}

export async function verifyAgeVerificationToken(secret, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, fromBase64Url(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (data.typ !== 'age_verified') return null;
    if (data.exp < Date.now()) return null;
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
    (process.env.NODE_ENV === 'production' ? null : 'only-ass-dev-secret');
  if (!secret) {
    throw new Error('SESSION_SECRET (or ADMIN_UPLOAD_KEY) must be set in production -- refusing to sign age-verification tokens with no real secret.');
  }
  return secret;
}
