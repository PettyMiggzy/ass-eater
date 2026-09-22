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

/**
 * user: the record getSessionUser() returns (lib/session.js) -- role is
 * 'fan' | 'creator' here, mapped to the API's 'FAN' | 'CREATOR' below.
 */
export function mintBridgeToken(user) {
  const payload = {
    typ: 'bridge',
    uid: String(user.id),
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
