import crypto from 'crypto';
import { findUserById } from './users-store';
import { effectiveUserStatus } from './user-moderation';

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
  (process.env.NODE_ENV === 'production' ? null : 'onlyone-dev-secret');
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
    // decodeURIComponent throws a URIError on a malformed escape ("%E0%A4%A").
    // Unguarded, ONE stray cookie set on this domain by anything -- a pasted
    // value, a subdomain, a third-party script -- 500s every API route and
    // every getServerSideProps for that visitor, with no way out but clearing
    // cookies. The raw value is the right fallback: a malformed cookie is not
    // going to verify as a token anyway.
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
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

/**
 * The signed-in user's id, or null -- revocation-aware.
 *
 * There is deliberately no synchronous variant of this any more. The old
 * getSessionUserId() only proved we had signed the token and that it had
 * not expired, which meant a token copied off someone's machine kept
 * working for its full 30 days no matter how many times they logged out.
 * Every authenticated surface on the site called it, so logout revoked
 * nothing anywhere.
 *
 * It was removed rather than deprecated, so nothing can quietly go on
 * using it. If you are adding an authenticated endpoint, use this or
 * getSessionUser() below -- both consult the account's session epoch, and
 * both are async because doing so needs a storage read.
 */
export async function getVerifiedSessionUserId(req) {
  const user = await getSessionUser(req);
  return user ? user.id : null;
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
 * Checks the token's `sv` claim against the session version currently on
 * the user record, which POST /api/auth/logout bumps. That is what makes
 * logging out actually retire a token rather than merely dropping the
 * cookie from the browser that asked.
 *
 * Use this when you need the user record anyway; use
 * getVerifiedSessionUserId() above when you only need the id. Do NOT add a
 * synchronous shortcut past this check: making the id lookup async is the
 * entire point, and a version that returns a Promise to a caller which
 * does not await it would be worse than useless -- a Promise is truthy, so
 * every `if (!uid)` guard on the site would silently start passing.
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
  // A banned account is signed out everywhere (lib/user-moderation.js). The
  // ban also bumps the epoch; this holds even for a token minted after it.
  if (effectiveUserStatus(user) === 'banned') return null;
  return user;
}
