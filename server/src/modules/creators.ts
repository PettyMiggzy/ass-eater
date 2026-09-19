import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { isAddress } from 'viem';
import { money, lockBalance, post, PLATFORM_ID, InsufficientFunds, postPlatformRevenue, getTopSupporters } from '../core/ledger';
import { isSubscribed } from '../core/access';

export const creators: FastifyPluginAsync = async (app) => {
  // Creator-only analytics -- see the privacy note on getTopSupporters() for
  // why this is not a public badge on the creator's page.
  app.get('/me/top-supporters', { preHandler: app.creatorOk }, async (req: any) => {
    const limit = Math.min(Number(req.query.limit ?? 10), 50);
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
    const c = await prisma.creatorProfile.findFirst({
      where: { user: { username: req.params.username, status: 'ACTIVE' } },
      include: { tiers: { where: { active: true } }, user: { select: { username: true, kycStatus: true } } },
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
    const { payoutAddress, payoutsFrozen, ...pub } = c;
    return pub;
  });

  app.patch('/me', { preHandler: app.role('CREATOR') }, async (req) => {
    const b = z.object({
      displayName: z.string().min(1).max(50).optional(), bio: z.string().max(2000).optional(),
      avatarKey: z.string().optional(), bannerKey: z.string().optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
      // Never ONLYASS: paying a creator in the token is still paying
      // someone in a token whose price moves between earning and cashing out.
      payoutAsset: z.enum(['STABLE', 'ETH']).optional(),
      payoutAddress: z.string().refine(isAddress, 'bad_address').optional(),
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
  app.get('/', async (req: any) => {
    const q = z.string().trim().max(60).optional().parse(req.query.q || undefined);
    const tag = z.string().trim().max(40).optional().parse(req.query.tag || undefined);
    const take = Math.min(Number(req.query.limit ?? 30), 100);
    return prisma.creatorProfile.findMany({
      where: {
        user: { status: 'ACTIVE', kycStatus: 'APPROVED' },
        ...(tag ? { tags: { has: tag } } : {}),
        ...(q ? { OR: [
          { displayName: { contains: q, mode: 'insensitive' } },
          { bio: { contains: q, mode: 'insensitive' } },
          { user: { username: { contains: q, mode: 'insensitive' } } },
        ] } : {}),
      },
      orderBy: [{ promotedUntil: { sort: 'desc', nulls: 'last' } }, { user: { subsAsCreator: { _count: 'desc' } } }],
      take, skip: Number(req.query.offset ?? 0),
      select: { userId: true, displayName: true, bio: true, avatarKey: true, bannerKey: true, tags: true, promotedUntil: true, user: { select: { username: true } }, tiers: { where: { active: true }, orderBy: { priceCents: 'asc' }, take: 1 } },
    });
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
