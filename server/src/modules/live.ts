import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { prisma } from '../lib/prisma';
import { charge, money } from '../core/ledger';
import { isSubscribed } from '../core/access';
import { sub } from '../lib/redis';

const LK = { host: process.env.LIVEKIT_HOST!, key: process.env.LIVEKIT_API_KEY!, secret: process.env.LIVEKIT_API_SECRET! };

// Built lazily so a box without LiveKit configured yet can still boot and
// serve every other route -- only /live/* itself fails until it's set up.
let _rooms: RoomServiceClient | undefined;
const rooms = () => (_rooms ??= new RoomServiceClient(LK.host, LK.key, LK.secret));
let _receiver: WebhookReceiver | undefined;
const receiver = () => (_receiver ??= new WebhookReceiver(LK.key, LK.secret));

async function token(identity: string, room: string, publish: boolean) {
  const at = new AccessToken(LK.key, LK.secret, { identity, ttl: '2h' });
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
    if (await prisma.liveStream.findFirst({ where: { creatorId: req.user.id, status: 'LIVE' } })) return reply.code(409).send({ error: 'already_live' });
    const roomName = `live_${nanoid(10)}`;
    await rooms().createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 5000 });
    const s = await prisma.liveStream.create({ data: { creatorId: req.user.id, roomName, ...b } });
    return { stream: s, token: await token(req.user.id, roomName, true), wsUrl: process.env.LIVEKIT_WS_URL };
  });

  app.post('/:id/join', { preHandler: app.auth }, async (req: any, reply) => {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s || s.status !== 'LIVE') return reply.code(404).send({ error: 'not_live' });
    let allowed = await isSubscribed(req.user.id, s.creatorId);
    if (s.ticketPriceCents > 0 && s.creatorId !== req.user.id) {
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
    if (!allowed) return reply.code(403).send({ error: 'subscription_required' });
    return { token: await token(req.user.id, s.roomName, false), wsUrl: process.env.LIVEKIT_WS_URL, streamId: s.id, creatorId: s.creatorId };
  });

  /**
   * Buy the next minute of a per-minute stream.
   *
   * Billed a minute at a time IN ADVANCE, and the client calls this on a
   * timer while watching. Advance billing is the safe direction: the worst
   * case is a viewer paying for up to one minute they did not finish, rather
   * than the platform owing a creator for minutes it never collected.
   *
   * The minute number is decided HERE, from what the fan has already paid
   * for -- never sent by the client. A client-chosen index lets someone
   * resend the same number forever: every call after the first hits the
   * primary key, charges nothing, and they watch free.
   */
  app.post('/:id/minute', { preHandler: app.auth }, async (req: any, reply) => {
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s || s.status !== 'LIVE') return reply.code(404).send({ error: 'not_live' });
    if (s.perMinuteCents <= 0) return reply.code(400).send({ error: 'not_per_minute' });
    // A creator watching their own stream is not a customer of it.
    if (s.creatorId === req.user.id) return { paidMinutes: null, perMinuteCents: 0 };

    const paid = await prisma.liveMinute.count({ where: { fanId: req.user.id, streamId: s.id } });

    try {
      await money(prisma, async (tx) => {
        await tx.liveMinute.create({
          data: { fanId: req.user.id, streamId: s.id, minuteIndex: paid, paidCents: s.perMinuteCents },
        });
        await charge(tx, {
          fanId: req.user.id, creatorId: s.creatorId, grossCents: s.perMinuteCents,
          type: 'LIVE_MINUTE', refId: `${s.id}:${paid}`,
        });
      });
    } catch (e) {
      // Same shape as the ticket race above, and the same trap: P2002 alone
      // is NOT proof this fan already paid. charge() upserts shared Account
      // rows for the creator, the platform and any referrers, so two
      // DIFFERENT viewers billing a minute at the same instant collide on
      // those instead -- admitting on the code alone would hand out free
      // minutes to whoever lost a race they had nothing to do with. Only the
      // fan's own row at this index proves they paid for it.
      if ((e as { code?: string }).code !== 'P2002') throw e;
      const mine = await prisma.liveMinute.findUnique({
        where: { fanId_streamId_minuteIndex: { fanId: req.user.id, streamId: s.id, minuteIndex: paid } },
      });
      if (!mine) throw e;
    }

    return { paidMinutes: paid + 1, perMinuteCents: s.perMinuteCents };
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

  // tip overlay feed for a stream: ws://host/live/:id/events?token=
  app.get('/:id/events', { websocket: true }, async (socket: any, req: any) => {
    try { app.jwt.verify(req.query.token); } catch { return socket.close(4001); }
    const ch = `u:stream:${req.params.id}`;      // publish() prefixes with "u:" — tips.ts publishes to `stream:<id>`
    const l = (c: string, m: string) => { if (c === ch) socket.send(m); };
    await sub.subscribe(ch); sub.on('message', l);
    socket.on('close', async () => { sub.off('message', l); await sub.unsubscribe(ch); });
  });
};
