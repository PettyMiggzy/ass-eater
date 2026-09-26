import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { verifyBridgeToken, resolveBridgedUser, verifyBridgeStatusToken, syncSiteStanding } from '../lib/bridge.js';
import { redis } from '../lib/redis.js';
import { PLATFORM_ID, BURNED_ID } from '../core/ledger.js';
import { assertCleanText } from '../lib/text-screen.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const age = (dob: Date) => Math.floor((Date.now() - dob.getTime()) / 31_557_600_000);

/**
 * Direct (native) sign-up and password login are OFF unless explicitly
 * enabled. The Next.js site is the identity source: accounts are created
 * there -- behind its SIGNUPS_OPEN switch, the 27-state geoblock and
 * AgeChecker -- and reach this API only through POST /auth/bridge. Leaving
 * /register open here made api.joinonlyone.com a second, ungated way to
 * open an account (self-typed DOB, any state, while the site's signups were
 * deliberately closed). Set DIRECT_AUTH_ENABLED=true only if native accounts
 * are ever wanted again -- and then the site's gates have to be rebuilt here.
 */
export const directAuthEnabled = () => process.env.DIRECT_AUTH_ENABLED === 'true';

/**
 * Password login is still how an ADMIN gets a session: the bridge never
 * issues ADMIN (lib/bridge.ts) and every non-anonymous route needs a JWT
 * (index.ts), so closing /login outright would have locked the owner out of
 * /admin -- manual token-burn recording, report resolution, freezes, KYC
 * overrides, payout review -- unless he reopened public /register with it.
 *
 * So /login and /refresh stay reachable, but with direct auth off they only
 * ever succeed for an operator account: role ADMIN, no siteUid (never a
 * bridged row), not a system row, and a real argon2 hash -- which only
 * scripts/create-admin.ts writes. Anything else answers exactly like a wrong
 * password. /register stays closed; there is no way to make an ADMIN row over
 * HTTP.
 */
const SYSTEM_IDS = new Set([PLATFORM_ID, BURNED_ID]);
export const passwordLoginAllowed = (u: { id: string; role: string; siteUid: string | null }) =>
  !u.siteUid && !SYSTEM_IDS.has(u.id) && (directAuthEnabled() || u.role === 'ADMIN');

/**
 * A throwaway argon2id hash, made once (same parameters create-admin.ts
 * uses), that /login verifies against whenever the real verify is skipped --
 * no such row, or a row that may not log in by password. Without it an
 * operator ADMIN's email cost one argon2 verify (tens of ms) and every other
 * identifier answered in a few ms, so response timing alone confirmed which
 * address is the admin login. The result is always discarded.
 */
let dummyHash: Promise<string> | null = null;
const timingDummy = () => (dummyHash ??= argon2.hash(randomBytes(32).toString('base64url'), { type: argon2.argon2id }));

export const auth: FastifyPluginAsync = async (app) => {
  const issue = async (user: { id: string; role: any }) => {
    const access = app.jwt.sign({ id: user.id, role: user.role });
    const refresh = randomBytes(48).toString('base64url');
    await prisma.refreshToken.create({ data: { userId: user.id, tokenHash: sha(refresh), expiresAt: new Date(Date.now() + 30 * 864e5) } });
    return { access, refresh };
  };

  app.post('/register', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    // 404, not 403: a closed door should not advertise itself.
    if (!directAuthEnabled()) return reply.code(404).send({ error: 'not_found' });
    const b = z.object({
      email: z.string().email(), username: z.string().regex(/^[a-z0-9_]{3,24}$/),
      password: z.string().min(10), dob: z.coerce.date(),
      role: z.enum(['FAN', 'CREATOR']).default('FAN'), referralCode: z.string().optional(),
    }).parse(req.body);
    if (age(b.dob) < 18) return reply.code(403).send({ error: 'must_be_18' });
    // Public (and a creator's initial displayName): the site's username screen.
    assertCleanText([['username', b.username]]);

    const referredBy = b.referralCode ? await prisma.user.findUnique({ where: { username: b.referralCode }, select: { id: true } }) : null;
    const user = await prisma.user.create({
      data: {
        email: b.email.toLowerCase(), username: b.username, dob: b.dob, role: b.role,
        passwordHash: await argon2.hash(b.password), referredById: referredBy?.id,
        account: { create: {} },
        creator: b.role === 'CREATOR' ? { create: { displayName: b.username } } : undefined,
      },
    });
    return issue(user);
  });

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { email, password } = z.object({ email: z.string().max(320), password: z.string().max(1024) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Bridged rows (siteUid set) and system rows never log in by password,
    // and with direct auth off neither does anyone but an operator (see
    // passwordLoginAllowed). Bridged/system hashes are deliberately not valid
    // argon2 encodings, on which argon2.verify throws -- caught here as a
    // plain mismatch rather than surfacing as a 500 that would also reveal
    // which identifiers exist. Every path costs one argon2 verify (against
    // timingDummy() when the real one is skipped), so response time does not
    // tell an admin's email apart from any other identifier either.
    let good = false;
    if (user && passwordLoginAllowed(user)) {
      try { good = await argon2.verify(user.passwordHash, password); } catch { good = false; }
    } else {
      try { await argon2.verify(await timingDummy(), password); } catch { /* discarded */ }
    }
    if (!user || !good) return reply.code(401).send({ error: 'bad_credentials' });
    if (user.status !== 'ACTIVE') return reply.code(403).send({ error: user.status === 'BANNED' ? 'banned' : 'account_' + user.status.toLowerCase() });
    return issue(user);
  });

  // Exchanges a short-lived signed assertion from the Next.js site
  // (joinonlyone.com) for a real server/ session, auto-provisioning a
  // matching User row on first use. See lib/bridge.ts for why this uses its
  // own secret, and resolveBridgedUser() there for why the account is found
  // by the site's user id and never by email.
  //
  // Returns only an access token: the site keeps it server-side and mints a
  // fresh exchange when it expires, so a refresh token here would just be a
  // row nobody ever used or cleaned up.
  //
  // Rate limited per SITE USER once the token verifies (every exchange
  // arrives from a handful of shared Vercel egress IPs, so an IP key would
  // throttle the whole site together), and per IP for anything that does
  // not verify. Counted in preHandler, after the body is parsed.
  app.post('/bridge', {
    config: {
      rateLimit: {
        hook: 'preHandler',
        max: (_req: any, key: string) => (key.startsWith('bridge:') ? 60 : 30),
        timeWindow: '10 minutes',
        keyGenerator: (req: any) => {
          const c = verifyBridgeToken(req.body?.token);
          return c ? `bridge:${c.uid}` : `ip:${req.ip}`;
        },
      },
    },
  }, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(4096) }).parse(req.body);
    const claims = verifyBridgeToken(token);
    if (!claims) return reply.code(401).send({ error: 'invalid_bridge_token' });

    // Single use: the first exchange of a given jti wins for the token's
    // remaining lifetime (plus slack for clock skew between the two hosts).
    // A replayed token -- lifted from a log, or resent by anything between
    // the site and here -- is refused rather than minting a second session.
    const ttlMs = Math.max(1_000, claims.exp - Date.now() + 60_000);
    const fresh = await redis.set(`bridge:jti:${claims.jti}`, '1', 'PX', ttlMs, 'NX');
    if (fresh !== 'OK') return reply.code(401).send({ error: 'bridge_token_replayed' });

    const r = await resolveBridgedUser(claims);
    if (!r.ok) {
      if (r.error === 'forbidden') app.log.warn({ siteUid: claims.uid }, 'bridge: refused exchange into a non-bridge account');
      return reply.code(r.status).send({ error: r.error });
    }
    return { access: app.jwt.sign({ id: r.user.id, role: r.user.role }) };
  });

  // Site -> server push of an account's standing (lib/server-api.js
  // pushCreatorStatus/pushUserStanding on the site, called when its
  // content-violation ladder or an admin changes a creator's status, or an
  // admin suspends or bans a fan). Without it a creator banned on
  // the site stayed a working, earning account here until they happened to
  // bridge again. Signed with BRIDGE_SECRET under its own `typ`, single-use
  // like the exchange token. An unknown uid is fine -- nothing to apply.
  app.post('/bridge/status', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    // standingAt (ms epoch): when the site decided this standing. Read from
    // the signed token first; a body value is accepted only when the token
    // carries none (it can only arrive alongside a valid single-use token).
    // A durable site outbox may deliver a push long after it was decided,
    // and out of order -- syncSiteStanding ignores one older than the last
    // standing applied (lib/bridge.ts claimStanding).
    const body = z.object({ token: z.string().max(4096), standingAt: z.number().int().positive().optional() }).parse(req.body);
    const claims = verifyBridgeStatusToken(body.token);
    if (!claims) return reply.code(401).send({ error: 'invalid_bridge_token' });
    let standingAt = claims.standingAt;
    if (standingAt === undefined && body.standingAt !== undefined) {
      if (body.standingAt > Date.now() + 5 * 60_000) return reply.code(400).send({ error: 'bad_standing_at' });
      standingAt = body.standingAt;
    }
    const ttlMs = Math.max(1_000, claims.exp - Date.now() + 60_000);
    const fresh = await redis.set(`bridge:jti:${claims.jti}`, '1', 'PX', ttlMs, 'NX');
    if (fresh !== 'OK') return reply.code(401).send({ error: 'bridge_token_replayed' });
    const user = await prisma.user.findUnique({ where: { siteUid: claims.uid } });
    if (!user) return { ok: true, known: false };
    const applied = await syncSiteStanding(user, claims.creatorStatus, {
      standingAt,
      suspendedUntil: claims.suspendedUntil,
      ...(claims.role ? { fan: claims.role === 'FAN' } : {}),
    });
    // A reinstatement this server will not apply -- the account is BANNED
    // or SUSPENDED by an admin here, and the site may only lift restrictions
    // the site applied -- is not a delivery: a 2xx would let the site's
    // outbox drop it and tell the site admin every change had landed. 409
    // keeps it queued, flagged (lib/standing-outbox.js), until an admin runs
    // POST /admin/users/:id/status here.
    if (applied === 'ban_needs_server_admin' || applied === 'suspension_needs_server_admin') {
      return reply.code(409).send({ ok: false, known: true, applied, error: applied });
    }
    return { ok: true, known: true, applied };
  });

  app.post('/refresh', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    // Refresh tokens are only ever issued by /register and /login (the
    // bridge issues access tokens alone), and are held to the same rule as
    // /login: with direct auth off, only an operator account may refresh --
    // a token minted while DIRECT_AUTH_ENABLED was on dies with the flag.
    const { refresh } = z.object({ refresh: z.string().max(256) }).parse(req.body);
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha(refresh) }, include: { user: true } });
    if (!row || row.expiresAt < new Date() || !passwordLoginAllowed(row.user)) return reply.code(401).send({ error: 'invalid_refresh' });
    await prisma.refreshToken.delete({ where: { id: row.id } });   // rotate
    if (row.user.status !== 'ACTIVE') return reply.code(403).send({ error: 'account_' + row.user.status.toLowerCase() });
    return issue(row.user);
  });

  app.post('/logout', { preHandler: app.auth }, async (req) => {
    await prisma.refreshToken.deleteMany({ where: { userId: req.user.id } });
    return { ok: true };
  });

  // Referral program: username doubles as the referral code (see /register),
  // works for inviting either a creator or a fan. Referrer earns FEES.REFERRAL_BPS
  // of the platform's cut for FEES.REFERRAL_MONTHS after the referred person signs
  // up and starts transacting (as payer or payee) -- see core/ledger.ts charge().
  app.get('/referral', { preHandler: app.auth }, async (req) => {
    const [me, referrals, earnings] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { username: true } }),
      prisma.user.count({ where: { referredById: req.user.id } }),
      // Through the end of the last UTC day only, like GET /wallet/history's
      // referral rows: a live total, polled, dates each referred purchase.
      prisma.ledgerEntry.aggregate({ where: { userId: req.user.id, type: 'REFERRAL', createdAt: { lt: utcDayStart() } }, _sum: { amountCents: true } }),
    ]);
    return { code: me.username, referrals, earningsCents: Number(earnings._sum.amountCents ?? 0) };
  });
};

/** Midnight UTC today: referral earnings are shown only for days that have ended. */
function utcDayStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
