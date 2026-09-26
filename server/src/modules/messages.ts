import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createHash } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { charge, money, isVip, FEES, zeroOrAtLeast, type Tx } from '../core/ledger.js';
import { canViewMessage, isSubscribed, creatorMayOperate } from '../core/access.js';
import { publish, broadcastQueue } from '../lib/redis.js';
import { serveRealtimeChannel } from '../plugins/realtime.js';
import { notifyDmReceived } from '../core/notify.js';
import { page } from '../plugins/pagination.js';
import { fileReport, broadcastTakenDown } from '../core/reports.js';
import { assertNotPublicImages } from '../core/public-images.js';

const pair = (x: string, y: string) => (x < y ? { aId: x, bId: y } : { aId: y, bId: x });

/**
 * Deterministic broadcast id for one creator's request key: the same request
 * retried always yields the same id, two creators' identical keys never
 * collide. Hex only -- it becomes part of a BullMQ jobId, which must not
 * contain ':'.
 */
export const broadcastIdFor = (creatorId: string, requestId: string) =>
  createHash('sha256').update(`broadcast\0${creatorId}\0${requestId}`).digest('hex').slice(0, 32);

/** What a broadcast says: text, price and (order-free) attachments. */
export const broadcastContentHash = (c: { text: string; priceCents: number; mediaIds: string[] }) =>
  createHash('sha256').update(JSON.stringify([c.text, c.priceCents, [...new Set(c.mediaIds)].sort()])).digest('hex');

/**
 * Is this broadcastId (i.e. this creator's requestId) already in use for
 * DIFFERENT content? A requestId identifies one intended drop, reused only
 * for retries of it -- the same contract as a DM's requestId and a tip's
 * idempotency key, both of which refuse a reused key with different
 * content. Checks the live queued job (an add under an existing jobId is
 * silently ignored by BullMQ, so an edited drop would never go out) and the
 * copies already delivered (jobs are removed on completion, and a re-run
 * skips every fan already reached, so an edited drop would reach only the
 * fans the first one missed).
 */
export async function broadcastReuseConflict(
  queue: { getJob: (id: string) => Promise<{ data?: any } | null | undefined> },
  creatorId: string, broadcastId: string, contentHash: string,
): Promise<boolean> {
  const job = await queue.getJob(`broadcast-${broadcastId}`);
  if (job) {
    const d = job.data ?? {};
    const h = typeof d.contentHash === 'string' ? d.contentHash
      : broadcastContentHash({ text: String(d.text ?? ''), priceCents: Number(d.priceCents ?? 0), mediaIds: Array.isArray(d.mediaIds) ? d.mediaIds : [] });
    if (h !== contentHash) return true;
  }
  const sent = await prisma.message.findFirst({
    where: { senderId: creatorId, broadcastId },
    select: { text: true, priceCents: true, media: { select: { sourceMediaId: true } } },
  });
  if (sent) {
    const h = broadcastContentHash({ text: sent.text, priceCents: sent.priceCents, mediaIds: sent.media.map((m) => m.sourceMediaId).filter((x): x is string => !!x) });
    if (h !== contentHash) return true;
  }
  return false;
}

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
      // Nothing is sold unless something viewable is behind the paywall --
      // the same rule as a PPV post (posts.ts postHasDeliverable) and a
      // listing (core/auctions.ts hasDeliverable). Re-read inside the
      // charge's transaction, never trusted from the caller's copy: a
      // takedown REJECTs a broadcast's media on every subscriber's copy and a
      // report resolve blanks a message, and neither touched the price, so
      // fans paid full price for an empty message.
      if (!(await messageHasDeliverable(tx, message.id))) throw Object.assign(new Error('no_deliverable'), { statusCode: 409 });
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

/**
 * Is there something a buyer of this priced message would actually get?
 * Every attached media item must be READY (canViewMedia refuses anything
 * else), and a message with no media must have text.
 */
export async function messageHasDeliverable(tx: Tx, messageId: string) {
  const m = await tx.message.findUnique({ where: { id: messageId }, select: { text: true, priceCents: true, media: { select: { status: true } } } });
  if (!m || m.priceCents <= 0) return false;
  if (m.media.some((x) => x.status !== 'READY')) return false;
  return m.media.length > 0 || m.text.trim().length > 0;
}

const SENT_INCLUDE = { media: { select: { id: true, mime: true, previewKey: true } }, conversation: { select: { aId: true, bId: true } } } as const;

/**
 * Writes one direct message (and, for a fan sender, charges the send fee) in a
 * single money() transaction, at most once per (sender, requestId). Exported
 * so the idempotency is testable against a real Postgres, like unlockPost.
 * Authorization (who may message whom, who may price) is the route's job.
 */
/**
 * How a direct message from `senderId` to `to` is sent, or null if it may
 * not be: 'creator' when an operating creator writes to their own
 * subscriber (free, may be priced); 'fan' when the sender subscribes to the
 * recipient (a paid DM into a creator's inbox) -- which includes a creator
 * messaging a creator they subscribe to.
 */
export async function dmSendRole(senderId: string, to: string, senderIsOperatingCreator: boolean): Promise<'creator' | 'fan' | null> {
  if (senderIsOperatingCreator && await isSubscribed(to, senderId)) return 'creator';
  if (await isSubscribed(senderId, to)) return 'fan';
  return null;
}

export async function sendDirectMessage(
  senderId: string, to: string, isCreator: boolean,
  b: { text: string; mediaIds: string[]; priceCents: number; expectedPriceCents?: number; requestId?: string },
) {
  // money(), not a plain $transaction: this now moves money, and every
  // other charge path on the platform runs Serializable with a retry on
  // serialization failure. Leaving this one at the default isolation would
  // make the balance check weaker here than anywhere else that spends it.
  //
  // A retry of a send that already went through returns it before anything
  // else is re-checked: the price may have moved since, and the retry must
  // not answer price_changed for a message that was delivered and paid for.
  if (b.requestId) {
    const prior = await prisma.dmSendRequest.findUnique({ where: { senderId_key: { senderId, key: b.requestId } } });
    if (prior?.messageId) return { msg: await prisma.message.findUniqueOrThrow({ where: { id: prior.messageId }, include: SENT_INCLUDE }), already: true };
  }
  try {
    const msg = await money(prisma, async (tx) => {
      // The idempotency row goes in FIRST, before the price check, the
      // charge and the media re-homing. A concurrent duplicate (a double-tap,
      // or a retry while the first is still in flight) then always collides
      // on its primary key and takes the replay path below. Inserted last,
      // the duplicate blocked on the fan's Account row instead, lost the
      // serialization race, and money() re-ran it against the committed
      // state -- where it failed with insufficient_funds (the first send had
      // spent the balance) or bad_media (the photo was now on the first
      // message) for a message that had in fact been delivered and paid for.
      if (b.requestId) await tx.dmSendRequest.create({ data: { senderId, key: b.requestId, messageId: null } });
      // The price is read INSIDE this transaction and compared with the one
      // the fan confirmed, so nothing that moves it between their click and
      // this charge can make them pay a price they didn't see.
      let sendFeeCents = 0;
      if (!isCreator) {
        const [cfg, target] = await Promise.all([
          tx.platformConfig.findUnique({ where: { id: 1 }, select: { minDmPriceCents: true } }),
          tx.creatorProfile.findUnique({ where: { userId: to }, select: { inboundDmPriceCents: true } }),
        ]);
        const floor = cfg?.minDmPriceCents ?? FEES.MIN_DM_PRICE_CENTS;
        // max(), not ??: a creator who set a price BELOW a floor that has since
        // risen must not keep the old one, and null means "just use the floor".
        sendFeeCents = Math.max(floor, target?.inboundDmPriceCents ?? 0);
        if (sendFeeCents !== b.expectedPriceCents) {
          throw Object.assign(new Error('price_changed'), { statusCode: 409, priceCents: sendFeeCents });
        }
      }
      // Charged inside the same transaction that writes the message, so a
      // failure anywhere below cannot leave a fan paying for a message that
      // was never delivered.
      if (sendFeeCents > 0) {
        await charge(tx, { fanId: senderId, creatorId: to, grossCents: sendFeeCents, type: 'DM_SEND', refId: `dm:${senderId}:${b.requestId ?? Date.now()}` });
      }
      const conv = await tx.conversation.upsert({ where: { aId_bId: pair(senderId, to) }, create: pair(senderId, to), update: { updatedAt: new Date() } });
      const m = await tx.message.create({ data: { conversationId: conv.id, senderId: senderId, text: b.text, priceCents: b.priceCents } });
      if (b.mediaIds.length) {
        // Stricter than a mass DM (POST /broadcast), which copies its media
        // and so may reuse a post's or DM's item: a single DM re-homes the
        // original itself, so every attachment must be the sender's own
        // unattached original -- never media already sold
        // as a listing's product (re-homing it cut the listing's buyers off,
        // core/access.ts canViewMedia) or someone's broadcast copy -- and
        // READY. A priced DM used to accept an upload still UPLOADING, which
        // could later be swept or REJECTED: the fan paid for a message whose
        // media never became viewable.
        const ids = [...new Set(b.mediaIds)];
        if (ids.length !== b.mediaIds.length) throw Object.assign(new Error('bad_media'), { statusCode: 400 });
        const found = await tx.media.findMany({ where: { id: { in: ids }, ownerId: senderId, postId: null, messageId: null, listingId: null, sourceMediaId: null }, select: { status: true } });
        if (found.length !== ids.length) throw Object.assign(new Error('bad_media'), { statusCode: 400 });
        if (found.some((x) => x.status !== 'READY')) throw Object.assign(new Error('media_not_ready'), { statusCode: 400 });
        // Never an avatar, banner or listing preview photo (free to everyone,
        // core/public-images.ts).
        await assertNotPublicImages(tx, ids);
        const r = await tx.media.updateMany({ where: { id: { in: ids }, ownerId: senderId, postId: null, messageId: null, listingId: null, sourceMediaId: null, status: 'READY' }, data: { messageId: m.id } });
        if (r.count !== ids.length) throw Object.assign(new Error('bad_media'), { statusCode: 400 });
      }
      // Keyed on (sender, requestId) -- inserted at the top of this
      // transaction; the message it produced is recorded now.
      if (b.requestId) await tx.dmSendRequest.update({ where: { senderId_key: { senderId, key: b.requestId } }, data: { messageId: m.id } });
      return tx.message.findUniqueOrThrow({ where: { id: m.id }, include: SENT_INCLUDE });
    });
    return { msg, already: false };
  } catch (e: any) {
    // As in tips.ts chargeTip: P2002 alone is not proof of a replay
    // (charge() and the conversation upsert touch rows other requests can
    // collide on), so the re-read decides -- on `prisma`, never on the
    // rolled-back transaction.
    if (e?.code !== 'P2002' || !b.requestId) throw e;
    const prior = await prisma.dmSendRequest.findUnique({ where: { senderId_key: { senderId, key: b.requestId } } });
    if (!prior?.messageId) throw e;
    const msg = await prisma.message.findUniqueOrThrow({ where: { id: prior.messageId }, include: SENT_INCLUDE });
    return { msg, already: true };
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
    const rows = await prisma.message.findMany({ where: { conversationId: conv.id }, include: { media: true, conversation: true }, orderBy: { createdAt: 'desc' }, take: 50, skip: page(req.query).offset });
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
    const b = z.object({
      text: z.string().max(4000).default(''), mediaIds: z.array(z.string().uuid()).max(10).default([]),
      // 0 = free; a priced message is at least FEES.MIN_PRICED_MESSAGE_CENTS so
      // the platform's 10% cannot round down to nothing (see FEES).
      priceCents: z.number().int().min(0).max(50_000).refine(zeroOrAtLeast(FEES.MIN_PRICED_MESSAGE_CENTS), 'message_min_price').default(0),
      // What a fan was shown as the price of sending this (the creator's
      // published dmPriceCents, floored). Required for fan senders: the
      // creator can change their price, and an admin the floor, between the
      // fan reading it and pressing send -- a click must never buy at a
      // price nobody saw. Ignored for creator senders, who pay nothing.
      expectedPriceCents: z.number().int().min(0).max(50_000).optional(),
      // A fresh uuid per message the sender intends, REUSED on any retry of
      // that same message -- same contract as a tip's idempotencyKey
      // (modules/tips.ts chargeTip). Required for fan senders, whose send is
      // charged: without it a retry after a lost response, or a double-tap,
      // charged again and delivered a duplicate. Optional for creators.
      requestId: z.string().uuid().optional(),
    }).parse(req.body);
    const to = req.params.userId as string;
    if (to === req.user.id) return reply.code(400).send({ error: 'self' });
    const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { role: true, kycStatus: true, siteUid: true, siteCreatorStatus: true } });
    const operatingCreator = me.role === 'CREATOR' && creatorMayOperate(me);
    // Who may message whom is decided by the subscription, in EITHER
    // direction -- not by the sender's role alone. A creator may DM their own
    // subscribers (free, and may price the message); anyone -- a creator
    // included -- may DM a creator THEY subscribe to, and that send is a
    // paid fan->creator DM. Deciding from the role alone checked the wrong
    // direction for a creator acting as a fan: an approved creator who
    // subscribed to another creator was refused subscription_required and
    // could not reach them even by paying the DM fee.
    const role = await dmSendRole(req.user.id, to, operatingCreator);
    if (!role) return reply.code(403).send({ error: 'subscription_required' });
    // true: the creator side of a creator->subscriber DM (free, may be
    // priced). false: a paid DM into a creator's inbox.
    const isCreator = role === 'creator';
    // Any message can be priced -- plain text included, not just media
    // attachments -- as long as it is a KYC'd creator writing to their own
    // subscriber.
    if (b.priceCents > 0 && !isCreator) return reply.code(400).send({ error: 'only_creators_can_price_messages' });
    // A priced message must have something in it -- same rule as POST
    // /broadcast and a PPV post. (unlockMessage refuses an empty one at
    // unlock time too; this stops it being sent at all.)
    if (b.priceCents > 0 && !b.mediaIds.length && !b.text.trim()) return reply.code(400).send({ error: 'empty_message' });

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
    if (!isCreator && b.expectedPriceCents === undefined) {
      return reply.code(400).send({ error: 'expected_price_required' });
    }
    if (!isCreator && !b.requestId) return reply.code(400).send({ error: 'request_id_required' });

    const sent = await sendDirectMessage(req.user.id, to, isCreator, b);
    if (sent.already) {
      // A replay of a message already sent (and, for a fan, already paid
      // for): the same message back, with no second charge, notification or
      // realtime push. A key reused for a DIFFERENT recipient is a client
      // bug, not a retry -- refuse it rather than claim delivery.
      const conv = sent.msg.conversation;
      if (![conv.aId, conv.bId].includes(to)) return reply.code(409).send({ error: 'request_id_reused' });
      const { conversation: _c, ...prior } = sent.msg;
      return { ...prior, already: true };
    }
    const { conversation: _conv, ...msg } = sent.msg;

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

  // Report a message you RECEIVED (the likeliest route for non-consensual
  // intimate content on this stack). Only its recipient -- the other
  // participant, never the sender -- may report it.
  app.post('/:id/report', { preHandler: app.auth, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req: any, reply) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    const m = await prisma.message.findUnique({ where: { id: String(req.params.id ?? '') }, include: { conversation: { select: { aId: true, bId: true } } } });
    if (!m || m.senderId === req.user.id || ![m.conversation.aId, m.conversation.bId].includes(req.user.id)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return fileReport(req.user.id, 'message', m.id, reason);
  });

  // Report a person you have a conversation with (harassment, a fan or a
  // creator). Limited to someone who has actually interacted with you, so
  // the queue can't be flooded with reports against arbitrary accounts.
  app.post('/with/:userId/report', { preHandler: app.auth, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req: any, reply) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    const other = String(req.params.userId ?? '');
    if (other === req.user.id) return reply.code(400).send({ error: 'self' });
    const conv = await prisma.conversation.findUnique({ where: { aId_bId: pair(req.user.id, other) }, select: { id: true } });
    if (!conv) return reply.code(404).send({ error: 'not_found' });
    return fileReport(req.user.id, 'user', other, reason);
  });

  // Mass DM to all active subscribers (huge OF revenue feature: paid mass PPV drops)
  app.post('/broadcast', { preHandler: app.creatorOk }, async (req, reply) => {
    const b = z.object({
      text: z.string().max(4000).default(''), mediaIds: z.array(z.string().uuid()).max(10).default([]),
      priceCents: z.number().int().min(0).max(50_000).refine(zeroOrAtLeast(FEES.MIN_PRICED_MESSAGE_CENTS), 'message_min_price').default(0),
      // A fresh uuid per broadcast the creator intends, REUSED on any retry
      // of it (same contract as a DM's requestId). Required: a random
      // server-side id made every double-tap a second job, and every
      // subscriber got two identical priced messages, each chargeable.
      requestId: z.string().uuid(),
    }).parse(req.body);
    // Every requested attachment must exist, belong to this creator, be an
    // original (not someone's broadcast copy), not be a marketplace listing's
    // product (listingId -- copying a sold one-of-a-kind item out to every
    // subscriber would break its buyer's exclusivity and sell it twice), and
    // be READY. Re-checked by workers/broadcast.ts at send time. The worker used
    // to filter silently to what was ready and send the priced message
    // anyway, so a creator broadcasting straight after an upload (transcodes
    // take minutes) sold every subscriber an empty message at full price.
    const ids = [...new Set(b.mediaIds)];
    if (ids.length !== b.mediaIds.length) return reply.code(400).send({ error: 'bad_media' });
    if (ids.length) {
      const found = await prisma.media.findMany({ where: { id: { in: ids }, ownerId: req.user.id, listingId: null, sourceMediaId: null }, select: { status: true } });
      if (found.length !== ids.length) return reply.code(400).send({ error: 'bad_media' });
      if (found.some((m) => m.status !== 'READY')) return reply.code(400).send({ error: 'media_not_ready' });
      // Not an avatar, banner or listing preview photo: those are free to
      // everyone, unwatermarked (core/public-images.ts).
      await assertNotPublicImages(prisma, ids);
    }
    if (b.priceCents > 0 && !ids.length && !b.text.trim()) return reply.code(400).send({ error: 'empty_message' });
    // broadcastId makes the job resumable: workers/broadcast.ts writes it on
    // every message it sends and a retry skips fans that already have it, so
    // attempts > 1 can never double-send (or double-charge) a PPV drop.
    //
    // Derived from (creator, requestId), never random: a repeated request
    // maps to the same broadcastId, so BullMQ drops it while the first job
    // exists (same jobId) and, after that job is gone, the worker's
    // (conversationId, broadcastId) unique index skips every fan it already
    // reached.
    //
    // Neither completed NOR failed jobs are retained (removeOn*: true), the
    // same rule as core/payout-queue.ts: BullMQ ignores add() for a jobId it
    // still holds in ANY state, so a failed job kept around (it used to be
    // removeOnFail: 100) swallowed the documented retry -- the creator got
    // {queued:true} and the subscribers the failed run never reached never
    // got the drop. A re-run is safe: the per-conversation broadcastId unique
    // index skips every fan already reached.
    const { requestId, ...content } = b;
    const broadcastId = broadcastIdFor(req.user.id, requestId);
    // A drop an admin already took down is never re-queued under the same
    // request (the worker refuses it too -- workers/broadcast.ts).
    if (await broadcastTakenDown(req.user.id, broadcastId)) return reply.code(409).send({ error: 'broadcast_removed' });
    // A requestId reused for an EDITED drop is refused, never answered
    // queued:true while the edit is dropped or half-delivered. Checked again
    // after the add: two concurrent requests with different content both
    // pass the first check, and BullMQ keeps only the first add.
    const contentHash = broadcastContentHash(content);
    if (await broadcastReuseConflict(broadcastQueue, req.user.id, broadcastId, contentHash)) return reply.code(409).send({ error: 'request_id_reused' });
    await broadcastQueue.add('broadcast', { creatorId: req.user.id, broadcastId, ...content, contentHash }, {
      jobId: `broadcast-${broadcastId}`, attempts: 5, backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: true, removeOnFail: true,
    });
    if (await broadcastReuseConflict(broadcastQueue, req.user.id, broadcastId, contentHash)) return reply.code(409).send({ error: 'request_id_reused' });
    return { queued: true, broadcastId };
  });

  // realtime: wss://host/messages/ws, then send {"type":"auth","token":"<access jwt>"}
  // as the first message -- never the token in the URL (see plugins/realtime.ts).
  app.get('/ws', { websocket: true }, (socket: any) => {
    serveRealtimeChannel(app, socket, (user) => `u:${user.id}`);
  });
};
