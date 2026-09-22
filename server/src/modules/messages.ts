import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { charge, money, isVip, FEES } from '../core/ledger.js';
import { canViewMessage, isSubscribed } from '../core/access.js';
import { publish, sub, broadcastQueue } from '../lib/redis.js';
import { notifyDmReceived } from '../core/notify.js';

const pair = (x: string, y: string) => (x < y ? { aId: x, bId: y } : { aId: y, bId: x });

/**
 * Charges a fan for a priced message and records the unlock. Exported (not
 * inlined in the route) so the double-click race below is directly
 * testable against a real Postgres connection, mirroring
 * posts.ts's `unlockPost` -- see that function's comment for why the
 * re-read on P2002 has to run on `prisma`, never on the failed `tx`.
 *
 * Caller must already have confirmed the fan hasn't unlocked this message
 * yet -- that pre-check is cheap and common, but does NOT close the race:
 * two concurrent requests can both pass it before either commits.
 */
export async function unlockMessage(fanId: string, message: { id: string; senderId: string; priceCents: number }) {
  try {
    return await money(prisma, async (tx) => {
      await tx.messageUnlock.create({ data: { fanId, messageId: message.id } });
      const r = await charge(tx, { fanId, creatorId: message.senderId, grossCents: message.priceCents, type: 'MESSAGE_UNLOCK', refId: message.id });
      return { ok: true, ...r };
    });
  } catch (e: any) {
    if (e.code !== 'P2002') throw e;
    const bought = await prisma.messageUnlock.findUnique({ where: { fanId_messageId: { fanId, messageId: message.id } } });
    if (!bought) throw e;
    return { ok: true, already: true };
  }
}

export const messages: FastifyPluginAsync = async (app) => {
  app.get('/conversations', { preHandler: app.auth }, async (req) => {
    const convs = await prisma.conversation.findMany({
      where: { OR: [{ aId: req.user.id }, { bId: req.user.id }] },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, text: true, priceCents: true, senderId: true, createdAt: true } } },
      orderBy: { updatedAt: 'desc' }, take: 50,
    });
    // The inbox preview is the conversation's own latest message, which may
    // itself be a priced one the viewer hasn't unlocked -- redact its text
    // the same way GET /with/:userId does, or a priced message is readable
    // straight off the conversation list without ever opening the thread.
    const rows = await Promise.all(convs.map(async (c) => {
      // Who the viewer is talking TO. A VIP's thread is flagged and sorted up
      // so a creator with a full inbox sees their members first -- the thing
      // a fan most wants for their money is a reply, and the creator wants
      // their best customers surfaced. Purely an ordering hint: it changes
      // nothing about what either side can read.
      const otherId = c.aId === req.user.id ? c.bId : c.aId;
      const otherIsVip = await isVip(prisma, otherId);
      return {
        ...c,
        otherIsVip,
        messages: await Promise.all(c.messages.map(async (m) => {
          const ok = await canViewMessage(req.user.id, { id: m.id, senderId: m.senderId, priceCents: m.priceCents, conversation: { aId: c.aId, bId: c.bId } });
          return { ...m, text: ok ? m.text : '', locked: !ok };
        })),
      };
    }));

    // VIP threads first, then most recently active within each group. The
    // secondary sort has to stay -- ordering by VIP alone would scramble an
    // inbox into an arbitrary order every time someone subscribed or lapsed.
    return rows.sort((a, b) =>
      (b.otherIsVip ? 1 : 0) - (a.otherIsVip ? 1 : 0) ||
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  });

  app.get('/with/:userId', { preHandler: app.auth }, async (req: any) => {
    const conv = await prisma.conversation.findUnique({ where: { aId_bId: pair(req.user.id, req.params.userId) } });
    if (!conv) return [];
    const rows = await prisma.message.findMany({ where: { conversationId: conv.id }, include: { media: true, conversation: true }, orderBy: { createdAt: 'desc' }, take: 50, skip: Number(req.query.offset ?? 0) });
    return Promise.all(rows.map(async (m) => {
      const ok = await canViewMessage(req.user.id, m);
      const { conversation, text, ...rest } = m;
      // A priced message's own text is now a paywalled good in its own right
      // (not just a free teaser caption alongside priced media, now that
      // plain-text messages can be priced too) -- redact it the same way
      // media previews already are until it's unlocked or free.
      return { ...rest, text: ok ? text : '', locked: !ok, media: m.media.map(x => ok ? { id: x.id, mime: x.mime, previewKey: x.previewKey } : { id: x.id, mime: x.mime, previewKey: x.previewKey, locked: true }) };
    }));
  });

  app.post('/to/:userId', { preHandler: app.auth }, async (req: any, reply) => {
    const b = z.object({ text: z.string().max(4000).default(''), mediaIds: z.array(z.string().uuid()).max(10).default([]), priceCents: z.number().int().min(0).max(50_000).default(0) }).parse(req.body);
    const to = req.params.userId as string;
    if (to === req.user.id) return reply.code(400).send({ error: 'self' });
    const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { role: true, kycStatus: true } });
    const isCreator = me.role === 'CREATOR' && me.kycStatus === 'APPROVED';
    // Any message can be priced -- plain text included, not just media
    // attachments -- as long as the sender is a KYC'd creator.
    if (b.priceCents > 0 && !isCreator) return reply.code(400).send({ error: 'only_creators_can_price_messages' });
    // fans may only DM creators they subscribe to; creators may DM their subscribers
    const allowed = isCreator ? await isSubscribed(to, req.user.id) : await isSubscribed(req.user.id, to);
    if (!allowed) return reply.code(403).send({ error: 'subscription_required' });

    // What a fan pays to land a message in a creator's inbox.
    //
    // Decided 2026-09-20: messaging a creator is never free. The important
    // part is WHERE the money goes -- to the CREATOR, less the standard 10%,
    // exactly like a tip. It is not a platform toll on talking, and it is
    // not a subscription to own an inbox. That distinction is the whole
    // reason this shape is worth having: the fan's money reaches the person
    // they were trying to reach, the creator prices their own attention, and
    // it prices out bulk junk far harder than a flat monthly fee would.
    //
    // The floor is read live from PlatformConfig rather than baked into each
    // creator's row, so changing it re-prices everyone sitting on the
    // minimum without a migration.
    let sendFeeCents = 0;
    if (!isCreator) {
      const [cfg, target] = await Promise.all([
        prisma.platformConfig.findUnique({ where: { id: 1 }, select: { minDmPriceCents: true } }),
        prisma.creatorProfile.findUnique({ where: { userId: to }, select: { inboundDmPriceCents: true } }),
      ]);
      const floor = cfg?.minDmPriceCents ?? FEES.MIN_DM_PRICE_CENTS;
      // max(), not ??: a creator who set a price BELOW a floor that has since
      // risen must not keep the old one, and null means "just use the floor".
      sendFeeCents = Math.max(floor, target?.inboundDmPriceCents ?? 0);
    }

    // money(), not a plain $transaction: this now moves money, and every
    // other charge path on the platform runs Serializable with a retry on
    // serialization failure. Leaving this one at the default isolation would
    // make the balance check weaker here than anywhere else that spends it.
    const msg = await money(prisma, async (tx) => {
      // Charged inside the same transaction that writes the message, so a
      // failure anywhere below cannot leave a fan paying for a message that
      // was never delivered.
      if (sendFeeCents > 0) {
        await charge(tx, { fanId: req.user.id, creatorId: to, grossCents: sendFeeCents, type: 'DM_SEND', refId: `dm:${req.user.id}:${Date.now()}` });
      }
      const conv = await tx.conversation.upsert({ where: { aId_bId: pair(req.user.id, to) }, create: pair(req.user.id, to), update: { updatedAt: new Date() } });
      const m = await tx.message.create({ data: { conversationId: conv.id, senderId: req.user.id, text: b.text, priceCents: b.priceCents } });
      if (b.mediaIds.length) {
        const r = await tx.media.updateMany({ where: { id: { in: b.mediaIds }, ownerId: req.user.id, postId: null, messageId: null }, data: { messageId: m.id } });
        if (r.count !== b.mediaIds.length) throw Object.assign(new Error('bad_media'), { statusCode: 400 });
      }
      return tx.message.findUniqueOrThrow({ where: { id: m.id }, include: { media: { select: { id: true, mime: true, previewKey: true } } } });
    });
    // Notify the recipient, OUTSIDE the transaction above and deliberately
    // not awaited into the response.
    //
    // Outside, because a mail provider being slow or down must never roll
    // back a message the fan already paid to send. Not awaited, because the
    // sender should not wait on someone else's SMTP to see their own
    // message appear. Errors are logged and dropped: the Notification row
    // is written either way, so the recipient still sees it in-app.
    void notifyDmReceived({
      recipientId: to,
      actorId: req.user.id,
      messageId: msg.id,
      siteUrl: process.env.SITE_URL || 'https://www.joinonlyone.com',
    }).catch((e) => req.log.error({ err: e }, 'dm notification failed'));

    // The realtime push goes to the recipient, who hasn't paid/unlocked yet
    // -- redact the same way the GET /with/:userId REST path does, so a
    // priced message's text/media can't be read straight off the websocket.
    const locked = msg.priceCents > 0;
    await publish(to, {
      type: 'message',
      message: {
        ...msg,
        text: locked ? '' : msg.text,
        media: msg.media.map((x) => (locked ? { id: x.id, mime: x.mime, previewKey: x.previewKey, locked: true } : x)),
        locked,
      },
    });
    return msg;
  });

  app.post('/:id/unlock', { preHandler: app.auth }, async (req: any, reply) => {
    const m = await prisma.message.findUniqueOrThrow({ where: { id: req.params.id }, include: { conversation: true } });
    if (m.priceCents === 0 || m.senderId === req.user.id) return reply.code(400).send({ error: 'not_locked' });
    if (![m.conversation.aId, m.conversation.bId].includes(req.user.id)) return reply.code(403).send({ error: 'forbidden' });
    if (await prisma.messageUnlock.findUnique({ where: { fanId_messageId: { fanId: req.user.id, messageId: m.id } } })) return { ok: true, already: true };
    const result = await unlockMessage(req.user.id, m);
    await publish(m.senderId, { type: 'unlock', messageId: m.id, by: req.user.id, ...result });
    return result;
  });

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
