import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { charge, money } from '../core/ledger';

export const PERIOD_MS = 30 * 864e5;

export const subscriptions: FastifyPluginAsync = async (app) => {
  app.post('/', { preHandler: app.auth }, async (req) => {
    const { tierId } = z.object({ tierId: z.string().uuid() }).parse(req.body);
    return money(prisma, async (tx) => {
      const tier = await tx.subscriptionTier.findUniqueOrThrow({ where: { id: tierId } });
      if (!tier.active) throw Object.assign(new Error('tier_inactive'), { statusCode: 400 });
      const existing = await tx.subscription.findUnique({
        where: { fanId_creatorId: { fanId: req.user.id, creatorId: tier.creatorId } },
      });
      if (existing?.status === 'ACTIVE' && existing.currentPeriodEnd > new Date()) {
        // already subscribed: just make sure it renews and (optionally) switch tier at next renewal
        return tx.subscription.update({ where: { id: existing.id }, data: { autoRenew: true, tierId, priceCents: tier.priceCents } });
      }
      const sub = await tx.subscription.upsert({
        where: { fanId_creatorId: { fanId: req.user.id, creatorId: tier.creatorId } },
        create: { fanId: req.user.id, creatorId: tier.creatorId, tierId, priceCents: tier.priceCents, currentPeriodEnd: new Date(Date.now() + PERIOD_MS) },
        update: { tierId, priceCents: tier.priceCents, status: 'ACTIVE', autoRenew: true, currentPeriodEnd: new Date(Date.now() + PERIOD_MS) },
      });
      await charge(tx, { fanId: req.user.id, creatorId: tier.creatorId, grossCents: tier.priceCents, type: 'SUBSCRIPTION', refId: sub.id });
      return sub;
    });
  });

  // Cancel = stop renewing; access continues to period end (OF behaviour)
  app.delete('/:creatorId', { preHandler: app.auth }, async (req: any) => {
    await prisma.subscription.updateMany({ where: { fanId: req.user.id, creatorId: req.params.creatorId }, data: { autoRenew: false, status: 'CANCELLED' } });
    return { ok: true };
  });

  app.get('/me', { preHandler: app.auth }, async (req) =>
    prisma.subscription.findMany({
      where: { fanId: req.user.id, currentPeriodEnd: { gt: new Date() } },
      include: { creator: { select: { username: true, creator: { select: { displayName: true, avatarKey: true } } } }, tier: true },
    }));

  app.get('/subscribers', { preHandler: app.creatorOk }, async (req: any) =>
    prisma.subscription.findMany({
      where: { creatorId: req.user.id, status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } },
      include: { fan: { select: { id: true, username: true } }, tier: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, take: 200, skip: Number(req.query.offset ?? 0),
    }));
};
