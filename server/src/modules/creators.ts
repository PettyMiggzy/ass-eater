import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { isAddress } from 'viem';
import { money, lockBalance, post, InsufficientFunds, postPlatformRevenue, getTopSupporters, FEES } from '../core/ledger.js';
import { isSubscribed } from '../core/access.js';
import { page } from '../plugins/pagination.js';

// What anyone may see of a creator's profile. userId and user.kycStatus are
// also needed by the visibility check in GET /:username below.
const PUBLIC_CREATOR_SELECT = {
  userId: true, displayName: true, bio: true, avatarKey: true, bannerKey: true, tags: true,
  inboundDmPriceCents: true, promotedUntil: true,
  stakePerkEnabled: true, stakePerkDescription: true, stakeUsdCents: true,
  tiers: { where: { active: true } },
  user: { select: { username: true, kycStatus: true } },
} as const;

export const creators: FastifyPluginAsync = async (app) => {
  // Creator-only analytics -- see the privacy note on getTopSupporters() for
  // why this is not a public badge on the creator's page.
  app.get('/me/top-supporters', { preHandler: app.creatorOk }, async (req: any) => {
    const { limit } = page(req.query, { limit: 10, max: 50 });
    const rows = await money(prisma, (tx) => getTopSupporters(tx, req.user.id, limit));
    const users = await prisma.user.findMany({ where: { id: { in: rows.map(r => r.fanId) } }, select: { id: true, username: true } });
    const byId = new Map(users.map(u => [u.id, u.username]));
    return rows.map(r => ({ fanId: r.fanId, username: byId.get(r.fanId) ?? null, totalCents: r.totalCents }));
  });

  // Public only once KYC-approved -- the same bar discovery (GET / and /tags)
  // applies and the same one app.creatorOk gates publishing/selling on. Without
  // it a brand-new, never-verified signup was fully reachable by direct link
  // even though nothing on the site ever listed them. Optional auth (no
  // preHandler) so the two people who must never be 404'd here still aren't:
  // the creator previewing their own page, and an existing subscriber.
  app.get('/:username', async (req: any, reply) => {
    let viewerId: string | null = null;
    try { await req.jwtVerify(); viewerId = req.user.id; } catch {}
    // An explicit allowlist, never `include` + a denylist: `include` returns
    // every CreatorProfile column, so each private field added later
    // (notifyEmail -- a creator's personal forwarding address -- and
    // notifyOnDm were) leaked to every anonymous visitor until someone
    // remembered to strip it here too. A new column is now private until it
    // is deliberately added to PUBLIC_CREATOR_SELECT.
    const c = await prisma.creatorProfile.findFirst({
      where: { user: { username: String(req.params.username ?? ''), status: 'ACTIVE' } },
      select: PUBLIC_CREATOR_SELECT,
    });
    if (!c) return reply.code(404).send({ error: 'not_found' });
    // The subscriber exception is load-bearing, not politeness: kycStatus
    // defaults to NONE, and the Sumsub webhook can demote an already-approved
    // creator to PENDING/REJECTED at any time (modules/kyc.ts). Neither
    // POST /subscriptions nor workers/renewals.ts looks at kycStatus, so those
    // fans keep being billed either way -- hiding the page behind the gate
    // would take away access they are still paying for.
    const visible = c.user.kycStatus === 'APPROVED' || c.userId === viewerId || (!!viewerId && await isSubscribed(viewerId, c.userId));
    if (!visible) return reply.code(404).send({ error: 'not_found' });
    // What a fan will actually be charged to message them (modules/messages.ts
    // POST /to applies the same max()), so it can be shown before sending.
    const cfg = await prisma.platformConfig.findUnique({ where: { id: 1 }, select: { minDmPriceCents: true } });
    const dmPriceCents = Math.max(cfg?.minDmPriceCents ?? FEES.MIN_DM_PRICE_CENTS, c.inboundDmPriceCents ?? 0);
    return { ...c, dmPriceCents };
  });

  app.patch('/me', { preHandler: app.role('CREATOR') }, async (req) => {
    const b = z.object({
      displayName: z.string().min(1).max(50).optional(), bio: z.string().max(2000).optional(),
      avatarKey: z.string().optional(), bannerKey: z.string().optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
      // Never ONLYONE: paying a creator in the token is still paying
      // someone in a token whose price moves between earning and cashing out.
      payoutAsset: z.enum(['STABLE', 'ETH']).optional(),
      payoutAddress: z.string().refine(isAddress, 'bad_address').optional(),
      // What a fan pays to send this creator a message (modules/messages.ts
      // POST /to). null = just the platform floor; anything below the floor
      // is charged at the floor anyway, so it can never be free.
      inboundDmPriceCents: z.number().int().min(0).max(50_000).nullable().optional(),
    }).parse(req.body);
    return prisma.creatorProfile.update({ where: { userId: req.user.id }, data: b });
  });

  app.post('/me/tiers', { preHandler: app.creatorOk }, async (req) => {
    const b = z.object({ name: z.string().max(40), priceCents: z.number().int().min(299).max(100_000) }).parse(req.body);
    return prisma.subscriptionTier.create({ data: { creatorId: req.user.id, ...b } });
  });

  app.patch('/me/tiers/:id', { preHandler: app.creatorOk }, async (req: any, reply) => {
    const b = z.object({ name: z.string().max(40).optional(), priceCents: z.number().int().min(299).max(100_000).optional(), active: z.boolean().optional() }).parse(req.body);
    const r = await prisma.subscriptionTier.updateMany({ where: { id: req.params.id, creatorId: req.user.id }, data: b });
    return r.count ? { ok: true } : reply.code(404).send({ error: 'not_found' });
  });

  // Discovery: promoted creators first, then most-subscribed. Optional ?q= text
  // search (name/bio/username) and ?tag= category filter -- OF's in-app
  // discovery is notoriously weak, this is meant to actually replace it.
  //
  // "Promoted first" means CURRENTLY promoted. Ordering on promotedUntil
  // alone kept every creator who had ever paid for a 7-day slot above every
  // creator who never had, forever, because an expired date is still not
  // null. So it is two ordered segments, paginated as one list: live
  // promotions (soonest-to-expire last), then everyone else by subscribers.
  app.get('/', async (req: any) => {
    const q = z.string().trim().max(60).optional().parse(req.query.q || undefined);
    const tag = z.string().trim().max(40).optional().parse(req.query.tag || undefined);
    const { offset, limit: take } = page(req.query);
    const now = new Date();
    const base = {
      user: { status: 'ACTIVE' as const, kycStatus: 'APPROVED' as const },
      ...(tag ? { tags: { has: tag } } : {}),
      ...(q ? { OR: [
        { displayName: { contains: q, mode: 'insensitive' as const } },
        { bio: { contains: q, mode: 'insensitive' as const } },
        { user: { username: { contains: q, mode: 'insensitive' as const } } },
      ] } : {}),
    };
    const select = { userId: true, displayName: true, bio: true, avatarKey: true, bannerKey: true, tags: true, promotedUntil: true, user: { select: { username: true } }, tiers: { where: { active: true }, orderBy: { priceCents: 'asc' as const }, take: 1 } };
    const promotedWhere = { AND: [base, { promotedUntil: { gt: now } }] };
    const promotedCount = await prisma.creatorProfile.count({ where: promotedWhere });
    const promoted = offset < promotedCount
      ? await prisma.creatorProfile.findMany({ where: promotedWhere, orderBy: [{ promotedUntil: 'desc' }, { userId: 'asc' }], skip: offset, take, select })
      : [];
    const remaining = take - promoted.length;
    const rest = remaining > 0
      ? await prisma.creatorProfile.findMany({
        where: { AND: [base, { OR: [{ promotedUntil: null }, { promotedUntil: { lte: now } }] }] },
        orderBy: [{ user: { subsAsCreator: { _count: 'desc' } } }, { userId: 'asc' }],
        skip: Math.max(0, offset - promotedCount), take: remaining, select,
      })
      : [];
    return [...promoted, ...rest];
  });

  // All tags currently in use, for building a category filter UI
  app.get('/tags', async () => {
    const rows = await prisma.creatorProfile.findMany({ where: { user: { status: 'ACTIVE', kycStatus: 'APPROVED' } }, select: { tags: true } });
    return [...new Set(rows.flatMap((r) => r.tags))].sort();
  });

  // Paid promotion slot — another monetization lever (7 days of top-of-discovery placement)
  app.post('/me/promote', { preHandler: app.creatorOk }, async (req) => {
    const PROMO_CENTS = 4999, DAYS = 7;
    return money(prisma, async (tx) => {
      const bal = await lockBalance(tx, req.user.id);
      if (bal < BigInt(PROMO_CENTS)) throw new InsufficientFunds();
      await post(tx, req.user.id, -PROMO_CENTS, 'ADJUSTMENT', undefined, { reason: 'promotion' });
      await postPlatformRevenue(tx, PROMO_CENTS, undefined, { source: 'promotion' });
      const cur = await tx.creatorProfile.findUniqueOrThrow({ where: { userId: req.user.id } });
      const from = cur.promotedUntil && cur.promotedUntil > new Date() ? cur.promotedUntil : new Date();
      return tx.creatorProfile.update({ where: { userId: req.user.id }, data: { promotedUntil: new Date(from.getTime() + DAYS * 864e5) } });
    });
  });
};
