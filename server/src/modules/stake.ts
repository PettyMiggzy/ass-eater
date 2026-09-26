import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parseUnits } from 'viem';
import { prisma } from '../lib/prisma.js';
import { charge, money } from '../core/ledger.js';
import { getUsdPrice } from '../lib/price.js';
import { DECIMALS } from '../lib/chain.js';
import { page } from '../plugins/pagination.js';
import { withProfileImageUrls } from '../core/public-images.js';
import { assertCleanText } from '../lib/text-screen.js';

const PERIOD_MS = 30 * 864e5;

/**
 * Buys (or re-confirms) a fan's lock on a creator's perk at the price the fan
 * was shown. Exported so it is testable against a real Postgres.
 */
export async function lockPerk(fanId: string, creatorId: string, expectedUsdCents: number, tokenAmountAtLock: string) {
  return money(prisma, async (tx) => {
    // Re-read inside the transaction: the price charged is the one checked.
    const cur = await tx.creatorProfile.findUniqueOrThrow({ where: { userId: creatorId } });
    if (!cur.stakePerkEnabled || !cur.stakeUsdCents) throw Object.assign(new Error('no_perk'), { statusCode: 400 });
    if (cur.stakeUsdCents !== expectedUsdCents) throw Object.assign(new Error('price_changed'), { statusCode: 409 });
    const usdCents = cur.stakeUsdCents;
    const existing = await tx.tokenLock.findUnique({ where: { fanId_creatorId: { fanId, creatorId } } });
    if (existing?.status === 'ACTIVE' && existing.currentPeriodEnd > new Date()) {
      // Already paid for this period: re-enable renewal at the price the
      // fan just confirmed. Only autoRenew used to change, so a fan who
      // re-locked after the creator LOWERED the perk (shown and confirmed
      // $20) was renewed at the old $50 by workers/renewals.ts, which charges
      // l.usdCents -- a price they never confirmed. POST /subscriptions
      // updates priceCents in the same branch.
      return tx.tokenLock.update({ where: { id: existing.id }, data: { autoRenew: true, usdCents, tokenAmountAtLock } });
    }
    const lock = await tx.tokenLock.upsert({
      where: { fanId_creatorId: { fanId, creatorId } },
      create: { fanId, creatorId, usdCents, tokenAmountAtLock, currentPeriodEnd: new Date(Date.now() + PERIOD_MS) },
      update: { usdCents, tokenAmountAtLock, status: 'ACTIVE', autoRenew: true, currentPeriodEnd: new Date(Date.now() + PERIOD_MS) },
    });
    await charge(tx, { fanId, creatorId, grossCents: usdCents, type: 'TOKEN_LOCK', refId: lock.id });
    return lock;
  });
}

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
    // Same screens the site runs on this kind of text (lib/text-screen.ts).
    assertCleanText([['description', b.description]]);
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
    // The perk price the fan saw -- see POST /subscriptions for why.
    const { expectedUsdCents } = z.object({ expectedUsdCents: z.number().int().min(0) }).parse(req.body ?? {});
    const c = await prisma.creatorProfile.findUnique({ where: { userId: req.params.creatorId } });
    if (!c?.stakePerkEnabled || !c.stakeUsdCents) return reply.code(400).send({ error: 'no_perk' });
    const creatorId = c.userId;

    // tokenAmountAtLock is display only; the charge is plain credits. An
    // unconfigured or failing $ONLYONE oracle must never block the purchase
    // (it made every lock a 500 on a box with no price feed), so it is
    // best-effort and '0' means "not known at lock time".
    let tokenAmountAtLock = '0';
    try {
      const px = await getUsdPrice('ONLYONE');
      if (Number.isFinite(px) && px > 0) {
        tokenAmountAtLock = parseUnits((c.stakeUsdCents / 100 / px).toFixed(DECIMALS.ONLYONE), DECIMALS.ONLYONE).toString();
      }
    } catch (e) {
      req.log.warn({ err: e }, 'stake lock: $ONLYONE price unavailable, recording 0');
    }

    return lockPerk(req.user.id, creatorId, expectedUsdCents, tokenAmountAtLock);
  });

  // Cancel = stop renewing; perk stays active until the current period ends
  // (same as subscriptions -- only autoRenew changes, status stays ACTIVE and
  // workers/renewals.ts expires it at period end).
  app.delete('/:creatorId', { preHandler: app.auth }, async (req: any) => {
    await prisma.tokenLock.updateMany({ where: { fanId: req.user.id, creatorId: req.params.creatorId, status: 'ACTIVE' }, data: { autoRenew: false } });
    return { ok: true };
  });

  app.get('/me', { preHandler: app.auth }, async (req) =>
    (await prisma.tokenLock.findMany({
      where: { fanId: req.user.id, currentPeriodEnd: { gt: new Date() } },
      include: { creator: { select: { username: true, creator: { select: { displayName: true, avatarKey: true, stakePerkDescription: true } } } } },
    })).map((l) => ({ ...l, creator: { ...l.creator, creator: l.creator.creator && withProfileImageUrls(l.creator.creator) } })));

  app.get('/locked-fans', { preHandler: app.creatorOk }, async (req: any) =>
    prisma.tokenLock.findMany({
      where: { creatorId: req.user.id, status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } },
      include: { fan: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' }, take: 200, skip: page(req.query).offset,
    }));
};
