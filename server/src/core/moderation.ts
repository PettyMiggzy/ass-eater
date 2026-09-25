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
 *
 * A site-driven change is CONDITIONAL in the database, never a blind write
 * of a status read earlier: every bySite caller (the lapse sweep, a bridge
 * exchange, a status push) decides from a row it read before this runs, and
 * an admin ban or suspension landing in between used to be overwritten --
 * the lapse sweep flipped a creator banned moments earlier back to ACTIVE.
 * So the site may only:
 *  - lift (ACTIVE) a row that is still SUSPENDED by the site;
 *  - suspend a row that is still ACTIVE (never downgrade a ban, nor take
 *    over an admin's suspension, which the site could then lift);
 *  - ban anything not already BANNED.
 * An admin's change (bySite unset) always applies. Returns whether the
 * change was applied; when it was not, nothing else here runs.
 */
export async function applyUserStatus(
  userId: string,
  status: ModerationStatus,
  opts: { bySite?: boolean; log?: Log; rooms?: RoomDeleter } = {},
): Promise<boolean> {
  const log = opts.log ?? { error: (o: unknown, m?: string) => console.error(m ?? 'moderation', o) };
  const guard = !opts.bySite ? {}
    : status === 'ACTIVE' ? { status: 'SUSPENDED' as const, statusBySite: true }
      : status === 'SUSPENDED' ? { status: 'ACTIVE' as const }
        : { status: { not: 'BANNED' as const } };
  const applied = await prisma.$transaction(async (tx) => {
    const r = await tx.user.updateMany({ where: { id: userId, ...guard }, data: { status, statusBySite: !!opts.bySite } });
    if (!r.count) return false;
    await tx.refreshToken.deleteMany({ where: { userId } });
    if (status !== 'ACTIVE') {
      await tx.creatorProfile.updateMany({ where: { userId }, data: { payoutsFrozen: true } });
      // Their own subscriptions and token locks AS A FAN stop renewing: a
      // suspended or banned account fails app.auth on every route, cancelling
      // included, so it could never turn auto-renew off itself and would keep
      // being charged. Access already paid for runs to its period end.
      // (workers/renewals.ts also refuses to renew a non-ACTIVE fan, which
      // covers rows this misses, e.g. a status set before this existed.)
      await tx.subscription.updateMany({ where: { fanId: userId, status: 'ACTIVE' }, data: { autoRenew: false } });
      await tx.tokenLock.updateMany({ where: { fanId: userId, status: 'ACTIVE' }, data: { autoRenew: false } });
    }
    if (status === 'BANNED') await tx.subscription.updateMany({ where: { creatorId: userId }, data: { autoRenew: false, status: 'CANCELLED' } });
    return true;
  });
  if (!applied) return false;
  if (status === 'ACTIVE') return true;

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
  return true;
}
