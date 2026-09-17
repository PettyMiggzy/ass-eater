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

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createAgeVerificationToken(secret, meta = {}) {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ v: 1, exp: Date.now() + MAX_AGE_SECONDS * 1000, ...meta })));
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
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function ageVerificationSecret() {
  return process.env.SESSION_SECRET || process.env.ADMIN_UPLOAD_KEY || 'only-ass-dev-secret';
}
