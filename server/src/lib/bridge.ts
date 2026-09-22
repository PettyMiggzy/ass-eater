import crypto from 'crypto';

/**
 * Verifies short-lived identity assertions minted by the Next.js site
 * (joinonlyone.com) proving "this is a real, currently-logged-in user."
 *
 * BRIDGE_SECRET is its own secret, generated fresh, known only to this one
 * purpose -- deliberately NOT derived from either system's own session/JWT
 * secret. The two stacks are separate deployed systems with separate trust
 * boundaries; sharing a root secret across that boundary would mean a leak
 * of one lets you forge the other's logins, not just bridge assertions.
 *
 * The Next.js site's own lib/session.js documents the sibling mistake this
 * avoids: an earlier bug there let a login-session cookie be replayed as an
 * age-verification cookie because both used the same secret and scheme with
 * no distinguishing field. This bridge is a harder version of that same
 * boundary -- crossing between two whole deployments -- so it gets a wholly
 * separate secret, not just a derived subkey.
 */
const SECRET = process.env.BRIDGE_SECRET;

export type BridgeClaims = {
  typ: 'bridge';
  uid: string;      // the Next.js site's own user id -- opaque here, not a server/ id
  email: string;
  username: string;
  role: 'FAN' | 'CREATOR';
  exp: number;       // ms since epoch; short-lived, this is a one-time exchange token
};

function sign(payloadB64: string): string {
  if (!SECRET) throw new Error('BRIDGE_SECRET is not configured -- cannot accept bridged sessions from the Next.js site.');
  return crypto.createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
}

/** Returns the decoded claims if the token is validly signed, not expired, and the right type -- null otherwise. Never throws on bad input. */
export function verifyBridgeToken(token: unknown): BridgeClaims | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;

  let expected: Buffer;
  try {
    expected = Buffer.from(sign(payloadB64));
  } catch {
    return null; // BRIDGE_SECRET unset -- fail closed, not open
  }
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

  let claims: BridgeClaims;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (claims.typ !== 'bridge') return null;
  if (typeof claims.exp !== 'number' || claims.exp < Date.now()) return null;
  if (typeof claims.uid !== 'string' || typeof claims.email !== 'string' || typeof claims.username !== 'string') return null;
  if (claims.role !== 'FAN' && claims.role !== 'CREATOR') return null;
  return claims;
}
