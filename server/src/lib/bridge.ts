import crypto from 'crypto';
import { Prisma, type User } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { PLATFORM_ID, BURNED_ID } from '../core/ledger.js';
import { applyUserStatus } from '../core/moderation.js';

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
 * Role only ever moves FAN -> CREATOR, and only for a creator the site has
 * approved ('active'); nothing here issues ADMIN, and an ADMIN or system row
 * is refused outright.
 */
export async function resolveBridgedUser(claims: BridgeClaims): Promise<BridgeResolution> {
  // Fail closed (verifyBridgeToken already rejects this shape; repeated so
  // no other caller can bridge a creator of unknown standing as unrestricted).
  if (claims.role === 'CREATOR' && !claims.creatorStatus) return { ok: false, status: 403, error: 'banned' };

  let user = await prisma.user.findUnique({ where: { siteUid: claims.uid } });

  // A ban or suspension on the site is APPLIED here, not just used to refuse
  // this one exchange: the account would otherwise keep earning -- fans'
  // subscriptions renewing, listings buyable, a queued payout going out --
  // while the owner believes it is banned. The site also pushes status
  // changes directly (POST /auth/bridge/status), so this is the second of
  // two routes, not the only one.
  if (claims.creatorStatus === 'banned' || claims.creatorStatus === 'suspended') {
    if (user) await syncSiteStanding(user, claims.creatorStatus);
    return { ok: false, status: 403, error: claims.creatorStatus };
  }

  if (!user) user = await provisionBridgedUser(claims);
  if (SYSTEM_IDS.has(user.id) || user.role === 'ADMIN' || user.siteUid !== claims.uid) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  // Only an APPROVED ('active') site creator is a creator here. A 'pending'
  // one -- not yet approved, and by the owner's rule unapprovable without a
  // §2257 performer record -- is provisioned and kept as a FAN, so it cannot
  // start server KYC and publish, sell or withdraw outside the site's
  // approval queue. The last-seen site status is stored on the row and
  // checked by app.creatorOk (plugins/auth.ts), which also catches a creator
  // who was active here and later reverted on the site.
  if (claims.role === 'CREATOR' && claims.creatorStatus === 'active' && user.role === 'FAN') {
    // Upgrade in one transaction so a row can never be a CREATOR with no
    // CreatorProfile (every creator route assumes one exists).
    const [updated] = await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { role: 'CREATOR', siteCreatorStatus: 'active' } }),
      prisma.creatorProfile.upsert({
        where: { userId: user.id },
        create: { userId: user.id, displayName: claims.username },
        update: {},
      }),
    ]);
    user = updated;
  }
  const standing = claims.creatorStatus ?? null;
  if (user.siteCreatorStatus !== standing) {
    user = await prisma.user.update({ where: { id: user.id }, data: { siteCreatorStatus: standing } });
  }
  // A suspension the SITE applied lifts when the site says the creator is
  // active again (its suspensions expire by themselves after 30 days). One
  // an admin applied here, and any ban, is not lifted this way. Payouts stay
  // frozen either way until an admin unfreezes them (core/moderation.ts).
  if (standing === 'active' && user.status === 'SUSPENDED' && user.statusBySite) {
    await applyUserStatus(user.id, 'ACTIVE', { bySite: true });
    user = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  }

  if (user.status !== 'ACTIVE') return { ok: false, status: 403, error: 'account_' + user.status.toLowerCase() };
  return { ok: true, user };
}

/**
 * Applies the site's word on a bridged account's standing: 'banned' and
 * 'suspended' run the same effects as an admin action here
 * (core/moderation.ts), marked as coming from the site; 'active' lifts only
 * a suspension the site itself applied. Never touches a system or ADMIN
 * row, and never softens an existing ban. Returns what it did.
 */
export async function syncSiteStanding(user: User, status: SiteCreatorStatus): Promise<'banned' | 'suspended' | 'reactivated' | 'unchanged'> {
  if (SYSTEM_IDS.has(user.id) || user.role === 'ADMIN' || !user.siteUid) return 'unchanged';
  if (user.siteCreatorStatus !== status) {
    await prisma.user.update({ where: { id: user.id }, data: { siteCreatorStatus: status } });
  }
  if (status === 'banned') {
    if (user.status === 'BANNED') return 'unchanged';
    await applyUserStatus(user.id, 'BANNED', { bySite: true });
    return 'banned';
  }
  if (status === 'suspended') {
    if (user.status !== 'ACTIVE') return 'unchanged';
    await applyUserStatus(user.id, 'SUSPENDED', { bySite: true });
    return 'suspended';
  }
  if (status === 'active' && user.status === 'SUSPENDED' && user.statusBySite) {
    await applyUserStatus(user.id, 'ACTIVE', { bySite: true });
    return 'reactivated';
  }
  return 'unchanged';
}

export type BridgeStatusClaims = { typ: 'bridge_status'; uid: string; creatorStatus: SiteCreatorStatus; jti: string; exp: number };

/**
 * Verifies a site -> server standing push (lib/server-api.js
 * pushCreatorStatus). Same secret as the exchange token but its own `typ`,
 * so neither can be replayed as the other. Never throws on bad input.
 */
export function verifyBridgeStatusToken(token: unknown): BridgeStatusClaims | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  let expected: Buffer;
  try { expected = Buffer.from(sign(payloadB64)); } catch { return null; }
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  let c: BridgeStatusClaims;
  try { c = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); } catch { return null; }
  if (!c || c.typ !== 'bridge_status') return null;
  if (typeof c.exp !== 'number' || c.exp < Date.now()) return null;
  if (typeof c.uid !== 'string' || !c.uid || c.uid.length > 128) return null;
  if (typeof c.jti !== 'string' || c.jti.length < 16 || c.jti.length > 128) return null;
  if (!['active', 'pending', 'suspended', 'banned'].includes(c.creatorStatus)) return null;
  return c;
}

const isApprovedCreator = (c: BridgeClaims) => c.role === 'CREATOR' && c.creatorStatus === 'active';

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
          // A creator claim is provisioned as a CREATOR only when the site
          // has approved it ('active'); see resolveBridgedUser.
          siteUid: claims.uid, email, username, role: isApprovedCreator(claims) ? 'CREATOR' : 'FAN',
          siteCreatorStatus: claims.creatorStatus ?? null,
          // Bridged accounts never log in directly with a password -- this
          // hash is unusable (nobody knows it), and /login refuses any row
          // with a siteUid regardless.
          passwordHash: await argon2Placeholder(),
          account: { create: {} },
          creator: isApprovedCreator(claims) ? { create: { displayName: claims.username } } : undefined,
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
