import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { charge, money } from '../core/ledger';
import { canViewMessage, isSubscribed } from '../core/access';
import { publish, sub, broadcastQueue } from '../lib/redis';

const pair = (x: string, y: string) => (x < y ? { aId: x, bId: y } : { aId: y, bId: x });

export const messages: FastifyPluginAsync = async (app) => {
  app.get('/conversations', { preHandler: app.auth }, async (req) =>
    prisma.conversation.findMany({
      where: { OR: [{ aId: req.user.id }, { bId: req.user.id }] },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { text: true, priceCents: true, senderId: true, createdAt: true } } },
      orderBy: { updatedAt: 'desc' }, take: 50,
    }));

  app.get('/with/:userId', { preHandler: app.auth }, async (req: any) => {
    const conv = await prisma.conversation.findUnique({ where: { aId_bId: pair(req.user.id, req.params.userId) } });
    if (!conv) return [];
    const rows = await prisma.message.findMany({ where: { conversationId: conv.id }, include: { media: true, conversation: true }, orderBy: { createdAt: 'desc' }, take: 50, skip: Number(req.query.offset ?? 0) });
    return Promise.all(rows.map(async (m) => {
      const ok = await canViewMessage(req.user.id, m);
      const { conversation, ...rest } = m;
      return { ...rest, locked: !ok, media: m.media.map(x => ok ? { id: x.id, mime: x.mime, previewKey: x.previewKey } : { id: x.id, mime: x.mime, previewKey: x.previewKey, locked: true }) };
    }));
  });

  app.post('/to/:userId', { preHandler: app.auth }, async (req: any, reply) => {
    const b = z.object({ text: z.string().max(4000).default(''), mediaIds: z.array(z.string().uuid()).max(10).default([]), priceCents: z.number().int().min(0).max(50_000).default(0) }).parse(req.body);
    const to = req.params.userId as string;
    if (to === req.user.id) return reply.code(400).send({ error: 'self' });
    const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { role: true, kycStatus: true } });
    const isCreator = me.role === 'CREATOR' && me.kycStatus === 'APPROVED';
    if (b.priceCents > 0 && (!isCreator || !b.mediaIds.length)) return reply.code(400).send({ error: 'only_creators_can_price_media' });
    // fans may only DM creators they subscribe to; creators may DM their subscribers
    const allowed = isCreator ? await isSubscribed(to, req.user.id) : await isSubscribed(req.user.id, to);
    if (!allowed) return reply.code(403).send({ error: 'subscription_required' });

    const msg = await prisma.$transaction(async (tx) => {
      const conv = await tx.conversation.upsert({ where: { aId_bId: pair(req.user.id, to) }, create: pair(req.user.id, to), update: { updatedAt: new Date() } });
      const m = await tx.message.create({ data: { conversationId: conv.id, senderId: req.user.id, text: b.text, priceCents: b.priceCents } });
      if (b.mediaIds.length) {
        const r = await tx.media.updateMany({ where: { id: { in: b.mediaIds }, ownerId: req.user.id, postId: null, messageId: null }, data: { messageId: m.id } });
        if (r.count !== b.mediaIds.length) throw Object.assign(new Error('bad_media'), { statusCode: 400 });
      }
      return tx.message.findUniqueOrThrow({ where: { id: m.id }, include: { media: { select: { id: true, mime: true, previewKey: true } } } });
    });
    await publish(to, { type: 'message', message: { ...msg, locked: msg.priceCents > 0 } });
    return msg;
  });

  app.post('/:id/unlock', { preHandler: app.auth }, async (req: any, reply) =>
    money(prisma, async (tx) => {
      const m = await tx.message.findUniqueOrThrow({ where: { id: req.params.id }, include: { conversation: true } });
      if (m.priceCents === 0 || m.senderId === req.user.id) return reply.code(400).send({ error: 'not_locked' });
      if (![m.conversation.aId, m.conversation.bId].includes(req.user.id)) return reply.code(403).send({ error: 'forbidden' });
      if (await tx.messageUnlock.findUnique({ where: { fanId_messageId: { fanId: req.user.id, messageId: m.id } } })) return { ok: true, already: true };
      await tx.messageUnlock.create({ data: { fanId: req.user.id, messageId: m.id } });
      const r = await charge(tx, { fanId: req.user.id, creatorId: m.senderId, grossCents: m.priceCents, type: 'MESSAGE_UNLOCK', refId: m.id });
      await publish(m.senderId, { type: 'unlock', messageId: m.id, by: req.user.id, ...r });
      return { ok: true, ...r };
    }));

  // Mass DM to all active subscribers (huge OF revenue feature: paid mass PPV drops)
  app.post('/broadcast', { preHandler: app.creatorOk }, async (req) => {
    const b = z.object({ text: z.string().max(4000).default(''), mediaIds: z.array(z.string().uuid()).max(10).default([]), priceCents: z.number().int().min(0).max(50_000).default(0) }).parse(req.body);
    await broadcastQueue.add('broadcast', { creatorId: req.user.id, ...b }, { removeOnComplete: true });
    return { queued: true };
  });

  // realtime: ws://host/messages/ws?token=<access jwt>
  app.get('/ws', { websocket: true }, async (socket: any, req: any) => {
    let userId: string;
    try { userId = (app.jwt.verify(req.query.token) as any).id; } catch { return socket.close(4001, 'unauthorized'); }
    const ch = `u:${userId}`;
    const listener = (channel: string, msg: string) => { if (channel === ch) socket.send(msg); };
    await sub.subscribe(ch); sub.on('message', listener);
    socket.on('close', async () => { sub.off('message', listener); await sub.unsubscribe(ch); });
  });
};
