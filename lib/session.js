import crypto from 'crypto';

// In production, refuse to silently fall back to a hardcoded secret that
// sits in plain sight in this file -- anyone who's read this source could
// forge a valid login (or, before the purpose-derivation below, an
// age-verification bypass) for any account against a deployment that
// somehow has neither env var set (a fork, a misconfigured mirror site,
// a new preview project). A broken deployment that errors loudly is far
// safer than one that silently accepts a public secret. The hardcoded
// fallback only applies outside production, for local dev.
const ROOT_SECRET =
  process.env.SESSION_SECRET ||
  process.env.ADMIN_UPLOAD_KEY ||
  (process.env.NODE_ENV === 'production' ? null : 'only-ass-dev-secret');
if (!ROOT_SECRET) {
  throw new Error('SESSION_SECRET (or ADMIN_UPLOAD_KEY) must be set in production -- refusing to sign sessions with no real secret.');
}
// Derived, purpose-bound key -- deliberately NOT the same key
// lib/age-verification.js derives from this same root secret. Without
// this, a login-session token and an age-verification token were
// byte-for-byte interchangeable (same secret, same HMAC scheme, both
// payloads just needed an `exp` field), so copying an ordinary login
// cookie into the age-verification cookie slot was accepted as proof of
// real age verification. The `typ` check below is a second, independent
// layer of the same fix.
const SECRET = crypto.createHmac('sha256', ROOT_SECRET).update('oa:session:v1').digest();
const COOKIE_NAME = 'oa_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

export function createSessionToken(userId) {
  const payload = Buffer.from(JSON.stringify({ typ: 'session', uid: userId, exp: Date.now() + MAX_AGE_SECONDS * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (sign(payload) !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.typ !== 'session') return null;
    if (data.exp < Date.now()) return null;
    return data.uid;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

export function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secure}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function getSessionUserId(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return verifySessionToken(token);
}
