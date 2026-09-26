import { prisma } from '../lib/prisma.js';
import { paidThrough, MAX_PREPAID_MS } from './live-billing.js';
import type { RoomsLike } from './livekit.js';
import { resolveLiveIdentity } from './live-identity.js';
import { isSubscribed } from './access.js';

// A viewer gets this long after their paid time ends to buy the next minute
// before being removed -- covers a client timer firing a little late.
export const PAY_GRACE_MS = 30_000;
// A just-created stream's room can take a moment to show up in listRooms.
// Shared by the sweep and by /live/start's stale-stream check
// (endStaleStreamFor): neither may end a stream younger than this for a
// missing room.
export const NEW_STREAM_GRACE_MS = 2 * 60_000;

/**
 * One pass over every LIVE stream:
 *
 *  1. A stream whose LiveKit room no longer exists is marked ENDED. A stream
 *     only left LIVE through POST /live/:id/end or the room_finished webhook;
 *     a crashed creator with no webhook configured stayed LIVE forever, which
 *     booked every later ordinary tip at the 20% live rate (modules/tips.ts)
 *     and made /live/start answer 409 already_live.
 *  2. Every viewer who is no longer entitled is removed (lacksEntitlement):
 *     on a per-minute stream one whose paid time has lapsed (past
 *     PAY_GRACE_MS), on a ticketed stream one without a ticket, on a
 *     subscriber-only stream (no ticket, no per-minute price) one whose
 *     subscription has ended, and on ANY stream a viewer whose own account
 *     is no longer ACTIVE. Joining is gated by /join; this is what makes the
 *     NEXT minutes owed, and what ends a session LiveKit would otherwise keep
 *     refreshing the token of (unpriced streams used to be skipped here
 *     entirely, so a lapsed subscriber or a banned fan watched to the end).
 *
 * A LiveKit error on one stream is logged and skipped -- never treated as
 * "room gone", which would end a healthy stream on a network blip.
 */
export async function sweepLive(rooms: RoomsLike, now = new Date(), log: (...a: unknown[]) => void = console.error) {
  const streams = await prisma.liveStream.findMany({ where: { status: 'LIVE' } });
  let ended = 0, removed = 0;
  for (const s of streams) {
    let exists: boolean;
    try {
      exists = (await rooms.listRooms([s.roomName])).some((r) => r.name === s.roomName);
    } catch (e) { log('live-sweep listRooms', s.id, e); continue; }

    if (!exists) {
      if (now.getTime() - s.startedAt.getTime() < NEW_STREAM_GRACE_MS) continue;
      const r = await prisma.liveStream.updateMany({ where: { id: s.id, status: 'LIVE' }, data: { status: 'ENDED', endedAt: now } });
      ended += r.count;
      continue;
    }

    let participants;
    try { participants = await rooms.listParticipants(s.roomName); } catch (e) { log('live-sweep listParticipants', s.id, e); continue; }
    for (const p of participants) {
      if (!p.identity) continue;
      // Viewers carry an opaque per-stream identity (core/live-identity.ts);
      // one that does not decode for this stream belongs to nobody entitled.
      const userId = resolveLiveIdentity(s.id, p.identity);
      if (userId === s.creatorId) continue;
      if (userId && !(await lacksEntitlement(s, userId, now))) continue;
      try { await rooms.removeParticipant(s.roomName, p.identity); removed++; } catch (e) { log('live-sweep removeParticipant', s.id, p.identity, e); }
    }
  }
  return { ended, removed };
}

/** Does this fan hold a ticket to this stream? */
export async function hasTicket(fanId: string, streamId: string) {
  return !!(await prisma.liveTicket.findUnique({ where: { fanId_streamId: { fanId, streamId } } }));
}

/**
 * Why POST /live/:id/minute must refuse this fan, or null. That route hands
 * out a room token, so it needs the same entitlement /join applies: a live,
 * not-suspended creator, and -- on a ticketed stream -- a ticket already
 * bought through /join. Paid minutes never stand in for the ticket.
 */
export async function minuteRefusal(fanId: string, s: { id: string; creatorId: string; ticketPriceCents: number }): Promise<'not_live' | 'ticket_required' | null> {
  const creator = await prisma.user.findUnique({ where: { id: s.creatorId }, select: { status: true } });
  if (creator?.status !== 'ACTIVE') return 'not_live';
  if (s.ticketPriceCents > 0 && !(await hasTicket(fanId, s.id))) return 'ticket_required';
  return null;
}

/**
 * Should viewer `userId` be removed from stream `s` right now? The same
 * entitlements POST /live/:id/join applies, each required where it applies:
 *
 *  - the viewer's own account must be ACTIVE -- a suspended or banned fan
 *    fails app.auth everywhere else, and a ticket or paid minutes bought
 *    before the ban do not keep them in the room;
 *  - a ticketed stream needs a LiveTicket -- paid minutes do not stand in for
 *    one (POST /live/:id/minute used to hand a room token to anyone who paid
 *    for a minute, and this check, looking only at minutes, left them in);
 *  - a per-minute stream needs paid time that has not lapsed (plus grace);
 *  - a subscriber-only stream (no ticket, no per-minute price) needs a
 *    subscription that is still current.
 */
async function lacksEntitlement(s: { id: string; creatorId: string; ticketPriceCents: number; perMinuteCents: number }, userId: string, now: Date) {
  const viewer = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (viewer?.status !== 'ACTIVE') return true;
  if (s.ticketPriceCents <= 0 && s.perMinuteCents <= 0) return !(await isSubscribed(userId, s.creatorId));
  if (s.ticketPriceCents > 0 && !(await hasTicket(userId, s.id))) return true;
  if (s.perMinuteCents > 0) {
    const through = await paidThrough(userId, s.id);
    if (!through || through.getTime() + PAY_GRACE_MS <= now.getTime()) return true;
  }
  return false;
}

/**
 * Called by /live/start before refusing with already_live: ends the creator's
 * existing LIVE stream if its room is gone. Returns true if a live stream
 * (with a real room) is still in the way.
 *
 * A stream younger than NEW_STREAM_GRACE_MS is always "in the way", room
 * listed or not -- the same grace the sweep gives it. Without it, a second
 * "Go Live" arriving just after the first committed (a double tap ~300 ms
 * apart) saw the first room not yet in listRooms, ended the stream the
 * creator was about to publish into, and started a second, empty one that
 * /live/active and /join then pointed fans at.
 */
export async function endStaleStreamFor(rooms: RoomsLike, creatorId: string, now = new Date()): Promise<boolean> {
  const cur = await prisma.liveStream.findFirst({ where: { creatorId, status: 'LIVE' } });
  if (!cur) return false;
  if (now.getTime() - cur.startedAt.getTime() < NEW_STREAM_GRACE_MS) return true;
  let exists = true;
  try { exists = (await rooms.listRooms([cur.roomName])).some((r) => r.name === cur.roomName); } catch { return true; }
  if (exists) return true;
  await prisma.liveStream.updateMany({ where: { id: cur.id, status: 'LIVE' }, data: { status: 'ENDED', endedAt: now } });
  return false;
}

type StartRooms = RoomsLike & Pick<import('livekit-server-sdk').RoomServiceClient, 'createRoom' | 'deleteRoom'>;

/**
 * POST /live/start: at most ONE LIVE stream per creator. The check used to be
 * a plain read before the insert, so a double-tapped "Go Live" passed it
 * twice and made two LIVE streams, each with its own room -- the creator
 * published into one, fans could buy a ticket and per-minute time for the
 * empty other, and an occupied room never hits emptyTimeout, so the sweep
 * never ended it.
 *
 * The re-check and the insert now run in one transaction holding a
 * per-creator advisory lock, so of two concurrent starts exactly one inserts;
 * the partial unique index "LiveStream_one_live_per_creator" (round-9
 * migration) enforces the same thing in the database as a backstop. The
 * loser deletes the room it just created and gets already_live.
 */
export async function startLiveStream(
  rooms: StartRooms,
  creatorId: string,
  data: { title: string; ticketPriceCents: number; perMinuteCents: number },
  roomName: string,
): Promise<{ ok: true; stream: Awaited<ReturnType<typeof prisma.liveStream.create>> } | { ok: false; error: 'already_live' }> {
  if (await endStaleStreamFor(rooms, creatorId)) return { ok: false, error: 'already_live' };
  await rooms.createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 5000 });
  let stream: Awaited<ReturnType<typeof prisma.liveStream.create>> | null = null;
  try {
    stream = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'live:' + creatorId}))`;
      if (await tx.liveStream.findFirst({ where: { creatorId, status: 'LIVE' }, select: { id: true } })) return null;
      return tx.liveStream.create({ data: { creatorId, roomName, ...data } });
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') {
      try { await rooms.deleteRoom(roomName); } catch { /* best effort */ }
      throw err;
    }
  }
  if (!stream) {
    try { await rooms.deleteRoom(roomName); } catch { /* an empty room also times out on its own */ }
    return { ok: false, error: 'already_live' };
  }
  return { ok: true, stream };
}

/**
 * Lifetime of a viewer's LiveKit token.
 *
 * On a per-minute stream the token ends when the viewer's paid time (plus
 * the grace) does, floored at a minute so a just-paid viewer can finish
 * connecting. A removed viewer who still held a 10-minute token used to
 * reconnect with it straight away and watch until the next sweep, over and
 * over -- paying for ~1 minute in 10. This alone is not enough (LiveKit
 * hands a connected client refreshed tokens), which is why the
 * participant_joined webhook also runs checkViewerOnJoin() below.
 */
export function viewerTokenTtlSeconds(perMinuteCents: number, through: Date | null, now = Date.now()): number {
  if (perMinuteCents <= 0) return 10 * 60;
  const until = (through?.getTime() ?? now) + PAY_GRACE_MS - now;
  return Math.max(60, Math.min(Math.ceil(until / 1000), Math.ceil((MAX_PREPAID_MS + PAY_GRACE_MS) / 1000)));
}

/**
 * LiveKit's participant_joined webhook: a viewer who joins (or rejoins with
 * a token LiveKit refreshed for them) is removed at once if they have no
 * ticket on a ticketed stream, no paid time left on a per-minute stream, no
 * current subscription on a subscriber-only stream, if their own account is
 * not ACTIVE, or if the stream's creator is no longer ACTIVE. Returns true when the
 * participant was removed.
 */
export async function checkViewerOnJoin(
  rooms: Pick<RoomsLike, 'removeParticipant'>,
  roomName: string,
  identity: string,
  now = new Date(),
): Promise<boolean> {
  if (!identity) return false;
  const s = await prisma.liveStream.findUnique({
    where: { roomName },
    select: { id: true, creatorId: true, status: true, ticketPriceCents: true, perMinuteCents: true, creator: { select: { user: { select: { status: true } } } } },
  });
  if (!s) return false;
  // `identity` is what LiveKit reports -- an opaque per-stream viewer
  // identity, or the creator's own id on their publish token. Entitlement is
  // checked against the user it decodes to; the raw identity is what gets
  // removed.
  const userId = resolveLiveIdentity(s.id, identity);
  if (userId === s.creatorId) return false;
  let remove = s.status !== 'LIVE' || s.creator.user.status !== 'ACTIVE';
  if (!remove) remove = !userId || await lacksEntitlement(s, userId, now);
  if (!remove) return false;
  await rooms.removeParticipant(roomName, identity);
  return true;
}
