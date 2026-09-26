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
  // A FAN's account standing on the site (lib/user-moderation.js), null for
  // creators and for a site too old to send it. Sent by the site as
  // `standing` (or, equivalently, `creatorStatus` on a FAN token);
  // normalised here so creatorStatus stays null for every fan.
  fanStatus?: SiteFanStatus | null;
  // When the site decided the standing this token carries (ms epoch).
  // Optional (older site code omits it). Orders standing messages: one
  // older than the last applied in the same dimension (User.siteStatusAt
  // for a creator token, User.siteAccountStatusAt for a fan token) changes
  // nothing.
  standingAt?: number;
  // For a 'suspended' standing: when the site's suspension lapses by itself
  // (ms epoch). Recorded so the lift happens here too (liftLapsedSiteSuspensions).
  suspendedUntil?: number;
  jti: string;       // single-use id; /auth/bridge burns it in Redis
  exp: number;       // ms since epoch; short-lived, this is a one-time exchange token
};

export type SiteFanStatus = 'active' | 'suspended' | 'banned';
const FAN_STATUSES = ['active', 'suspended', 'banned'];

// Tolerated clock skew between the site and here for `standingAt`. A stamp
// further in the future is refused outright: accepted, it would sit on the
// row as the newest standing and make every genuine later message "older".
const STANDING_SKEW_MS = 5 * 60_000;

/**
 * `suspendedUntil` as sent by the site: kept only for a 'suspended' standing
 * and only when it is a finite, positive ms epoch; anything else is dropped
 * (not the whole message -- a restriction must never be refused over a bad
 * optional field; without it the suspension simply waits for a site 'active').
 */
function normaliseSuspendedUntil(c: { suspendedUntil?: unknown }, status: string | null | undefined) {
  const v = c.suspendedUntil;
  if (status === 'suspended' && typeof v === 'number' && Number.isFinite(v) && v > 0) return;
  delete c.suspendedUntil;
}

/** A valid standingAt: a finite ms timestamp, not after the token's own expiry, not in the future beyond skew. */
function validStandingAt(v: unknown, exp: number) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= exp && v <= Date.now() + STANDING_SKEW_MS;
}

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
  const raw = claims as BridgeClaims & { standing?: unknown };
  if (claims.role === 'FAN') {
    // A fan's standing may arrive as `standing` or as `creatorStatus`; a fan
    // is never 'pending', and two fields that disagree are a malformed token.
    const fs = raw.standing ?? cs ?? null;
    if (fs !== null && !FAN_STATUSES.includes(fs as string)) return null;
    if (raw.standing != null && cs !== null && raw.standing !== cs) return null;
    claims.fanStatus = fs as SiteFanStatus | null;
    claims.creatorStatus = null;
  } else {
    if (raw.standing != null) return null;
    claims.fanStatus = null;
    claims.creatorStatus = cs;
  }
  delete raw.standing;
  if (claims.standingAt !== undefined && claims.standingAt !== null && !validStandingAt(claims.standingAt, claims.exp)) return null;
  if (claims.standingAt === null) delete claims.standingAt;
  normaliseSuspendedUntil(claims, claims.role === 'FAN' ? claims.fanStatus : claims.creatorStatus);
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
  const fan = claims.role === 'FAN';
  const at = claims.standingAt;

  let user = await prisma.user.findUnique({ where: { siteUid: claims.uid } });

  // A ban or suspension on the site is APPLIED here, not just used to refuse
  // this one exchange: the account would otherwise keep earning -- fans'
  // subscriptions renewing, listings buyable, a queued payout going out --
  // while the owner believes it is banned. The site also pushes status
  // changes directly (POST /auth/bridge/status), so this is the second of
  // two routes, not the only one. The same holds for a FAN the site has
  // suspended or banned: without it their subscriptions and token locks
  // kept renewing here, and a site-banned fan can no longer sign in to
  // cancel them. The exchange is refused either way; whether the standing
  // is applied depends on its order (claimStanding).
  const restriction = fan
    ? (claims.fanStatus === 'banned' || claims.fanStatus === 'suspended' ? claims.fanStatus : null)
    : (claims.creatorStatus === 'banned' || claims.creatorStatus === 'suspended' ? claims.creatorStatus : null);
  if (restriction) {
    if (user) await syncSiteStanding(user, restriction, { standingAt: at, fan, suspendedUntil: claims.suspendedUntil });
    return { ok: false, status: 403, error: restriction };
  }

  if (!user) user = await provisionBridgedUser(claims);
  if (SYSTEM_IDS.has(user.id) || user.role === 'ADMIN' || user.siteUid !== claims.uid) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  // The standing this token carries is applied only if it is not older than
  // the last standing applied to this row: a token minted 'active' just
  // before a suspension, but exchanged just after the suspension push, must
  // not lift it (or re-mark a creator the site moved back to 'pending' as
  // approved). A stale token still bridges -- into whatever standing the
  // row already has.
  const standing = fan ? (claims.fanStatus ?? null) : claims.creatorStatus;
  const dim: StandingDim = fan ? 'account' : 'creator';
  const fresh = standing ? await claimStanding(user, at, standing, dim) : true;

  if (fresh) {
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
    const data: Prisma.UserUpdateInput = {};
    if (fan) {
      // A fan token carries the ACCOUNT standing. It still says the site
      // user is not an approved creator, so creator approval is dropped as
      // before (fail closed) -- but a creator RESTRICTION is never erased by
      // it: that would let the fan 'active' below lift the creator ladder's
      // suspension.
      if (standing && user.siteAccountStatus !== standing) data.siteAccountStatus = standing;
      if (user.siteCreatorStatus === 'active' || user.siteCreatorStatus === 'pending') data.siteCreatorStatus = null;
    } else if (user.siteCreatorStatus !== claims.creatorStatus) {
      data.siteCreatorStatus = claims.creatorStatus;
    }
    if (Object.keys(data).length) user = await prisma.user.update({ where: { id: user.id }, data });
    // A suspension or ban the SITE applied lifts when the site says the
    // account is active again (its creator suspensions expire by themselves
    // after 30 days; a site admin may reverse a ban) -- unless the site's
    // OTHER standing for this account still restricts it (siteMayLift). One
    // a server/ admin applied is not lifted this way. Payouts stay frozen
    // either way until an admin unfreezes them, and listings a ban took
    // down stay down until an admin restores them (core/moderation.ts).
    // Conditional in the database (applyUserStatus): `user` was read above,
    // and an admin's ban landing since must not be lifted by it.
    if (standing === 'active' && siteMayLift(user, dim)) {
      await applyUserStatus(user.id, 'ACTIVE', { bySite: true });
    }
  }
  user = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

  if (user.status !== 'ACTIVE') return { ok: false, status: 403, error: 'account_' + user.status.toLowerCase() };
  return { ok: true, user };
}

/**
 * The site keeps TWO standings on an account, and each reaches here as its
 * own kind of message:
 *  - 'creator': the creator record's status (the content-violation ladder),
 *    made stricter by any account moderation -- a CREATOR token or push.
 *    Stored as siteCreatorStatus, ordered by siteStatusAt.
 *  - 'account': the login's own moderation (lib/user-moderation.js) -- a FAN
 *    token or a role 'FAN' push. Stored as siteAccountStatus, ordered by
 *    siteAccountStatusAt.
 * One shared stamp let a creator message (e.g. a 'pending' exchange) make a
 * late account suspension look stale, and one shared "suspended by the site"
 * flag let 'active' in one dimension lift the other's suspension.
 */
export type StandingDim = 'creator' | 'account';

const RESTRICTIVE = new Set(['suspended', 'banned']);

/**
 * May a site message in dimension `dim` saying 'active' lift this row's
 * suspension or ban? Only one the site applied (statusBySite) -- a site
 * reinstatement undoes the site's own ban as well as its suspension, while a
 * ban or suspension a server/ admin applied is never lifted by the site --
 * and only while the site's standing in the OTHER dimension, as last
 * recorded here, does not itself restrict the account.
 */
export function siteMayLift(
  u: Pick<User, 'status' | 'statusBySite' | 'siteCreatorStatus' | 'siteAccountStatus'>,
  dim: StandingDim,
) {
  if ((u.status !== 'SUSPENDED' && u.status !== 'BANNED') || !u.statusBySite) return false;
  const other = dim === 'creator' ? u.siteAccountStatus : u.siteCreatorStatus;
  return !RESTRICTIVE.has(other ?? '');
}

/**
 * Orders site standing messages, per dimension. Claims the right to apply a
 * standing decided at `at` (ms epoch, the site's `standingAt`) to this row,
 * by advancing that dimension's stamp with a guarded UPDATE -- so of two
 * messages racing, or arriving out of order, the older one never overrides
 * the newer.
 *
 * An unstamped message (older site code) is treated asymmetrically, because
 * lifting a restriction is the dangerous direction: a restriction always
 * applies (fail safe), a lift ('active') only while no stamped message has
 * ever been applied in that dimension.
 */
export async function claimStanding(
  user: { id: string },
  at: number | undefined,
  status: string,
  dim: StandingDim = 'creator',
): Promise<boolean> {
  if (at === undefined) {
    if (status !== 'active') return true;
    const where = dim === 'creator' ? { id: user.id, siteStatusAt: null } : { id: user.id, siteAccountStatusAt: null };
    return (await prisma.user.count({ where })) > 0;
  }
  const d = new Date(at);
  const r = dim === 'creator'
    ? await prisma.user.updateMany({
      where: { id: user.id, OR: [{ siteStatusAt: null }, { siteStatusAt: { lte: d } }] },
      data: { siteStatusAt: d },
    })
    : await prisma.user.updateMany({
      where: { id: user.id, OR: [{ siteAccountStatusAt: null }, { siteAccountStatusAt: { lte: d } }] },
      data: { siteAccountStatusAt: d },
    });
  return r.count > 0;
}

/**
 * Applies the site's word on a bridged account's standing: 'banned' and
 * 'suspended' run the same effects as an admin action here
 * (core/moderation.ts), marked as coming from the site; 'active' lifts only
 * a suspension or ban the site itself applied. Never touches a system or
 * ADMIN row, and never softens a ban or suspension a server/ admin
 * applied: an 'active' for such a row returns 'ban_needs_server_admin' or
 * 'suspension_needs_server_admin' (POST /auth/bridge/status answers 409 with
 * it) so the site's outbox keeps the reinstatement flagged instead of
 * reporting it delivered. A message older than the last one
 * applied (claimStanding) changes nothing and returns 'stale'.
 *
 * `fan`: the standing is the account (user-moderation) standing, not the
 * creator standing -- it is recorded as siteAccountStatus and ordered on its
 * own clock, and siteCreatorStatus (creator approval) is left alone. When
 * the caller can't say (a push without a role), a FAN row that never was a
 * site creator (siteCreatorStatus null) is treated as a fan. Either
 * dimension's 'active' lifts only a site suspension the other dimension
 * does not also hold (siteMayLift).
 */
export async function syncSiteStanding(
  user: User,
  status: SiteCreatorStatus,
  opts: { standingAt?: number; fan?: boolean; suspendedUntil?: number } = {},
): Promise<'banned' | 'suspended' | 'reactivated' | 'unchanged' | 'stale' | 'ban_needs_server_admin' | 'suspension_needs_server_admin'> {
  if (SYSTEM_IDS.has(user.id) || user.role === 'ADMIN' || !user.siteUid) return 'unchanged';
  const fan = opts.fan ?? (user.role === 'FAN' && user.siteCreatorStatus == null && status !== 'pending');
  if (fan && status === 'pending') return 'unchanged'; // a fan is never 'pending'
  const dim: StandingDim = fan ? 'account' : 'creator';
  if (!(await claimStanding(user, opts.standingAt, status, dim))) return 'stale';
  // When this dimension's site suspension lapses by itself. Set only with a
  // 'suspended' standing, cleared by any other: the site's suspensions end
  // on their own (lib/creator-status.js effectiveCreatorStatus, and
  // user-moderation's moderationUntil) and nothing on the site pushes
  // 'active' when that happens, so without it a lapsed suspension stayed
  // in force here for good.
  //
  // A 'suspended' message that carries no lapse time (the site's exchange
  // token, outbox rows from before suspendedUntil existed, fan pushes from
  // older site code) says nothing about WHEN the suspension ends, so while
  // this dimension is already suspended it keeps the recorded lapse rather
  // than erasing it -- erasing it is what would make a suspended user's
  // next login pin the suspension here for good. It is null only for a
  // suspension that starts with this message and names no end.
  const prevStatus = fan ? user.siteAccountStatus : user.siteCreatorStatus;
  const prevUntil = fan ? user.siteAccountSuspendedUntil : user.siteSuspendedUntil;
  const until = status !== 'suspended'
    ? null
    : Number.isFinite(opts.suspendedUntil) && (opts.suspendedUntil as number) > 0
      ? new Date(opts.suspendedUntil as number)
      : prevStatus === 'suspended' ? (prevUntil ?? null) : null;
  if (fan && (user.siteAccountStatus !== status || +(user.siteAccountSuspendedUntil ?? 0) !== +(until ?? 0))) {
    user = await prisma.user.update({ where: { id: user.id }, data: { siteAccountStatus: status, siteAccountSuspendedUntil: until } });
  } else if (!fan && (user.siteCreatorStatus !== status || +(user.siteSuspendedUntil ?? 0) !== +(until ?? 0))) {
    user = await prisma.user.update({ where: { id: user.id }, data: { siteCreatorStatus: status, siteSuspendedUntil: until } });
  }
  // `user` may be stale by now (an admin can act in between), so each of
  // these is applied conditionally in the database (applyUserStatus): an
  // admin ban is never lifted or downgraded by a message that raced it.
  if (status === 'banned') {
    if (user.status === 'BANNED') return 'unchanged';
    return (await applyUserStatus(user.id, 'BANNED', { bySite: true })) ? 'banned' : 'unchanged';
  }
  if (status === 'suspended') {
    if (user.status !== 'ACTIVE') return 'unchanged';
    return (await applyUserStatus(user.id, 'SUSPENDED', { bySite: true })) ? 'suspended' : 'unchanged';
  }
  if (status === 'active') {
    if (siteMayLift(user, dim) && await applyUserStatus(user.id, 'ACTIVE', { bySite: true })) return 'reactivated';
    // `user` may be stale (an admin can ban in between), so decide the
    // refusal from the row as it is now.
    const now = await prisma.user.findUnique({ where: { id: user.id }, select: { status: true, statusBySite: true } });
    if (now?.status === 'BANNED' && !now.statusBySite) return 'ban_needs_server_admin';
    if (now?.status === 'SUSPENDED' && !now.statusBySite) return 'suspension_needs_server_admin';
  }
  return 'unchanged';
}

/**
 * Lifts site suspensions whose `suspendedUntil` has passed. Run on a timer
 * (workers/renewals.ts, every tick). For each lapsed dimension the recorded
 * site standing becomes 'active' -- which is what the site itself now says --
 * and that dimension's stamp is advanced 1ms past the suspension's own, so a
 * delayed copy of that suspension is stale and cannot reinstate it, while a
 * later decision (a ban delivered late) still applies. The account is reactivated only when the suspension
 * was the site's (statusBySite) and neither dimension still restricts it --
 * never an admin's suspension, never a ban. Guarded on the exact values read,
 * so a newer message landing in between wins.
 */
export async function liftLapsedSiteSuspensions(now = new Date()): Promise<number> {
  const rows = await prisma.user.findMany({
    where: { OR: [{ siteSuspendedUntil: { lte: now } }, { siteAccountSuspendedUntil: { lte: now } }] },
    take: 500,
  });
  let lifted = 0;
  for (const u of rows) {
    const data: Prisma.UserUpdateInput = {};
    let creatorStatus = u.siteCreatorStatus;
    let accountStatus = u.siteAccountStatus;
    // The stamp moves only 1ms past the message that applied the suspension
    // (the latest applied in that dimension), NOT to the lapse time: that
    // makes a delayed copy of that same suspension stale, while anything the
    // site decided after it -- a ban issued mid-suspension and delivered
    // late, say -- still applies. An unstamped suspension leaves the stamp
    // null; a delayed unstamped copy would apply whatever the stamp said.
    const justAfter = (d: Date) => new Date(d.getTime() + 1);
    if (u.siteSuspendedUntil && u.siteSuspendedUntil <= now) {
      data.siteSuspendedUntil = null;
      if (u.siteCreatorStatus === 'suspended') {
        data.siteCreatorStatus = creatorStatus = 'active';
        if (u.siteStatusAt) data.siteStatusAt = justAfter(u.siteStatusAt);
      }
    }
    if (u.siteAccountSuspendedUntil && u.siteAccountSuspendedUntil <= now) {
      data.siteAccountSuspendedUntil = null;
      if (u.siteAccountStatus === 'suspended') {
        data.siteAccountStatus = accountStatus = 'active';
        if (u.siteAccountStatusAt) data.siteAccountStatusAt = justAfter(u.siteAccountStatusAt);
      }
    }
    const claimed = await prisma.user.updateMany({
      where: {
        id: u.id, siteCreatorStatus: u.siteCreatorStatus, siteAccountStatus: u.siteAccountStatus,
        siteSuspendedUntil: u.siteSuspendedUntil, siteAccountSuspendedUntil: u.siteAccountSuspendedUntil,
        siteStatusAt: u.siteStatusAt, siteAccountStatusAt: u.siteAccountStatusAt,
      },
      data: data as Prisma.UserUpdateManyMutationInput,
    });
    if (!claimed.count) continue;
    // u.status is the snapshot from the read above; an admin ban or
    // suspension issued while this loop worked through earlier rows is not in
    // it (the claim above only guards the site_* columns). applyUserStatus
    // lifts only a row that is STILL suspended by the site, in the database.
    if (u.status === 'SUSPENDED' && u.statusBySite && !RESTRICTIVE.has(creatorStatus ?? '') && !RESTRICTIVE.has(accountStatus ?? '')) {
      if (await applyUserStatus(u.id, 'ACTIVE', { bySite: true })) lifted++;
    }
  }
  return lifted;
}

export type BridgeStatusClaims = {
  typ: 'bridge_status'; uid: string; creatorStatus: SiteCreatorStatus; jti: string; exp: number;
  // Optional: when the site decided this standing (ms epoch), and whose
  // standing it is. Both absent from older site code.
  standingAt?: number;
  role?: 'FAN' | 'CREATOR';
  // Optional, 'suspended' only: when that suspension lapses on the site (ms
  // epoch). See syncSiteStanding and liftLapsedSiteSuspensions.
  suspendedUntil?: number;
};

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
  // A fan's push may name its status `standing`; either field, not two that disagree.
  const raw = c as BridgeStatusClaims & { standing?: unknown };
  if (raw.standing != null) {
    if (c.creatorStatus != null && c.creatorStatus !== raw.standing) return null;
    c.creatorStatus = raw.standing as SiteCreatorStatus;
    delete raw.standing;
  }
  if (!['active', 'pending', 'suspended', 'banned'].includes(c.creatorStatus)) return null;
  if (c.role !== undefined && c.role !== 'FAN' && c.role !== 'CREATOR') return null;
  if (c.role === 'FAN' && c.creatorStatus === 'pending') return null;
  if (c.standingAt !== undefined && c.standingAt !== null && !validStandingAt(c.standingAt, c.exp)) return null;
  if (c.standingAt === null) delete c.standingAt;
  normaliseSuspendedUntil(c, c.creatorStatus);
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
          siteAccountStatus: claims.role === 'FAN' ? (claims.fanStatus ?? null) : null,
          // Ordering starts from this token's own standing, if stamped, in
          // the dimension the token speaks for.
          ...(claims.standingAt !== undefined
            ? (claims.role === 'FAN' ? { siteAccountStatusAt: new Date(claims.standingAt) } : { siteStatusAt: new Date(claims.standingAt) })
            : {}),
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
