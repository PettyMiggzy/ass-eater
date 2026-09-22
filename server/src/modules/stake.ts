import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parseUnits } from 'viem';
import { prisma } from '../lib/prisma.js';
import { charge, money } from '../core/ledger.js';
import { getUsdPrice } from '../lib/price.js';
import { DECIMALS } from '../lib/chain.js';

const PERIOD_MS = 30 * 864e5;

// Fan locks $ONLYONE-equivalent value against an opted-in creator's perk.
// Renews monthly exactly like a subscription -- see subscriptions.ts.
export const stake: FastifyPluginAsync = async (app) => {
  // Creator opts in / updates their perk terms. Leaving this alone (or
  // setting enabled: false) means fans never see a lock option for them.
  app.patch('/me/perk', { preHandler: app.creatorOk }, async (req) => {
    const b = z.object({
      enabled: z.boolean(),
      description: z.string().max(500).optional(),
      usdCents: z.number().int().min(100).max(1_000_000).optional(),
    }).parse(req.body);
    if (b.enabled && (!b.description || !b.usdCents)) {
      throw Object.assign(new Error('description_and_usdCents_required'), { statusCode: 400 });
    }
    return prisma.creatorProfile.update({
      where: { userId: req.user.id },
      data: { stakePerkEnabled: b.enabled, stakePerkDescription: b.description, stakeUsdCents: b.usdCents },
    });
  });

  // Public: what a fan sees before locking. Only exposed if the creator opted in.
  app.get('/:creatorId/perk', async (req: any, reply) => {
    const c = await prisma.creatorProfile.findUnique({
      where: { userId: req.params.creatorId },
      select: { stakePerkEnabled: true, stakePerkDescription: true, stakeUsdCents: true },
    });
    if (!c?.stakePerkEnabled) return reply.code(404).send({ error: 'no_perk' });
    return { description: c.stakePerkDescription, usdCents: c.stakeUsdCents };
  });

  app.post('/:creatorId/lock', { preHandler: app.auth }, async (req: any, reply) => {
    const c = await prisma.creatorProfile.findUnique({ where: { userId: req.params.creatorId } });
    if (!c?.stakePerkEnabled || !c.stakeUsdCents) return reply.code(400).send({ error: 'no_perk' });
    const creatorId = c.userId, usdCents = c.stakeUsdCents;

    const px = await getUsdPrice('ONLYONE');
    const tokenAmountAtLock = parseUnits((usdCents / 100 / px).toFixed(DECIMALS.ONLYONE), DECIMALS.ONLYONE).toString();

    return money(prisma, async (tx) => {
      const existing = await tx.tokenLock.findUnique({ where: { fanId_creatorId: { fanId: req.user.id, creatorId } } });
      if (existing?.status === 'ACTIVE' && existing.currentPeriodEnd > new Date()) {
        return tx.tokenLock.update({ where: { id: existing.id }, data: { autoRenew: true } });
      }
      const lock = await tx.tokenLock.upsert({
        where: { fanId_creatorId: { fanId: req.user.id, creatorId } },
        create: { fanId: req.user.id, creatorId, usdCents, tokenAmountAtLock, currentPeriodEnd: new Date(Date.now() + PERIOD_MS) },
        update: { usdCents, tokenAmountAtLock, status: 'ACTIVE', autoRenew: true, currentPeriodEnd: new Date(Date.now() + PERIOD_MS) },
      });
      await charge(tx, { fanId: req.user.id, creatorId, grossCents: usdCents, type: 'TOKEN_LOCK', refId: lock.id });
      return lock;
    });
  });

  // Cancel = stop renewing; perk stays active until the current period ends (same as subscriptions)
  app.delete('/:creatorId', { preHandler: app.auth }, async (req: any) => {
    await prisma.tokenLock.updateMany({ where: { fanId: req.user.id, creatorId: req.params.creatorId }, data: { autoRenew: false, status: 'CANCELLED' } });
    return { ok: true };
  });

  app.get('/me', { preHandler: app.auth }, async (req) =>
    prisma.tokenLock.findMany({
      where: { fanId: req.user.id, currentPeriodEnd: { gt: new Date() } },
      include: { creator: { select: { username: true, creator: { select: { displayName: true, avatarKey: true, stakePerkDescription: true } } } } },
    }));

  app.get('/locked-fans', { preHandler: app.creatorOk }, async (req: any) =>
    prisma.tokenLock.findMany({
      where: { creatorId: req.user.id, status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } },
      include: { fan: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' }, take: 200, skip: Number(req.query.offset ?? 0),
    }));
};
