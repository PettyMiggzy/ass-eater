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
    }).parse(req.body);
    const tipId = nanoid(12);

    // Whether this is a LIVE tip (20%) or an ordinary one (10%) is decided
    // HERE, from the creator's actual stream state -- never from the
    // streamId the client happened to send.
    //
    // Trusting the client would leak the higher rate in the easy direction:
    // a tip sent during a stream with the field simply omitted would book at
    // 10%. Nobody has to be malicious for that to happen, a client that
    // forgets to pass it through is enough, and it would be invisible.
    // Asking the database "is this creator live right now" cannot be got
    // wrong by a caller.
    const liveNow = await prisma.liveStream.findFirst({
      where: { creatorId: b.creatorId, status: 'LIVE' },
      select: { id: true },
    });
    const type = liveNow ? 'LIVE_TIP' : 'TIP';

    const r = await money(prisma, (tx) => charge(tx, { fanId: req.user.id, creatorId: b.creatorId, grossCents: b.amountCents, type, refId: tipId }));
    const from = await prisma.user.findUnique({ where: { id: req.user.id }, select: { username: true } });
    const streamId = liveNow?.id ?? b.streamId;
    const evt = { type: 'tip', tipId, from: from?.username, amountCents: b.amountCents, note: b.note, postId: b.postId, streamId };
    await publish(b.creatorId, evt);
    if (streamId) await publish(`stream:${streamId}`, evt);   // live overlay channel
    return { ok: true, tipId, ...r };
  });

  app.get('/received', { preHandler: app.creatorOk }, async (req: any) =>
    prisma.ledgerEntry.findMany({
      // Both types, or a creator's tip history silently loses everything
      // earned while they were live -- which is likely to be most of it.
      where: { userId: req.user.id, type: { in: ['TIP', 'LIVE_TIP'] }, amountCents: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }));
};
