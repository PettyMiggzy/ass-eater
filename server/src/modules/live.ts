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
    const b = z.object({ title: z.string().max(120), ticketPriceCents: z.number().int().min(0).max(50_000).default(0) }).parse(req.body);
    if (await prisma.liveStream.findFirst({ where: { creatorId: req.user.id, status: 'LIVE' } })) return reply.code(409).send({ error: 'already_live' });
    const roomName = `live_${nanoid(10)}`;
    await rooms().createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 5000 });
    const s = await prisma.liveStream.create({ data: { creatorId: req.user.id, roomName, ...b } });
    return { stream: s, token: await token(req.user.id, roomName, true), wsUrl: process.env.LIVEKIT_WS_URL };
  });

  app.post('/:id/join', { preHandler: app.auth }, async (req: any, reply) => {
    const { payAsset } = z.object({ payAsset: z.enum(['USD', 'ONLYASS']).default('USD') }).parse(req.body ?? {});
    const s = await prisma.liveStream.findUnique({ where: { id: req.params.id } });
    if (!s || s.status !== 'LIVE') return reply.code(404).send({ error: 'not_live' });
    let allowed = await isSubscribed(req.user.id, s.creatorId);
    if (s.ticketPriceCents > 0 && s.creatorId !== req.user.id) {
      const has = await prisma.liveTicket.findUnique({ where: { fanId_streamId: { fanId: req.user.id, streamId: s.id } } });
      if (!has) {
        await money(prisma, async (tx) => {
          await tx.liveTicket.create({ data: { fanId: req.user.id, streamId: s.id } });
          await charge(tx, { fanId: req.user.id, creatorId: s.creatorId, grossCents: s.ticketPriceCents, type: 'LIVE_TICKET', refId: s.id, payAsset });
        });
      }
      allowed = true;
    }
    if (!allowed) return reply.code(403).send({ error: 'subscription_required' });
    return { token: await token(req.user.id, s.roomName, false), wsUrl: process.env.LIVEKIT_WS_URL, streamId: s.id, creatorId: s.creatorId };
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
