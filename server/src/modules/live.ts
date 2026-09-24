import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { AccessToken, WebhookReceiver } from 'livekit-server-sdk';
import { prisma } from '../lib/prisma.js';
import { charge, money } from '../core/ledger.js';
import { isSubscribed } from '../core/access.js';
import { serveRealtimeChannel } from '../plugins/realtime.js';
import { LK, rooms } from '../core/livekit.js';
import { ensureMinutePaid, payNextMinute } from '../core/live-billing.js';
import { endStaleStreamFor } from '../core/live-sweep.js';

let _receiver: WebhookReceiver | undefined;
const receiver = () => (_receiver ??= new WebhookReceiver(LK.key, LK.secret));

// The token only gates the initial connect, so its lifetime is not what
// bills a viewer -- core/live-sweep.ts removes a per-minute viewer whose paid
// time lapses. A viewer's token is still kept short so a leaked one is only
// good for a fresh connect for a few minutes; the creator's is a full session.
async function token(identity: string, room: string, publish: boolean) {
  const at = new AccessToken(LK.key, LK.secret, { identity, ttl: publish ? '6h' : '10m' });
  at.addGrant({ roomJoin: true, room, canPublish: publish, canSubscribe: true, canPublishData: true });
  return at.toJwt();
}

export const live: FastifyPluginAsync = async (app) => {
  app.post('/start', { preHandler: app.creatorOk }, async (req, reply) => {
    const b = z.object({
      title: z.string().max(120),
      ticketPriceCents: z.number().int().min(0).max(50_000).default(0),
      // Capped well below the ticket cap on purpose: this is charged every
      // minute, so a fat-fingered extra zero here costs a viewer sixty times
      // more per hour than the same mistake on a ticket.
      perMinuteCents: z.number().int().min(0).max(2_000).default(0),
    }).parse(req.body);
    // A stream whose room is gone (crashed browser, no webhook) is ended here
    // rather than blocking the creator with already_live indefinitely.
    if (await endStaleStreamFor(rooms(), req.user.id)) return reply.code(409).send({ error: 'already_live' });
    const roomName = `live_${nanoid(10)}`;
    await rooms().createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 5000 });
    const s = await prisma.liveStream.create({ data: { creatorId: req.user.id, roomName, ...b } });
    return { stream: s, token: await token(req.user.id, roomName, true), wsUrl: process.env.LIVEKIT_WS_URL };
  });

  app.post('/:id/join', { preHandler: app.auth }, async (req: any, reply) => {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s || s.status !== 'LIVE') return reply.code(404).send({ error: 'not_live' });
    if (s.creatorId === req.user.id) {
      return { token: await token(req.user.id, s.roomName, false), wsUrl: process.env.LIVEKIT_WS_URL, streamId: s.id, creatorId: s.creatorId };
    }
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
      token: await token(req.user.id, s.roomName, false), wsUrl: process.env.LIVEKIT_WS_URL, streamId: s.id, creatorId: s.creatorId,
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
    const r = await payNextMinute(req.user.id, s);
    return { paidMinutes: r.paidMinutes, paidThrough: r.paidThrough, perMinuteCents: s.perMinuteCents };
  });

  app.post('/:id/end', { preHandler: app.auth }, async (req: any) => {
    const s = await prisma.liveStream.findFirst({ where: { id: req.params.id, creatorId: req.user.id, status: 'LIVE' } });
    if (s) { await rooms().deleteRoom(s.roomName).catch(() => {}); await prisma.liveStream.update({ where: { id: s.id }, data: { status: 'ENDED', endedAt: new Date() } }); }
    return { ok: true };
  });

  app.get('/active', async () =>
    prisma.liveStream.findMany({ where: { status: 'LIVE' }, include: { creator: { select: { displayName: true, avatarKey: true, user: { select: { username: true } } } }, _count: { select: { tickets: true } } } }));

  // LiveKit → us. Needs raw body for signature check.
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  app.post('/webhook', async (req: any, reply) => {
    let evt; try { evt = await receiver().receive(req.body, req.headers.authorization); } catch { return reply.code(401).send(); }
    if (evt.event === 'room_finished' && evt.room?.name)
      await prisma.liveStream.updateMany({ where: { roomName: evt.room.name, status: 'LIVE' }, data: { status: 'ENDED', endedAt: new Date() } });
    return { ok: true };
  });

  // tip overlay feed for a stream: wss://host/live/:id/events, then send
  // {"type":"auth","token":"<access jwt>"} first (see plugins/realtime.ts).
  app.get('/:id/events', { websocket: true }, (socket: any, req: any) => {
    const id = String(req.params.id ?? '');
    // publish() prefixes with "u:" — tips.ts publishes to `stream:<id>`
    // Only someone who could watch the stream gets its overlay feed: the
    // creator, a subscriber, a ticket holder, or a viewer with paid minutes.
    serveRealtimeChannel(app, socket, async (user) => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const s = await prisma.liveStream.findUnique({ where: { id }, select: { id: true, creatorId: true } });
      if (!s) return null;
      const ok = s.creatorId === user.id
        || (await isSubscribed(user.id, s.creatorId))
        || !!(await prisma.liveTicket.findUnique({ where: { fanId_streamId: { fanId: user.id, streamId: s.id } } }))
        || !!(await prisma.liveMinute.findFirst({ where: { fanId: user.id, streamId: s.id }, select: { minuteIndex: true } }));
      return ok ? `u:stream:${id}` : null;
    });
  });
};
