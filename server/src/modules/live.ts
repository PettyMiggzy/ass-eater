import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { AccessToken, WebhookReceiver } from 'livekit-server-sdk';
import { prisma } from '../lib/prisma.js';
import { charge, money, FEES, zeroOrAtLeast } from '../core/ledger.js';
import { isSubscribed, creatorIsActive } from '../core/access.js';
import { serveRealtimeChannel } from '../plugins/realtime.js';
import { LK, rooms } from '../core/livekit.js';
import { ensureMinutePaid, payNextMinute } from '../core/live-billing.js';
import { startLiveStream, checkViewerOnJoin, viewerTokenTtlSeconds, hasTicket, minuteRefusal } from '../core/live-sweep.js';
import { withProfileImageUrls } from '../core/public-images.js';

let _receiver: WebhookReceiver | undefined;
const receiver = () => (_receiver ??= new WebhookReceiver(LK.key, LK.secret));

// The token gates the connect. On a per-minute stream a viewer's token lives
// only as long as their paid time (core/live-sweep.ts viewerTokenTtlSeconds),
// so a lapsed viewer's reconnect has to come back through /join, which
// charges; the participant_joined webhook and the periodic sweep remove
// anyone who gets in without paid time anyway. Other viewer tokens stay short
// so a leaked one is only good for a fresh connect for a few minutes; the
// creator's is a full session.
async function token(identity: string, room: string, publish: boolean, ttlSeconds?: number) {
  const at = new AccessToken(LK.key, LK.secret, { identity, ttl: publish ? '6h' : (ttlSeconds ?? 600) });
  at.addGrant({ roomJoin: true, room, canPublish: publish, canSubscribe: true, canPublishData: true });
  return at.toJwt();
}

export const live: FastifyPluginAsync = async (app) => {
  app.post('/start', { preHandler: app.creatorOk }, async (req, reply) => {
    const b = z.object({
      title: z.string().max(120),
      // 0 = off; otherwise at least FEES.MIN_TICKET_CENTS / MIN_PER_MINUTE_CENTS
      // so the platform's 20% never rounds down to nothing (see FEES).
      ticketPriceCents: z.number().int().min(0).max(50_000).refine(zeroOrAtLeast(FEES.MIN_TICKET_CENTS), 'ticket_min_price').default(0),
      // Capped well below the ticket cap on purpose: this is charged every
      // minute, so a fat-fingered extra zero here costs a viewer sixty times
      // more per hour than the same mistake on a ticket.
      perMinuteCents: z.number().int().min(0).max(2_000).refine(zeroOrAtLeast(FEES.MIN_PER_MINUTE_CENTS), 'per_minute_min_price').default(0),
    }).parse(req.body);
    // A stream whose room is gone (crashed browser, no webhook) is ended
    // rather than blocking the creator with already_live indefinitely; and at
    // most one LIVE stream per creator even under a double tap
    // (core/live-sweep.ts startLiveStream).
    const roomName = `live_${nanoid(10)}`;
    const started = await startLiveStream(rooms(), req.user.id, b, roomName);
    if (!started.ok) return reply.code(409).send({ error: 'already_live' });
    const s = started.stream;
    return { stream: s, token: await token(req.user.id, roomName, true), wsUrl: process.env.LIVEKIT_WS_URL };
  });

  app.post('/:id/join', { preHandler: app.auth }, async (req: any, reply) => {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s || s.status !== 'LIVE') return reply.code(404).send({ error: 'not_live' });
    if (s.creatorId === req.user.id) {
      return { token: await token(req.user.id, s.roomName, false), wsUrl: process.env.LIVEKIT_WS_URL, streamId: s.id, creatorId: s.creatorId };
    }
    // A suspended or banned creator's stream is not joinable by anyone else
    // (core/moderation.ts also ends it; this covers the moment in between).
    // Subscriptions are left ACTIVE on a suspension, so without this every
    // subscriber could keep joining a subscriber-only stream for free.
    if (!(await creatorIsActive(s.creatorId))) return reply.code(404).send({ error: 'not_live' });
    let allowed = await isSubscribed(req.user.id, s.creatorId);
    if (s.ticketPriceCents > 0) {
      const has = await prisma.liveTicket.findUnique({ where: { fanId_streamId: { fanId: req.user.id, streamId: s.id } } });
      if (!has) {
        try {
          await money(prisma, async (tx) => {
            await tx.liveTicket.create({ data: { fanId: req.user.id, streamId: s.id } });
            await charge(tx, { fanId: req.user.id, creatorId: s.creatorId, grossCents: s.ticketPriceCents, type: 'LIVE_TICKET', refId: s.id });
          });
        } catch (e) {
          // A double-clicked join races itself. LiveTicket's primary key is
          // (fanId, streamId), so the loser's insert hits a unique violation and
          // rolls its whole transaction back -- the charge with it, which is what
          // keeps the fan from paying twice. They already own the ticket the
          // winning request bought, so let them in instead of erroring out.
          //
          // The error code alone is NOT proof of that, though: charge() upserts
          // Account rows for the creator, the platform and any referrers, and
          // two *different* fans buying tickets to the same stream at the same
          // instant collide on those shared rows instead. That rolls the ticket
          // back too, so admitting on the code alone hands out a free seat to a
          // paid stream. Only the ticket actually existing proves someone paid
          // for it -- re-read it, and let a genuine conflict surface otherwise.
          if ((e as { code?: string }).code !== 'P2002') throw e;
          const bought = await prisma.liveTicket.findUnique({ where: { fanId_streamId: { fanId: req.user.id, streamId: s.id } } });
          if (!bought) throw e;
        }
      }
      allowed = true;
    }
    // A subscriber-only stream (no ticket, no per-minute price) is still for
    // subscribers only. A per-minute stream is open to anyone who pays, but
    // everyone -- subscribers included -- pays: the first minute is charged
    // here, not left to the client's goodwill.
    if (!allowed && s.perMinuteCents <= 0) return reply.code(403).send({ error: 'subscription_required' });
    let paidThrough: Date | null = null;
    if (s.perMinuteCents > 0) paidThrough = (await ensureMinutePaid(req.user.id, s)).paidThrough;
    return {
      token: await token(req.user.id, s.roomName, false, viewerTokenTtlSeconds(s.perMinuteCents, paidThrough)), wsUrl: process.env.LIVEKIT_WS_URL, streamId: s.id, creatorId: s.creatorId,
      perMinuteCents: s.perMinuteCents, paidThrough,
    };
  });

  /**
   * Buy the next minute of a per-minute stream (core/live-billing.ts).
   *
   * Billed a minute at a time IN ADVANCE; the client calls this on a timer
   * while watching, and core/live-sweep.ts removes a viewer from the room
   * once their paid time runs out, so skipping it ends the stream for them
   * rather than making it free. Advance billing is the safe direction: the
   * worst case is a viewer paying for up to one minute they did not finish.
   * The minute number is decided server-side, never sent by the client.
   */
  app.post('/:id/minute', { preHandler: app.auth }, async (req: any, reply) => {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s || s.status !== 'LIVE') return reply.code(404).send({ error: 'not_live' });
    if (s.perMinuteCents <= 0) return reply.code(400).send({ error: 'not_per_minute' });
    // A creator watching their own stream is not a customer of it.
    if (s.creatorId === req.user.id) return { paidMinutes: null, perMinuteCents: 0 };
    // The same entitlement /join applies, because this also hands out a room
    // token. On a stream with a ticket price the ticket comes FIRST (bought
    // through /join); without this check a fan skipped /join, called this
    // once a minute and watched a $50-ticket stream for the per-minute price.
    // And a suspended/banned creator's stream is not joinable at all.
    const refused = await minuteRefusal(req.user.id, s);
    if (refused) return reply.code(refused === 'not_live' ? 404 : 403).send({ error: refused });
    const r = await payNextMinute(req.user.id, s);
    // A fresh token covering the time just bought: the one /join issued ends
    // with the viewer's earlier paid time, so a reconnect needs this one.
    return {
      paidMinutes: r.paidMinutes, paidThrough: r.paidThrough, perMinuteCents: s.perMinuteCents,
      token: await token(req.user.id, s.roomName, false, viewerTokenTtlSeconds(s.perMinuteCents, r.paidThrough)),
    };
  });

  app.post('/:id/end', { preHandler: app.auth }, async (req: any) => {
    const s = await prisma.liveStream.findFirst({ where: { id: req.params.id, creatorId: req.user.id, status: 'LIVE' } });
    if (s) { await rooms().deleteRoom(s.roomName).catch(() => {}); await prisma.liveStream.update({ where: { id: s.id }, data: { status: 'ENDED', endedAt: new Date() } }); }
    return { ok: true };
  });

  app.get('/active', async () =>
    // A suspended or banned creator's stream is not listed.
    (await prisma.liveStream.findMany({ where: { status: 'LIVE', creator: { user: { status: 'ACTIVE' } } }, include: { creator: { select: { displayName: true, avatarKey: true, user: { select: { username: true } } } }, _count: { select: { tickets: true } } } }))
      .map((s) => ({ ...s, creator: withProfileImageUrls(s.creator) })));

  // LiveKit → us. Needs raw body for signature check.
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  app.post('/webhook', async (req: any, reply) => {
    let evt; try { evt = await receiver().receive(req.body, req.headers.authorization); } catch { return reply.code(401).send(); }
    if (evt.event === 'room_finished' && evt.room?.name)
      await prisma.liveStream.updateMany({ where: { roomName: evt.room.name, status: 'LIVE' }, data: { status: 'ENDED', endedAt: new Date() } });
    // A (re)joining viewer with no paid time left -- including one whose
    // token LiveKit refreshed while they were connected -- is removed now,
    // not at the next sweep. Enable participant_joined on the LiveKit
    // webhook for this to run.
    if (evt.event === 'participant_joined' && evt.room?.name && evt.participant?.identity) {
      try { await checkViewerOnJoin(rooms(), evt.room.name, evt.participant.identity); }
      catch (err) { req.log.error({ err, room: evt.room.name }, 'live webhook: join check failed'); }
    }
    return { ok: true };
  });

  // tip overlay feed for a stream: wss://host/live/:id/events, then send
  // {"type":"auth","token":"<access jwt>"} first (see plugins/realtime.ts).
  app.get('/:id/events', { websocket: true }, (socket: any, req: any) => {
    const id = String(req.params.id ?? '');
    // publish() prefixes with "u:" — tips.ts publishes to `stream:<id>`
    // Only someone who could watch the stream gets its overlay feed -- the
    // same entitlement /join applies: the creator; on a ticketed stream a
    // ticket holder (and nobody else, subscribers included, since /join
    // charges them the ticket too); otherwise a subscriber, or a viewer with
    // paid minutes on a per-minute stream.
    serveRealtimeChannel(app, socket, async (user) => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const s = await prisma.liveStream.findUnique({ where: { id }, select: { id: true, creatorId: true, ticketPriceCents: true, perMinuteCents: true } });
      if (!s) return null;
      if (s.creatorId === user.id) return `u:stream:${id}`;
      if (!(await creatorIsActive(s.creatorId))) return null;
      let ok: boolean;
      if (s.ticketPriceCents > 0) ok = await hasTicket(user.id, s.id);
      else ok = (await isSubscribed(user.id, s.creatorId))
        || (s.perMinuteCents > 0 && !!(await prisma.liveMinute.findFirst({ where: { fanId: user.id, streamId: s.id }, select: { minuteIndex: true } })));
      return ok ? `u:stream:${id}` : null;
    });
  });
};
