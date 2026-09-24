import crypto from 'crypto';
import { Prisma, type User } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { PLATFORM_ID, BURNED_ID } from '../core/ledger.js';

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

export type SiteCreatorStatus = 'active' | 'pending' | 'suspended' | 'banned';

export type BridgeClaims = {
  typ: 'bridge';
  uid: string;      // the Next.js site's own user id -- opaque here, not a server/ id. THE join key.
  email: string;    // informational only; never used to find an account
  username: string;
  role: 'FAN' | 'CREATOR';
  // The site creator's effective standing (lib/creator-status.js); always
  // set for CREATOR (verifyBridgeToken rejects one without it), null for fans. The content-violation ladder lives on the site, so without this a
  // creator banned there was still bridged here as a working CREATOR.
  creatorStatus: SiteCreatorStatus | null;
  jti: string;       // single-use id; /auth/bridge burns it in Redis
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
  if (typeof claims.uid !== 'string' || !claims.uid || claims.uid.length > 128) return null;
  if (typeof claims.email !== 'string' || typeof claims.username !== 'string') return null;
  if (claims.role !== 'FAN' && claims.role !== 'CREATOR') return null;
  if (typeof claims.jti !== 'string' || claims.jti.length < 16 || claims.jti.length > 128) return null;
  const cs = claims.creatorStatus ?? null;
  if (cs !== null && !['active', 'pending', 'suspended', 'banned'].includes(cs)) return null;
  // Fail closed: a CREATOR assertion must say where the creator stands. A
  // missing status is not "unrestricted" -- the site sends 'banned' for
  // anything it can't vouch for, so null here means a malformed token.
  if (claims.role === 'CREATOR' && cs === null) return null;
  if (claims.role === 'FAN' && cs !== null) return null;
  claims.creatorStatus = cs;
  return claims;
}

// Accounts no bridge exchange may ever be issued for, whatever the claims
// say. A bridged row is always created by resolveBridgedUser() below with a
// siteUid, which system rows never have, so this is belt and braces -- but
// it is the belt that would have mattered when the join was by email.
const SYSTEM_IDS = new Set([PLATFORM_ID, BURNED_ID]);

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * The address stored on a freshly bridged row. The site's identifier is used
 * only when it is shaped like an email AND no other row already holds it;
 * otherwise a namespaced address on the reserved `.invalid` TLD is used.
 * Either way the email is never how this row is found again -- siteUid is --
 * so a clash here costs nothing but a real notification address, which a
 * creator can set separately (CreatorProfile.notifyEmail).
 */
export function syntheticBridgeEmail(uid: string) {
  return `site-${sha(uid).slice(0, 32)}@bridge.invalid`;
}

export type BridgeResolution =
  | { ok: true; user: User }
  | { ok: false; status: number; error: string };

/**
 * Finds or provisions the server/ account for a verified bridge assertion.
 *
 * Joined ONLY on claims.uid (User.siteUid). It never adopts a row found by
 * email or username: a native /register row, a system account, or another
 * site user's row can share an email string with these claims and none of
 * them is this person. That email join is what let an attacker pre-register
 * a victim's address with their own password and have the victim bridged
 * into it, and what bridged a site fan named 'treasury@internal' into the
 * platform ADMIN account.
 *
 * Role only ever moves FAN -> CREATOR (a site fan who became a creator);
 * nothing here issues ADMIN, and an ADMIN or system row is refused outright.
 */
export async function resolveBridgedUser(claims: BridgeClaims): Promise<BridgeResolution> {
  // Fail closed (verifyBridgeToken already rejects this shape; repeated so
  // no other caller can bridge a creator of unknown standing as unrestricted).
  if (claims.role === 'CREATOR' && !claims.creatorStatus) return { ok: false, status: 403, error: 'banned' };
  if (claims.creatorStatus === 'banned') return { ok: false, status: 403, error: 'banned' };
  if (claims.creatorStatus === 'suspended') return { ok: false, status: 403, error: 'suspended' };

  let user = await prisma.user.findUnique({ where: { siteUid: claims.uid } });
  if (!user) user = await provisionBridgedUser(claims);

  if (claims.role === 'CREATOR' && user.role === 'FAN') {
    // Upgrade in one transaction so a row can never be a CREATOR with no
    // CreatorProfile (every creator route assumes one exists).
    const [updated] = await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { role: 'CREATOR' } }),
      prisma.creatorProfile.upsert({
        where: { userId: user.id },
        create: { userId: user.id, displayName: claims.username },
        update: {},
      }),
    ]);
    user = updated;
  }

  if (SYSTEM_IDS.has(user.id) || user.role === 'ADMIN' || user.siteUid !== claims.uid) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  if (user.status !== 'ACTIVE') return { ok: false, status: 403, error: 'account_' + user.status.toLowerCase() };
  return { ok: true, user };
}

async function provisionBridgedUser(claims: BridgeClaims): Promise<User> {
  const asEmail = claims.email.trim().toLowerCase();
  let email = z.string().email().max(200).safeParse(asEmail).success ? asEmail : syntheticBridgeEmail(claims.uid);
  let username = claims.username;

  // Up to three attempts: each unique-violation is resolved by the only
  // thing that can have caused it -- a concurrent exchange for the same site
  // user (siteUid; adopt that row), or an unrelated row that happens to hold
  // this email or username (move to the namespaced value and retry).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.user.create({
        data: {
          siteUid: claims.uid, email, username, role: claims.role,
          // Bridged accounts never log in directly with a password -- this
          // hash is unusable (nobody knows it), and /login refuses any row
          // with a siteUid regardless.
          passwordHash: await argon2Placeholder(),
          account: { create: {} },
          creator: claims.role === 'CREATOR' ? { create: { displayName: claims.username } } : undefined,
        },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      const raced = await prisma.user.findUnique({ where: { siteUid: claims.uid } });
      if (raced) return raced;
      if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) email = syntheticBridgeEmail(claims.uid);
      if (await prisma.user.findUnique({ where: { username }, select: { id: true } })) {
        username = `${claims.username}-${sha(claims.uid).slice(0, 8)}`;
      }
    }
  }
  throw new Error('bridge_provision_failed');
}

// Random, never revealed, and not even a valid argon2 encoding -- verify()
// on it throws, which /login treats as a failed match. Saves an argon2 hash
// (tens of ms of deliberate CPU) on every first-time bridge.
async function argon2Placeholder() {
  return `!bridged:${crypto.randomBytes(24).toString('base64url')}`;
}
