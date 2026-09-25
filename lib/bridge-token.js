import crypto from 'crypto';

// Mints short-lived signed assertions this site hands to the OnlyOne API
// (server/, api.joinonlyone.com) to prove "this is a real, currently
// logged-in user" -- see server/src/lib/bridge.ts for the matching verifier
// and the reasoning for why this uses its own secret rather than deriving
// from SESSION_SECRET the way lib/age-verification.js and
// lib/preview-access.js derive from it. This crosses into a wholly separate
// deployed system, so it gets a wholly separate secret: a leak of
// BRIDGE_SECRET only lets someone forge bridge exchanges, never a real
// login session on this site.
//
// Server-only. Never import this from a page component or expose the
// minted token to the browser -- API routes exchange it for a server/
// session token themselves (see lib/server-api.js) and only ever return the
// resulting DATA to the client, never the token.

const MAX_AGE_MS = 60 * 1000; // one-shot exchange token, not a session -- short on purpose

function secret() {
  const s = process.env.BRIDGE_SECRET;
  if (!s) throw new Error('BRIDGE_SECRET is not configured -- cannot bridge to the OnlyOne API.');
  return s;
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

const CREATOR_STATUSES = new Set(['active', 'pending', 'suspended', 'banned']);
const FAN_STANDINGS = new Set(['active', 'suspended', 'banned']);

/**
 * user: the record getSessionUser() returns (lib/session.js) -- role is
 * 'fan' | 'creator' here, mapped to the API's 'FAN' | 'CREATOR' below.
 *
 * creatorStatus: the creator's EFFECTIVE status (effectiveCreatorStatus()
 * in lib/creator-status.js), or null for a fan; for a creator anything
 * unrecognised (including null) is sent as 'banned'. The content-violation ladder
 * lives on this site, and the API refuses a banned or suspended creator --
 * without it, a creator banned here was still bridged there as a working
 * CREATOR. lib/server-api.js resolves it; don't pass the raw stored status.
 *
 * The API identifies the account by `uid` ONLY (server/src/lib/bridge.ts
 * resolveBridgedUser). `email` rides along as an attribute and is never a
 * join key -- neither system verifies that anyone owns an address.
 */
export function mintBridgeToken(user, creatorStatus = null, { fanStanding = null, standingAt = Date.now(), suspendedUntil = null } = {}) {
  const isCreator = user.role === 'creator';
  const creatorOut = isCreator ? (CREATOR_STATUSES.has(creatorStatus) ? creatorStatus : 'banned') : null;
  const fanOut = isCreator ? null : (FAN_STANDINGS.has(fanStanding ?? 'active') ? (fanStanding ?? 'active') : 'banned');
  // For a SUSPENDED account (creator or fan) with a known end: when it lapses
  // by itself here (ms epoch), so server/ provisioning this account from the
  // exchange can lift the suspension then -- the same field the standing
  // pushes carry (mintBridgeStatusToken).
  const until = Number(suspendedUntil);
  const lapse = (creatorOut === 'suspended' || fanOut === 'suspended') && Number.isFinite(until) && until > 0 ? until : null;
  const payload = {
    typ: 'bridge',
    uid: String(user.id),
    // Single use: the API records it in Redis and refuses a second exchange.
    jti: crypto.randomUUID(),
    // Fails closed: a creator whose status isn't one the API knows is sent
    // as banned, never as null -- the API refuses a CREATOR with no status.
    creatorStatus: creatorOut,
    // A FAN's own account standing (lib/user-moderation.js effectiveUserStatus),
    // so a fan suspended or banned here is restricted on server/ too. An
    // unknown value fails closed to 'banned'. Absent for creators.
    ...(isCreator ? {} : { standing: fanOut }),
    ...(lapse !== null ? { suspendedUntil: lapse } : {}),
    // When the standing above was read (ms epoch). server/ ignores a standing
    // older than the last one it applied, so a token minted 'active' just
    // before a suspension cannot undo it when it lands afterwards.
    standingAt: Number.isFinite(standingAt) ? standingAt : Date.now(),
    email: String(user.email || ''),
    // A safe, deterministic, always-available username -- server/'s
    // `username` field on this side is an internal/referral-code value,
    // not shown to anyone, so there's no need to resolve a creator's real
    // handle just to populate it.
    username: `u_${String(user.id).replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}`,
    role: user.role === 'creator' ? 'CREATOR' : 'FAN',
    exp: Date.now() + MAX_AGE_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * A one-shot, signed standing push for the API (POST /auth/bridge/status):
 * "the account whose site user id is `uid` now stands at `creatorStatus`"
 * (a creator's effective status, or with role 'FAN' a fan's account
 * standing: active | suspended | banned). Delivered through the durable
 * outbox (lib/standing-outbox.js).
 * Same secret as the exchange token but its own `typ`, so neither can be
 * replayed as the other (server/src/lib/bridge.ts verifyBridgeStatusToken).
 * An unrecognised status is sent as 'banned' -- fails closed, like
 * mintBridgeToken.
 */
export function mintBridgeStatusToken(uid, creatorStatus, { role = null, standingAt = null, suspendedUntil = null } = {}) {
  const fan = role === 'FAN';
  let status = CREATOR_STATUSES.has(creatorStatus) ? creatorStatus : 'banned';
  if (fan && status === 'pending') status = 'banned'; // a fan is never 'pending'; fail closed
  const payload = {
    typ: 'bridge_status',
    uid: String(uid),
    jti: crypto.randomUUID(),
    creatorStatus: status,
    exp: Date.now() + MAX_AGE_MS,
    // Whose standing this is ('FAN' | 'CREATOR'), when the site decided it
    // (ms epoch -- a durably queued push can be delivered much later, and
    // server/ ignores one older than the last it applied), and for a creator
    // suspension the moment it lapses by itself here (ms epoch), so server/
    // can lift it then instead of waiting for another message.
    ...(role === 'FAN' || role === 'CREATOR' ? { role } : {}),
    ...(Number.isFinite(standingAt) ? { standingAt } : {}),
    ...(Number.isFinite(suspendedUntil) && status === 'suspended' ? { suspendedUntil } : {}),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}
