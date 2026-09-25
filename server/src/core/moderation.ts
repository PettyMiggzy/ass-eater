import { prisma } from '../lib/prisma.js';
import { money } from './ledger.js';
import { cancelAuction } from './auctions.js';
import { rooms as liveRooms, livekitConfigured } from './livekit.js';

export type ModerationStatus = 'ACTIVE' | 'SUSPENDED' | 'BANNED';
type Log = { error: (obj: unknown, msg?: string) => void };
type RoomDeleter = { deleteRoom: (name: string) => Promise<unknown> };

/**
 * Everything a change of account standing does, in one place, for both of
 * the ways it can happen: an admin here (modules/admin.ts) and the Next.js
 * site's content-violation ladder arriving through the bridge
 * (lib/bridge.ts -- a status claim on an exchange, or a signed status push).
 *
 * Suspending or banning freezes payouts; reactivating does NOT unfreeze
 * them. payoutsFrozen is also set by hand through POST
 * /admin/creators/:id/freeze (e.g. a chargeback or fraud review), and the
 * flag can't tell the reasons apart -- so lifting a freeze is always its own
 * explicit admin step.
 *
 * `bySite` records that the standing came from the site. Only a suspension
 * the SITE applied is lifted by the site saying the creator is active again
 * (its suspensions expire on their own after 30 days); one an admin applied
 * here stays until an admin lifts it.
 */
export async function applyUserStatus(
  userId: string,
  status: ModerationStatus,
  opts: { bySite?: boolean; log?: Log; rooms?: RoomDeleter } = {},
) {
  const log = opts.log ?? { error: (o: unknown, m?: string) => console.error(m ?? 'moderation', o) };
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { status, statusBySite: !!opts.bySite } }),
    prisma.refreshToken.deleteMany({ where: { userId } }),
    ...(status !== 'ACTIVE' ? [prisma.creatorProfile.updateMany({ where: { userId }, data: { payoutsFrozen: true } })] : []),
    // Their own subscriptions and token locks AS A FAN stop renewing: a
    // suspended or banned account fails app.auth on every route, cancelling
    // included, so it could never turn auto-renew off itself and would keep
    // being charged. Access already paid for runs to its period end.
    // (workers/renewals.ts also refuses to renew a non-ACTIVE fan, which
    // covers rows this misses, e.g. a status set before this existed.)
    ...(status !== 'ACTIVE' ? [
      prisma.subscription.updateMany({ where: { fanId: userId, status: 'ACTIVE' }, data: { autoRenew: false } }),
      prisma.tokenLock.updateMany({ where: { fanId: userId, status: 'ACTIVE' }, data: { autoRenew: false } }),
    ] : []),
    ...(status === 'BANNED' ? [prisma.subscription.updateMany({ where: { creatorId: userId }, data: { autoRenew: false, status: 'CANCELLED' } })] : []),
  ]);
  if (status === 'ACTIVE') return;

  // A suspended or banned creator stops broadcasting now. Their publish token
  // lasts 6h, so the room itself is deleted (which disconnects everyone in
  // it), and the stream is marked ENDED so it leaves /live/active and /join.
  const streams = await prisma.liveStream.findMany({ where: { creatorId: userId, status: 'LIVE' }, select: { id: true, roomName: true } });
  for (const s of streams) {
    const r = opts.rooms ?? (livekitConfigured() ? liveRooms() : null);
    if (r) {
      try { await r.deleteRoom(s.roomName); } catch (err) { log.error({ err, streamId: s.id }, 'moderation: failed to delete live room'); }
    }
    await prisma.liveStream.updateMany({ where: { id: s.id, status: 'LIVE' }, data: { status: 'ENDED', endedAt: new Date() } });
  }

  // A ban takes the creator's marketplace down: fixed-price listings are
  // removed, and every live auction is cancelled with the leader's hold
  // returned in the same transaction (a removed auction is never closed by
  // the sweep, so a hold left on one was stranded). Suspension needs none
  // of this -- browsing, buying and bidding already refuse a non-ACTIVE
  // seller, and an auction ending during a suspension closes with no sale
  // and a full release (core/auctions.ts closeAuction).
  if (status === 'BANNED') {
    const auctions = await prisma.listing.findMany({ where: { creatorId: userId, saleType: 'AUCTION', status: 'ACTIVE' }, select: { id: true } });
    // One auction failing to cancel (the sweep can close it between this
    // read and its transaction; cancelAuction then no-ops) must never skip
    // the fixed-price removal below for a creator who is already BANNED.
    for (const a of auctions) {
      try {
        await money(prisma, (tx) => cancelAuction(tx, a.id, 'seller_banned'));
      } catch (err) {
        log.error({ err, listingId: a.id, userId }, 'ban: failed to cancel auction');
      }
    }
    await prisma.listing.updateMany({ where: { creatorId: userId, saleType: 'FIXED', status: 'ACTIVE' }, data: { status: 'REMOVED' } });
  }
}
