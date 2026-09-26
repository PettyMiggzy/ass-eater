import { prisma } from '../lib/prisma.js';
import { money } from './ledger.js';
import { cancelAuction, dropLead } from './auctions.js';
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
 * or ban the SITE applied is lifted by the site saying the creator is active
 * again (its suspensions expire on their own after 30 days; a site admin may
 * reverse its own ban); one an admin applied here stays until an admin lifts
 * it. Lifting a ban, either way, re-activates the subscriptions the ban
 * cancelled whose paid period has not ended, and nothing else: payouts stay
 * frozen and ban takedowns stay down (restoreBanTakedowns).
 *
 * A site-driven change is CONDITIONAL in the database, never a blind write
 * of a status read earlier: every bySite caller (the lapse sweep, a bridge
 * exchange, a status push) decides from a row it read before this runs, and
 * an admin ban or suspension landing in between used to be overwritten --
 * the lapse sweep flipped a creator banned moments earlier back to ACTIVE.
 * So the site may only:
 *  - lift (ACTIVE) a row that is still SUSPENDED or BANNED by the site, and whose
 *    recorded site standings (creator and account) no longer restrict it;
 *  - suspend a row that is still ACTIVE (never downgrade a ban, nor take
 *    over an admin's suspension, which the site could then lift);
 *  - ban anything not already BANNED -- but a ban over an admin's
 *    suspension stays the admin's (statusBySite false), so the site can
 *    never lift it.
 * An admin's change (bySite unset) always applies -- unless `noDowngrade`
 * is set, when a SUSPENDED never overwrites a row that is already BANNED.
 * The report-resolve route sets it: suspend_user there is a side effect of
 * judging one report, and an admin working the queue must not silently
 * lift a ban (the explicit POST /admin/users/:id/status may still do so).
 * Returns whether the change was applied; when it was not, nothing else
 * here runs.
 */
export async function applyUserStatus(
  userId: string,
  status: ModerationStatus,
  opts: { bySite?: boolean; noDowngrade?: boolean; log?: Log; rooms?: RoomDeleter } = {},
): Promise<boolean> {
  const log = opts.log ?? { error: (o: unknown, m?: string) => console.error(m ?? 'moderation', o) };
  // A site LIFT also requires, in the same statement, that neither recorded
  // site standing restricts the account any more. Callers decide to lift
  // from a row they read earlier (the lapse sweep claims its row first), and
  // a new site suspension recorded in between -- syncSiteStanding writes
  // siteCreatorStatus='suspended' and then applies nothing, because the row
  // is still SUSPENDED -- used to be erased by the stale lift: ACTIVE here
  // while the site considered the creator suspended. NULL (never set) does
  // not restrict; Prisma's notIn excludes NULLs, hence the OR.
  const RESTRICTIVE = ['suspended', 'banned'];
  const siteNoLongerRestricts = [
    { OR: [{ siteCreatorStatus: null }, { siteCreatorStatus: { notIn: RESTRICTIVE } }] },
    { OR: [{ siteAccountStatus: null }, { siteAccountStatus: { notIn: RESTRICTIVE } }] },
  ];
  const guard = !opts.bySite ? (opts.noDowngrade && status === 'SUSPENDED' ? { status: { not: 'BANNED' as const } } : {})
    : status === 'ACTIVE' ? { status: { in: ['SUSPENDED' as const, 'BANNED' as const] }, statusBySite: true, AND: siteNoLongerRestricts }
      : status === 'SUSPENDED' ? { status: 'ACTIVE' as const }
        : { status: { not: 'BANNED' as const } };
  const applied = await prisma.$transaction(async (tx) => {
    // The standing this change replaces, read under a row lock so it is
    // still the prior one when the guarded update below runs (a concurrent
    // change waits for this transaction).
    const priorRow = (await tx.$queryRaw<{ status: string; statusBySite: boolean }[]>`SELECT status::text AS status, "statusBySite" FROM "User" WHERE id = ${userId} FOR UPDATE`)[0];
    const prior = priorRow?.status;
    // Who owns the restriction afterwards. A site ban may land on a row an
    // ADMIN suspended (a site ban applies to anything not already BANNED);
    // it then stays the admin's (statusBySite false). Marking it the site's
    // let a later site 'active' lift it straight to ACTIVE, erasing the
    // admin's suspension -- the takeover the rules above forbid for
    // suspensions, reached through a ban. The site then gets the
    // needs-server-admin refusal (lib/bridge.ts) instead.
    const bySite = !!opts.bySite && (status === 'ACTIVE' || !priorRow || priorRow.status === 'ACTIVE' || priorRow.statusBySite);
    const r = await tx.user.updateMany({ where: { id: userId, ...guard }, data: { status, statusBySite: bySite } });
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
    // Reversing a ban gives the creator's subscribers back the period they
    // already paid for: the ban CANCELLED every subscription to them (the
    // only writer of CANCELLED), which cut access at once, and fans get no
    // refunds -- so without this a reinstated creator's fans had lost the
    // rest of their month, and re-subscribing charged them a new one. Only
    // rows still inside their paid period come back, never auto-renewing:
    // they run to currentPeriodEnd and the renewals worker expires them. A
    // fan who wants to keep going subscribes again when it ends. Token
    // locks get the same treatment (nothing cancels them today, but a row
    // CANCELLED by anything else is likewise a ban's).
    if (status === 'ACTIVE' && prior === 'BANNED') {
      const live = { creatorId: userId, status: 'CANCELLED' as const, currentPeriodEnd: { gt: new Date() } };
      await tx.subscription.updateMany({ where: live, data: { status: 'ACTIVE', autoRenew: false } });
      await tx.tokenLock.updateMany({ where: live, data: { status: 'ACTIVE', autoRenew: false } });
    }
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
  //
  // Every listing a ban takes down is stamped moderatedAt: REMOVED alone is
  // also what the creator's own unlist writes, and an account an admin later
  // un-bans must not be able to relist what the ban removed with one PATCH
  // (modules/marketplace.ts refuses a moderated listing). The stamp says it
  // was the BAN (moderatedReason BAN): the item itself was never judged, so
  // past buyers see it again once the seller is ACTIVE, and an admin can
  // clear it (restoreBanTakedowns) -- a reactivation alone never relists.
  // Nothing here overwrites a REPORT stamp.
  if (status === 'BANNED') {
    const moderatedAt = new Date();
    const auctions = await prisma.listing.findMany({ where: { creatorId: userId, saleType: 'AUCTION', status: 'ACTIVE' }, select: { id: true } });
    // One auction failing to cancel (the sweep can close it between this
    // read and its transaction; cancelAuction then no-ops) must never skip
    // the fixed-price removal below for a creator who is already BANNED.
    for (const a of auctions) {
      try {
        await money(prisma, async (tx) => {
          const r = await cancelAuction(tx, a.id, 'seller_banned');
          // Stamped only when THIS cancel took it down: cancelAuction no-ops
          // on an auction the sweep already closed (sold, or ended unsold).
          await tx.listing.updateMany({ where: { id: a.id, status: 'REMOVED', moderatedAt: null }, data: { moderatedAt, moderatedReason: 'BAN' } });
          return r;
        });
      } catch (err) {
        log.error({ err, listingId: a.id, userId }, 'ban: failed to cancel auction');
      }
    }
    await prisma.listing.updateMany({ where: { creatorId: userId, saleType: 'FIXED', status: 'ACTIVE' }, data: { status: 'REMOVED', moderatedAt, moderatedReason: 'BAN' } });

    // ...and as a BIDDER: every auction the banned account leads loses that
    // lead, with its hold returned, and stays ACTIVE for everyone else. Left
    // standing, the banned number made legitimate bidders pay over it, and
    // the close settled the sale to an account that can never open the
    // order (every route answers 403). closeAuction also refuses a
    // non-ACTIVE winner, which covers a lead taken between this read and the
    // ban. A SUSPENDED leader keeps the lead here -- the suspension may lift
    // before the auction ends -- and loses it at the close only if still
    // suspended then.
    const leads = await prisma.listing.findMany({ where: { currentBidderId: userId, saleType: 'AUCTION', status: 'ACTIVE' }, select: { id: true } });
    for (const a of leads) {
      try {
        await money(prisma, (tx) => dropLead(tx, a.id, userId, 'bidder_banned'));
      } catch (err) {
        log.error({ err, listingId: a.id, userId }, 'ban: failed to release a leading bid');
      }
    }
  }
  return true;
}

/**
 * Clears a BAN takedown stamp so the creator can relist (their own PATCH
 * /marketplace/listings/:id), for one listing or every listing of one
 * creator. The listings stay REMOVED -- relisting is the creator's step --
 * and a REPORT takedown is never touched. An admin action only
 * (modules/admin.ts): a site-driven reactivation never calls this. Refuses
 * while the creator is not ACTIVE, where the listing could not be sold
 * anyway and the ban it came from still stands. Returns how many were
 * cleared.
 */
export async function restoreBanTakedowns(where: { listingId: string } | { creatorId: string }): Promise<number> {
  const r = await prisma.listing.updateMany({
    where: {
      ...('listingId' in where ? { id: where.listingId } : { creatorId: where.creatorId }),
      moderatedReason: 'BAN',
      creator: { user: { status: 'ACTIVE' } },
    },
    data: { moderatedAt: null, moderatedReason: null },
  });
  return r.count;
}
