import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { charge, money, FEES } from '../core/ledger';
import { publish } from '../lib/redis';
import { nanoid } from 'nanoid';

export const tips: FastifyPluginAsync = async (app) => {
  app.post('/', { preHandler: app.auth }, async (req) => {
    const b = z.object({
      creatorId: z.string().uuid(), amountCents: z.number().int().min(FEES.MIN_TIP_CENTS).max(500_000),
      postId: z.string().uuid().optional(), streamId: z.string().uuid().optional(), note: z.string().max(280).optional(),
      payAsset: z.enum(['USD', 'ONLYASS']).default('USD'),
    }).parse(req.body);
    const tipId = nanoid(12);
    const r = await money(prisma, (tx) => charge(tx, { fanId: req.user.id, creatorId: b.creatorId, grossCents: b.amountCents, type: 'TIP', refId: tipId, payAsset: b.payAsset }));
    const from = await prisma.user.findUnique({ where: { id: req.user.id }, select: { username: true } });
    const evt = { type: 'tip', tipId, from: from?.username, amountCents: b.amountCents, note: b.note, postId: b.postId, streamId: b.streamId };
    await publish(b.creatorId, evt);
    if (b.streamId) await publish(`stream:${b.streamId}`, evt);   // live overlay channel
    return { ok: true, tipId, ...r };
  });

  app.get('/received', { preHandler: app.creatorOk }, async (req: any) =>
    prisma.ledgerEntry.findMany({ where: { userId: req.user.id, type: 'TIP', amountCents: { gt: 0 } }, orderBy: { createdAt: 'desc' }, take: 100 }));
};
