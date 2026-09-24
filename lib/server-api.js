import { mintBridgeToken } from './bridge-token';
import { getCreatorById } from './creators-store';
import { effectiveCreatorStatus } from './creator-status';

// Server-only helper for calling the OnlyOne API (server/) on behalf of a
// logged-in user on this site. Deliberately keeps the server/ access token
// entirely server-side -- a Next.js API route calls this, gets back
// whatever DATA the target endpoint returns, and passes that on to the
// browser. The token itself never reaches client JS, avoiding the whole
// cross-domain-cookie/XSS surface a browser-held token would open up.
//
// The exchanged access token is cached per site user, keyed on everything
// that should force a fresh exchange: the session epoch (`sessionVersion`,
// bumped by logout, so a logout retires the cached token too), the role, and
// the creator's effective status (so a ban or suspension reaches the API
// within one call, not after the cached token ages out). Without the cache
// every call minted and exchanged a new token -- all of it from a handful of
// shared Vercel egress IPs, against the API's per-route limit on
// /auth/bridge.
//
// The cache lives in this serverless instance's memory only, so a cold
// start just exchanges again. Entries are reused until CACHE_SLACK_MS before
// the token's own expiry, and never for longer than CACHE_MAX_MS.

const API_BASE = process.env.SERVER_API_URL || 'https://api.joinonlyone.com';
const TIMEOUT_MS = 8_000;              // a hung API must not hold the function to its maxDuration
const CACHE_MAX_MS = 5 * 60 * 1000;
const CACHE_SLACK_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 5_000;

const tokenCache = new Map();          // cacheKey -> { access, expiresAt }

async function creatorStatusFor(user) {
  if (user.role !== 'creator') return null;
  // Fails CLOSED: a creator account with no profile link, or whose profile
  // is gone, has no standing to vouch for and is sent as banned (the API
  // refuses it). A record with no stored status at all is the legacy shape
  // this whole site already treats as active (isPubliclyVisible,
  // admin/profile.js), so it is sent as 'active' to match. Any OTHER value
  // -- a status added later that nobody taught this bridge about -- is
  // mapped to banned by mintBridgeToken rather than passed through as
  // unrestricted.
  if (!user.creatorId) return 'banned';
  const creator = await getCreatorById(user.creatorId);
  if (!creator) return 'banned';
  const status = effectiveCreatorStatus(creator);
  return status == null || status === '' ? 'active' : String(status);
}

function jwtExpiryMs(access) {
  try {
    const payload = JSON.parse(Buffer.from(String(access).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function exchangeBridgeToken(user, creatorStatus) {
  const token = mintBridgeToken(user, creatorStatus);
  const res = await fetch(`${API_BASE}/auth/bridge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`bridge exchange failed (${res.status}): ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json(); // { access }
}

async function accessTokenFor(user) {
  const creatorStatus = await creatorStatusFor(user);
  const key = [user.id, Number(user.sessionVersion || 0), user.role, creatorStatus || '-'].join('|');
  const now = Date.now();
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > now) return { key, access: hit.access };

  const { access } = await exchangeBridgeToken(user, creatorStatus);
  const exp = jwtExpiryMs(access);
  const expiresAt = Math.min(now + CACHE_MAX_MS, exp ? exp - CACHE_SLACK_MS : now);
  if (expiresAt > now) {
    if (tokenCache.size >= CACHE_MAX_ENTRIES) {
      for (const [k, v] of tokenCache) if (v.expiresAt <= now) tokenCache.delete(k);
      if (tokenCache.size >= CACHE_MAX_ENTRIES) tokenCache.delete(tokenCache.keys().next().value);
    }
    tokenCache.set(key, { access, expiresAt });
  }
  return { key, access };
}

/**
 * Calls an authenticated OnlyOne API endpoint as the given user.
 * `user` is the record getSessionUser() (lib/session.js) returns.
 * Returns { status, data } -- callers decide what a non-2xx means for them.
 * Throws on a failed bridge exchange or a network error/timeout; a refused
 * exchange (banned/suspended creator) carries `err.status`.
 */
export async function callServerApi(user, method, path, body) {
  const { key, access } = await accessTokenFor(user);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${access}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // A token the API no longer accepts (its account was suspended there, or
  // its signing key rotated) must not stay cached for the rest of its life.
  if (res.status === 401 || res.status === 403) tokenCache.delete(key);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
