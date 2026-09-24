import { prisma } from '../lib/prisma.js';
import { paidThrough, MAX_PREPAID_MS } from './live-billing.js';
import type { RoomsLike } from './livekit.js';

// A viewer gets this long after their paid time ends to buy the next minute
// before being removed -- covers a client timer firing a little late.
export const PAY_GRACE_MS = 30_000;
// A just-created stream's room can take a moment to show up in listRooms.
const NEW_STREAM_GRACE_MS = 2 * 60_000;

/**
 * One pass over every LIVE stream:
 *
 *  1. A stream whose LiveKit room no longer exists is marked ENDED. A stream
 *     only left LIVE through POST /live/:id/end or the room_finished webhook;
 *     a crashed creator with no webhook configured stayed LIVE forever, which
 *     booked every later ordinary tip at the 20% live rate (modules/tips.ts)
 *     and made /live/start answer 409 already_live.
 *  2. On a per-minute stream, every viewer whose paid time has lapsed (past
 *     PAY_GRACE_MS) is removed from the room. Joining is gated by /join
 *     charging the first minute; this is what makes the NEXT minutes owed.
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

    if (s.perMinuteCents <= 0) continue;
    let participants;
    try { participants = await rooms.listParticipants(s.roomName); } catch (e) { log('live-sweep listParticipants', s.id, e); continue; }
    for (const p of participants) {
      if (!p.identity || p.identity === s.creatorId) continue;
      const through = await paidThrough(p.identity, s.id);
      if (through && through.getTime() + PAY_GRACE_MS > now.getTime()) continue;
      try { await rooms.removeParticipant(s.roomName, p.identity); removed++; } catch (e) { log('live-sweep removeParticipant', s.id, p.identity, e); }
    }
  }
  return { ended, removed };
}

/**
 * Called by /live/start before refusing with already_live: ends the creator's
 * existing LIVE stream if its room is gone. Returns true if a live stream
 * (with a real room) is still in the way.
 */
export async function endStaleStreamFor(rooms: RoomsLike, creatorId: string): Promise<boolean> {
  const cur = await prisma.liveStream.findFirst({ where: { creatorId, status: 'LIVE' } });
  if (!cur) return false;
  let exists = true;
  try { exists = (await rooms.listRooms([cur.roomName])).some((r) => r.name === cur.roomName); } catch { return true; }
  if (exists) return true;
  await prisma.liveStream.updateMany({ where: { id: cur.id, status: 'LIVE' }, data: { status: 'ENDED', endedAt: new Date() } });
  return false;
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
 * paid time left on a per-minute stream, or if the stream's creator is no
 * longer ACTIVE. Returns true when the participant was removed.
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
    select: { id: true, creatorId: true, status: true, perMinuteCents: true, creator: { select: { user: { select: { status: true } } } } },
  });
  if (!s || identity === s.creatorId) return false;
  let remove = s.status !== 'LIVE' || s.creator.user.status !== 'ACTIVE';
  if (!remove && s.perMinuteCents > 0) {
    const through = await paidThrough(identity, s.id);
    remove = !through || through.getTime() + PAY_GRACE_MS <= now.getTime();
  }
  if (!remove) return false;
  await rooms.removeParticipant(roomName, identity);
  return true;
}
