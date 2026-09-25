import { mintBridgeToken } from './bridge-token';
import { getCreatorById } from './creators-store';
import { effectiveCreatorStatus } from './creator-status';
import { findUserByCreatorId, findUserById, latestLapse } from './users-store';
import { effectiveUserStatus } from './user-moderation';
import { enqueueStandingPushes, deliverStandingPushes } from './standing-outbox';

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

// The account's standing as it stands NOW, for an exchange token:
// { creatorStatus (null for a fan), fanStanding (null for a creator),
//   suspendedUntil (ms epoch, or null) }.
async function standingFor(user) {
  if (user.role !== 'creator') {
    const fanStanding = effectiveUserStatus(user);
    const until = fanStanding === 'suspended' ? Date.parse(user.moderationUntil || '') : NaN;
    return { creatorStatus: null, fanStanding, suspendedUntil: Number.isFinite(until) ? until : null };
  }
  // Fails CLOSED: a creator account with no profile link, or whose profile
  // is gone, has no standing to vouch for and is sent as banned (the API
  // refuses it). A record with no stored status at all is the legacy shape
  // this whole site already treats as active (isPubliclyVisible,
  // admin/profile.js), so it is sent as 'active' to match. Any OTHER value
  // -- a status added later that nobody taught this bridge about -- is
  // mapped to banned by mintBridgeToken rather than passed through as
  // unrestricted.
  if (!user.creatorId) return { creatorStatus: 'banned', fanStanding: null, suspendedUntil: null };
  const creator = await getCreatorById(user.creatorId);
  if (!creator) return { creatorStatus: 'banned', fanStanding: null, suspendedUntil: null };
  const creatorStatus = combinedCreatorStanding(creator, user);
  const lapse = creatorStatus === 'suspended' ? suspensionLapse(creator, user) : null;
  const until = lapse ? Date.parse(lapse) : NaN;
  return { creatorStatus, fanStanding: null, suspendedUntil: Number.isFinite(until) ? until : null };
}

// When a creator account's combined suspension ends: the later of the
// profile's and the login's own, among those that are in force.
function suspensionLapse(creator, user) {
  return latestLapse(
    creator && effectiveCreatorStatus(creator) === 'suspended' ? creator.suspendedUntil : null,
    effectiveUserStatus(user) === 'suspended' ? user.moderationUntil : null,
  );
}

// A creator account's standing: its creator record's effective status, made
// stricter by any account-level moderation on the login (an unapproved
// creator account can carry that -- lib/users-store.js setUserModeration).
function combinedCreatorStanding(creator, user) {
  const raw = creator ? effectiveCreatorStatus(creator) : 'banned';
  let status = raw == null || raw === '' ? 'active' : String(raw);
  const account = effectiveUserStatus(user);
  if (account === 'banned') status = 'banned';
  else if (account === 'suspended' && status !== 'banned') status = 'suspended';
  return status;
}

function jwtExpiryMs(access) {
  try {
    const payload = JSON.parse(Buffer.from(String(access).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function exchangeBridgeToken(user, standing, standingAt) {
  // A fan carries its own account standing; the stamp orders it against
  // standing pushes on server/ (lib/standing-outbox.js).
  const token = mintBridgeToken(user, standing.creatorStatus, {
    fanStanding: standing.fanStanding,
    standingAt,
    suspendedUntil: standing.suspendedUntil,
  });
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

async function accessTokenFor(sessionUser) {
  // The stamp is taken BEFORE the standing is read (and the account is
  // re-read after it): server/ ignores a standing older than the last one it
  // applied, so the stamp must never be LATER than the read it vouches for.
  // Stamping at mint time, after reads made earlier in the request (the
  // session's user record, the creator row), let an exchange that read
  // 'active' just before a suspension carry a stamp newer than the
  // suspension's push -- and undo it on server/.
  const standingAt = Date.now();
  const user = (await findUserById(sessionUser.id)) || sessionUser;
  const standing = await standingFor(user);
  const standingKey = standing.creatorStatus || `fan:${standing.fanStanding}`;
  const key = [user.id, Number(user.sessionVersion || 0), user.role, standingKey].join('|');
  const now = Date.now();
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > now) return { key, access: hit.access };

  const { access } = await exchangeBridgeToken(user, standing, standingAt);
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

function forgetCachedTokens(uid) {
  for (const k of tokenCache.keys()) if (k.startsWith(`${uid}|`)) tokenCache.delete(k);
}

/**
 * Tells the API that a creator's standing changed on this site, so a ban or
 * suspension takes effect THERE too (subscriptions stop renewing, payouts
 * freeze, listings come down, a live stream ends) instead of waiting until
 * the creator next bridges -- which a banned creator never does. The status
 * is the creator's EFFECTIVE status (made stricter by any account-level
 * moderation), re-read here, never a value the caller made up; a suspension
 * carries its end date so server/ can lift it when it lapses here.
 *
 * DURABLE: the message is queued in server_standing_pushes
 * (lib/standing-outbox.js) and then delivered; a delivery that fails is
 * retried with backoff by the cron and on later admin requests, and shows in
 * the admin panel until it lands. `client` queues on the caller's
 * transaction instead (the caller then calls deliverStandingPushes after its
 * commit). Call it on EVERY admin save of a creator, not only when the status
 * changed: it is idempotent, and a suspension that lapsed by itself has no
 * other event to carry it.
 *
 * Never throws without a client. Returns { ok, queued, delivered, skipped? }.
 */
export async function pushCreatorStatus(creatorId, { client = null } = {}) {
  try {
    if (!process.env.BRIDGE_SECRET) return { ok: false, skipped: true };
    const runner = client || null;
    const user = runner
      ? await (async () => {
        const { rows } = await runner.query(`select id, data from users where data->>'creatorId' = $1`, [String(creatorId)]);
        return rows.length ? { ...rows[0].data, id: rows[0].id } : null;
      })()
      : await findUserByCreatorId(creatorId);
    if (!user) return { ok: false, skipped: true };
    const creator = runner
      ? await (async () => {
        const { rows } = await runner.query('select id, data from creators where id = $1', [String(creatorId)]);
        return rows.length ? { ...rows[0].data, id: rows[0].id } : null;
      })()
      : await getCreatorById(creatorId);
    const status = combinedCreatorStanding(creator, user);
    await enqueueStandingPushes(
      [{ uid: user.id, status, role: 'CREATOR', suspendedUntil: status === 'suspended' ? suspensionLapse(creator, user) : null }],
      runner,
    );
    if (runner) return { ok: true, queued: true, uid: String(user.id) };
    return await deliverFor([user.id]);
  } catch (err) {
    if (client) throw err;
    console.error('pushCreatorStatus', err?.message || err);
    return { ok: false, error: 'push_failed' };
  }
}

/**
 * The same, for a site user id directly: a creator whose site account no
 * longer exists (deleted, pushed as 'banned'), or a FAN's account standing
 * (role 'FAN': active | suspended | banned). Queued, then delivered; never
 * throws without a client.
 */
export async function pushUserStanding(uid, status, { role = 'CREATOR', suspendedUntil = null, client = null } = {}) {
  try {
    if (!process.env.BRIDGE_SECRET) return { ok: false, skipped: true };
    if (uid === null || uid === undefined || String(uid) === '') return { ok: false, skipped: true };
    await enqueueStandingPushes([{ uid, status, role, suspendedUntil }], client);
    if (client) return { ok: true, queued: true, uid: String(uid) };
    return await deliverFor([uid]);
  } catch (err) {
    if (client) throw err;
    console.error('pushUserStanding', err?.message || err);
    return { ok: false, error: 'push_failed' };
  }
}

/** Delivers the queued pushes for these uids now (after a commit). Never throws. */
export async function deliverFor(uids) {
  const list = (uids || []).map(String).filter(Boolean);
  if (!list.length || !process.env.BRIDGE_SECRET) return { ok: true, skipped: !process.env.BRIDGE_SECRET };
  const out = await deliverStandingPushes({ uids: list, limit: list.length, onDelivered: forgetCachedTokens });
  // Queued is durable: a failed delivery is retried, so it is reported as
  // queued rather than lost.
  return { ok: out.failed === 0, queued: true, delivered: out.sent, failed: out.failed };
}

/** Logs a push that has not been delivered yet (skips are not failures). */
export function reportPushFailure(result, context) {
  if (result && !result.ok && !result.skipped) {
    console.error(
      `[server-api] standing push to server/ not delivered yet (${context}):`,
      result.error || `${result.failed ?? '?'} failed`,
      result.queued ? '-- queued, will retry (see /api/admin/standing-pushes)' : '-- NOT queued',
    );
  }
  return result;
}
