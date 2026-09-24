import { prisma } from '../lib/prisma.js';
import { paidThrough } from './live-billing.js';
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
