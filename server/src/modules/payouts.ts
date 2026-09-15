import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isAddress } from 'viem';
import { prisma } from '../lib/prisma';
import { money, lockBalance, post, PLATFORM_ID, FEES, InsufficientFunds } from '../core/ledger';
import { payoutQueue } from '../lib/redis';

export const payouts: FastifyPluginAsync = async (app) => {
  app.post('/', { preHandler: app.creatorOk }, async (req, reply) => {
    const { amountCents } = z.object({ amountCents: z.number().int().min(FEES.MIN_PAYOUT_CENTS) }).parse(req.body);
    const c = await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: req.user.id } });
    if (c.payoutsFrozen) return reply.code(403).send({ error: 'payouts_frozen' });
    if (!c.payoutAddress || !isAddress(c.payoutAddress)) return reply.code(400).send({ error: 'no_payout_address' });

    const p = await money(prisma, async (tx) => {
      const bal = await lockBalance(tx, req.user.id);
      if (bal < BigInt(amountCents)) throw new InsufficientFunds();
      const fee = FEES.WITHDRAWAL_FLAT_CENTS + Math.floor((amountCents * FEES.WITHDRAWAL_BPS) / 10_000);
      const net = amountCents - fee;
      if (net <= 0) throw Object.assign(new Error('amount_too_small'), { statusCode: 400 });
      const payout = await tx.payout.create({ data: { creatorId: req.user.id, asset: c.payoutAsset, address: c.payoutAddress!, amountCents: BigInt(net), feeCents: BigInt(fee) } });
      await post(tx, req.user.id, -amountCents, 'PAYOUT', payout.id, { fee, net });
      await post(tx, PLATFORM_ID, fee, 'PLATFORM_FEE', payout.id, { source: 'withdrawal' });
      return payout;
    });
    await payoutQueue.add('send', { payoutId: p.id }, { attempts: 1, removeOnComplete: 1000, removeOnFail: false });
    return { ...p, amountCents: Number(p.amountCents), feeCents: Number(p.feeCents) };
  });

  app.get('/', { preHandler: app.creatorOk }, async (req) => {
    const rows = await prisma.payout.findMany({ where: { creatorId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(r => ({ ...r, amountCents: Number(r.amountCents), feeCents: Number(r.feeCents) }));
  });

  app.get('/earnings', { preHandler: app.creatorOk }, async (req) => {
    const rows = await prisma.$queryRaw<{ type: string; total: bigint }[]>`
      SELECT type, SUM("amountCents") AS total FROM "LedgerEntry"
      WHERE "userId"=${req.user.id} AND "amountCents">0 AND "createdAt" > now() - interval '30 days' GROUP BY type`;
    return Object.fromEntries(rows.map(r => [r.type, Number(r.total)]));
  });
};
