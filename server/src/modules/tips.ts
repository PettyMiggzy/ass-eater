import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { charge, money, FEES } from '../core/ledger.js';
import { publish } from '../lib/redis.js';
import { nanoid } from 'nanoid';

/**
 * Charges one tip, at most once per (fan, idempotencyKey).
 *
 * Every other fan purchase dedupes on a natural key (the unlock's, ticket's
 * or minute's primary key, an existing order or subscription). A tip has
 * none -- two identical $200 tips can both be meant -- so the CLIENT names
 * each tip it intends with a fresh uuid and resends the same one on a retry.
 * The TipRequest row is inserted in the same transaction as the charge, so a
 * retried or double-clicked request collides on its primary key and its
 * charge rolls back with it; the loser then returns the first request's
 * result instead of paying again. As in posts.ts unlockPost, P2002 alone is
 * not proof (charge() upserts shared Account rows two different fans can
 * collide on), so the re-read -- on `prisma`, never on the rolled-back
 * transaction -- is what decides.
 */
export async function chargeTip(
  fanId: string,
  p: { creatorId: string; amountCents: number; idempotencyKey: string; type: 'TIP' | 'LIVE_TIP' },
): Promise<{ tipId: string; already: boolean; charged?: Awaited<ReturnType<typeof charge>> }> {
  const tipId = nanoid(12);
  try {
    const charged = await money(prisma, async (tx) => {
      await tx.tipRequest.create({ data: { fanId, key: p.idempotencyKey, tipId, creatorId: p.creatorId, amountCents: p.amountCents } });
      return charge(tx, { fanId, creatorId: p.creatorId, grossCents: p.amountCents, type: p.type, refId: tipId });
    });
    return { tipId, already: false, charged };
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    const prior = await prisma.tipRequest.findUnique({ where: { fanId_key: { fanId, key: p.idempotencyKey } } });
    if (!prior) throw e;
    // A key reused for a DIFFERENT tip (another creator, another amount) is
    // a client bug, not a retry: answering "already sent" told the fan a tip
    // went through that never did. Refused, like a DM's request_id_reused.
    // (Rows from before the columns existed carry nulls and cannot be
    // compared; they keep the old replay behaviour.)
    if ((prior.creatorId != null && prior.creatorId !== p.creatorId) || (prior.amountCents != null && prior.amountCents !== p.amountCents)) {
      throw Object.assign(new Error('idempotency_key_reused'), { statusCode: 409 });
    }
    return { tipId: prior.tipId, already: true };
  }
}

export const tips: FastifyPluginAsync = async (app) => {
  app.post('/', { preHandler: app.auth }, async (req) => {
    const b = z.object({
      creatorId: z.string().uuid(), amountCents: z.number().int().min(FEES.MIN_TIP_CENTS).max(500_000),
      postId: z.string().uuid().optional(), streamId: z.string().uuid().optional(), note: z.string().max(280).optional(),
      // A fresh uuid per tip the fan intends, REUSED on any retry of that
      // same tip -- see chargeTip(). Required: a tip without one cannot be
      // told apart from its own retry, and fans get no refunds.
      idempotencyKey: z.string().uuid(),
    }).parse(req.body);

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

    const r = await chargeTip(req.user.id, { creatorId: b.creatorId, amountCents: b.amountCents, idempotencyKey: b.idempotencyKey, type });
    const tipId = r.tipId;
    // A replay of a tip already charged: same answer, and no second overlay
    // event or notification for money that moved once.
    if (r.already) return { ok: true, tipId, already: true };
    const from = await prisma.user.findUnique({ where: { id: req.user.id }, select: { username: true } });
    // Only ever the tipped creator's OWN live stream. Falling back to the
    // client's streamId let anyone tip a sock-puppet creator $1 and push the
    // note onto a different creator's live overlay, as often as they liked.
    const streamId = liveNow?.id;
    const evt = { type: 'tip', tipId, from: from?.username, amountCents: b.amountCents, note: b.note, postId: b.postId, streamId };
    await publish(b.creatorId, evt);
    if (streamId) await publish(`stream:${streamId}`, evt);   // live overlay channel
    return { ok: true, tipId, ...r.charged };
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
