import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { isAddress } from 'viem';
import { money, lockBalance, post, PLATFORM_ID, InsufficientFunds } from '../core/ledger';

export const creators: FastifyPluginAsync = async (app) => {
  app.get('/:username', async (req: any, reply) => {
    const c = await prisma.creatorProfile.findFirst({
      where: { user: { username: req.params.username, status: 'ACTIVE' } },
      include: { tiers: { where: { active: true } }, user: { select: { username: true, kycStatus: true } } },
    });
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const { payoutAddress, payoutsFrozen, ...pub } = c;
    return pub;
  });

  app.patch('/me', { preHandler: app.role('CREATOR') }, async (req) => {
    const b = z.object({
      displayName: z.string().min(1).max(50).optional(), bio: z.string().max(2000).optional(),
      avatarKey: z.string().optional(), bannerKey: z.string().optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
      payoutAsset: z.enum(['USDC', 'ETH', 'ONLYASS']).optional(),
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
      await post(tx, PLATFORM_ID, PROMO_CENTS, 'PLATFORM_FEE', undefined, { source: 'promotion' });
      const cur = await tx.creatorProfile.findUniqueOrThrow({ where: { userId: req.user.id } });
      const from = cur.promotedUntil && cur.promotedUntil > new Date() ? cur.promotedUntil : new Date();
      return tx.creatorProfile.update({ where: { userId: req.user.id }, data: { promotedUntil: new Date(from.getTime() + DAYS * 864e5) } });
    });
  });
};
