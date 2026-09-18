import crypto from 'crypto';
import { findUserById } from './users-store';

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

// Compare the presented signature against the expected one in constant
// time. A plain `!==` bails at the first differing byte, so how long the
// comparison takes depends on how much of a forged signature is correct --
// enough, in principle, to let someone hill-climb a valid signature one
// byte at a time. timingSafeEqual needs equal-length buffers; an unequal
// length is a definite mismatch and leaks nothing (our signatures are
// always the same length).
function signatureMatches(payload, sig) {
  const expected = Buffer.from(sign(payload), 'utf8');
  const actual = Buffer.from(String(sig || ''), 'utf8');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// `sessionVersion` is the user record's current session epoch (see
// bumpSessionVersion in lib/users-store.js) and rides along as `sv`, so a
// logout that bumps it can retire every token minted before it.
export function createSessionToken(userId, sessionVersion = 0) {
  const payload = Buffer.from(JSON.stringify({ typ: 'session', uid: userId, sv: Number(sessionVersion) || 0, exp: Date.now() + MAX_AGE_SECONDS * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

// Everything that can be checked without touching storage: signature, token
// type, expiry. Returns the decoded payload, or null.
function readSessionToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!signatureMatches(payload, sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.typ !== 'session') return null;
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function verifySessionToken(token) {
  const data = readSessionToken(token);
  return data ? data.uid : null;
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

/**
 * The token's own claims -- who it says it is, and which session epoch it
 * was minted under -- with signature, type and expiry checked but no
 * storage read. Logout needs the epoch to prove the token it is acting on
 * is the account's current one and not a replay of a retired copy.
 */
export function getSessionClaims(req) {
  const data = readSessionToken(parseCookies(req)[COOKIE_NAME]);
  return data ? { uid: data.uid, sv: Number(data.sv || 0) } : null;
}

/**
 * Revocation-aware session lookup -- returns the full user record, or null.
 *
 * getSessionUserId() above is purely stateless: it proves we signed the
 * token and that it hasn't expired, and says nothing about whether the
 * session was logged out. A token copied off someone's machine therefore
 * keeps working for the rest of its 30 days no matter how many times they
 * log out. This additionally checks the token's `sv` against the session
 * version currently on the user record, which POST /api/auth/logout bumps.
 *
 * READ THIS BEFORE ASSUMING LOGOUT REVOKES ANYTHING. Checking `sv` costs a
 * storage read, so this is async, while getSessionUserId() is called
 * synchronously (`const uid = getSessionUserId(req)`, no await) from every
 * other authenticated surface on the site. Those surfaces are all still on
 * the stateless check, which means a copied token still authorizes them
 * after a logout. As of now only pages/api/auth/me.js and
 * pages/api/auth/logout.js consult the session epoch at all, so logout is
 * NOT yet an effective revocation for:
 *
 *   lib/require-creator-owner.js (gates every creator-content-mutating
 *   endpoint), pages/dashboard.js, pages/creator/[id].js, pages/favorites.js,
 *   pages/onlyass.js, pages/api/messages/{send,conversations,with/[userId]}.js,
 *   pages/api/wall/{post,delete,report}.js, pages/api/favorites/toggle.js,
 *   pages/api/marketplace/report.js, pages/api/marketplace/orders/{mine,create}.js
 *
 * Migrating them is mechanical -- each one is already inside an async
 * function, so it is `const user = await getSessionUser(req)` and then
 * `user?.id` where it read `uid` -- but it has to be done in those files,
 * and it must be done in ONE change: swapping getSessionUserId's own body
 * to the async version instead would return a Promise to fifteen callers
 * that never await it, and a Promise is truthy, so every `if (!uid)` guard
 * on the site would silently start passing. Do not do that.
 */
export async function getSessionUser(req) {
  const data = readSessionToken(parseCookies(req)[COOKIE_NAME]);
  if (!data) return null;
  const user = await findUserById(data.uid);
  if (!user) return null;
  // Tokens minted before session versioning existed carry no `sv`, and user
  // records from before it carry no `sessionVersion` -- both read as 0, so
  // sessions that predate this stay valid instead of everyone getting
  // signed out by the deploy.
  if (Number(user.sessionVersion || 0) !== Number(data.sv || 0)) return null;
  return user;
}
