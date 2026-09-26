import { post, lockBalance, InsufficientFunds, isVip, type Tx, postPlatformRevenue } from './ledger.js';
import { PLATFORM_FEE_BPS, LISTING_FEE_BPS } from './marketplace-fees.js';
import { creatorMayBePaidById } from './creator-standing.js';

// eBay-style auctions on the marketplace. Bids settle in the USD-backed
// balanceCents pool ONLY -- never the $ONLYONE discount pool. A bid has to
// hold its value for however long the auction runs (hours to days), and a
// volatile token doing that plus a 10% payment discount would make "highest
// bid wins" ambiguous. USDC-funded balance has neither problem.
//
// A bid's funds are held the instant it's placed (AUCTION_BID_HOLD) and
// released the instant it's outbid (AUCTION_BID_RELEASE) -- so there is
// never a "the bidder can't actually pay" problem to discover at close time.
// By the time an auction ends, the leading bid is already real money sitting
// out of the bidder's spendable balance, not a promise to collect later.

export function statusCode(err: string, code: number) {
  return Object.assign(new Error(err), { statusCode: code });
}

const MIN_INCREMENT_FLOOR_CENTS = 100; // $1
const MIN_INCREMENT_BPS = 500; // 5%
const ANTI_SNIPE_WINDOW_MS = 5 * 60_000; // a bid in the last 5 minutes...
const ANTI_SNIPE_EXTENSION_MS = 5 * 60_000; // ...pushes the deadline out by 5 more, same idea as eBay/Christie's live extensions

/** The smallest a new bid may exceed the current one by, absent a creator-set override. */
export function minIncrement(currentCents: number, override?: number | null): number {
  if (override != null) return override;
  return Math.max(MIN_INCREMENT_FLOOR_CENTS, Math.floor((currentCents * MIN_INCREMENT_BPS) / 10_000));
}

/**
 * Shipping a bid on this listing has to carry. Shipping is paid by the winner
 * and routed to the creator uncommissioned, exactly like a fixed-price buy --
 * so it has to leave the bidder's balance WITH the bid, or the close credits
 * the creator money nobody paid (that is how physical auctions used to mint
 * shippingCents on every sale).
 */
function shippingFor(listing: { kind: string; shippingCents: number }) {
  return listing.kind === 'PHYSICAL' ? listing.shippingCents : 0;
}

/** What is currently held from the leader. Rows from before currentHoldCents existed held exactly the bid. */
function heldNow(listing: { currentHoldCents: number | null; currentBidCents: number | null }) {
  return listing.currentHoldCents ?? listing.currentBidCents ?? 0;
}

/** The part of the current hold that came out of the leader's withdrawable credits. */
function heldWithdrawableNow(listing: { currentHoldWithdrawableCents: number | null }) {
  return listing.currentHoldWithdrawableCents ?? 0;
}

/**
 * Ends the current run's bids without a sale: every not-yet-voided bid on
 * the listing is stamped voidedAt, in the caller's transaction. Called
 * wherever a lead is released without a sale (cancelAuction, dropLead, a
 * no-sale closeAuction) and on relist. Without it GET
 * /marketplace/listings/:id/bids kept presenting a released $90 bid as the
 * top bid of a relisted auction starting at $10 -- a phantom new fans bid
 * over with non-refundable credits -- and told its bidder isYou on a bid
 * that held nothing and could not win.
 */
async function voidBids(tx: Tx, listingId: string, at: Date = new Date()) {
  await tx.bid.updateMany({ where: { listingId, voidedAt: null }, data: { voidedAt: at } });
}

async function withdrawableOf(tx: Tx, userId: string) {
  const a = await tx.account.findUnique({ where: { userId }, select: { withdrawableCents: true } });
  return a?.withdrawableCents ?? 0n;
}

/**
 * May this auction's seller be paid right now -- not suspended or banned AND
 * still approved (core/creator-standing.ts). Status alone let a creator whose
 * approval was withdrawn keep taking bids, and be paid at close.
 */
async function sellerActive(tx: Tx, creatorId: string) {
  return creatorMayBePaidById(tx, creatorId);
}

/**
 * Does this listing have everything it promises to deliver? A DIGITAL
 * listing's product is its media (core/access.ts canViewListing), so it
 * needs at least one attached item and EVERY attached item READY -- the same
 * rule as a PPV post (modules/posts.ts postHasDeliverable). "At least one
 * READY" used to be enough, so a 5-video bundle sold at full price with two
 * items that never finished uploading and one REJECTED by transcode, and the
 * buyer got a 403 on three of the five. Physical items ship; their media is
 * optional. Keep in step with `deliverableWhere` below.
 */
export async function hasDeliverable(tx: Tx, listing: { id: string; kind: string }) {
  if (listing.kind === 'PHYSICAL') return true;
  const [ready, notReady] = await Promise.all([
    tx.media.count({ where: { listingId: listing.id, status: 'READY' } }),
    tx.media.count({ where: { listingId: listing.id, status: { not: 'READY' } } }),
  ]);
  return ready > 0 && notReady === 0;
}

/** hasDeliverable as a Listing where-fragment, for browse and detail queries. */
export const deliverableWhere = {
  OR: [
    { kind: 'PHYSICAL' as const },
    { media: { some: { status: 'READY' as const }, none: { status: { not: 'READY' as const } } } },
  ],
};

export async function placeBid(
  tx: Tx, listingId: string, bidderId: string, amountCents: number,
  // The bidder's own explicit 18+ marketplace confirmation and ToS
  // acceptance, given with THIS bid (the bid route requires both). Stored on
  // the Bid; closeAuction copies the winning bid's onto the order.
  confirmation?: { ageConfirmedAt: Date; tosVersion: string },
) {
  const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId } });
  if (listing.saleType !== 'AUCTION') throw statusCode('not_an_auction', 400);
  if (listing.status !== 'ACTIVE') throw statusCode('not_available', 400);
  // A bid carries no request id, so a retry after a lost response (mobile
  // network, a double tap) is indistinguishable from a new bid -- and used
  // to be judged against the floor its own first attempt had just raised:
  // refused as bid_too_low, which told a fan who was already LEADING that
  // they had been outbid, and steered them into outbidding themselves. The
  // current leader repeating exactly their standing bid is that retry: it is
  // answered with the standing bid, nothing re-held. (A leader deliberately
  // re-bidding the same amount would have been refused anyway -- it is
  // below the floor -- so this changes nothing but the answer.)
  if (listing.currentBidderId === bidderId && listing.currentBidCents === amountCents) {
    const standing = await tx.bid.findFirst({ where: { listingId, bidderId, amountCents, voidedAt: null }, orderBy: { createdAt: 'desc' } });
    if (standing) return Object.assign(standing, { already: true as const });
  }
  if (!listing.auctionEndsAt || listing.auctionEndsAt <= new Date()) throw statusCode('auction_ended', 400);
  if (listing.creatorId === bidderId) throw statusCode('self_bid', 400);
  // A suspended or banned seller's auctions stay up only so the close can
  // release holds -- nobody new gets their money tied up in one.
  if (!(await sellerActive(tx, listing.creatorId))) throw statusCode('not_available', 400);
  // Nobody ties money up bidding on an item with nothing to deliver.
  if (!(await hasDeliverable(tx, listing))) throw statusCode('no_deliverable', 409);
  // Same gate as the fixed-price buy route: the first-look window is only
  // real if it holds for someone who has the id, not just for the listing.
  if (listing.vipEarlyUntil && listing.vipEarlyUntil > new Date() && !(await isVip(tx, bidderId))) {
    throw statusCode('vip_early_access', 403);
  }

  const floor = listing.currentBidCents != null
    ? listing.currentBidCents + minIncrement(listing.currentBidCents, listing.minBidIncrementCents)
    : listing.priceCents; // starting bid
  if (amountCents < floor) throw statusCode('bid_too_low', 400);

  const holdCents = amountCents + shippingFor(listing);
  const bal = await lockBalance(tx, bidderId, 'CREDITS');
  // A bidder raising their own lead gets their current hold back first, so
  // only the marginal increase has to be spendable.
  const ownHold = listing.currentBidderId === bidderId ? heldNow(listing) : 0;
  if (bal + BigInt(ownHold) < BigInt(holdCents)) throw new InsufficientFunds();

  // Release the previous leading hold -- exactly what was taken, never a
  // number recomputed from the listing.
  // The release gives back, as withdrawable, exactly the earned part the hold
  // took; otherwise a creator bidding with money they earned would have it
  // turned into credits they can never pay out.
  if (listing.currentBidderId && heldNow(listing) > 0) {
    // {reason:'outbid'}, never WHO outbid them: the fan reads this row's
    // meta back through GET /wallet/history, and naming the other bidder's
    // user id there undid the bid history's anonymity (the Bid table keeps
    // the order of bids for any audit).
    await post(tx, listing.currentBidderId, heldNow(listing), 'AUCTION_BID_RELEASE', listingId, { reason: 'outbid' }, 'CREDITS', { withdrawableCents: heldWithdrawableNow(listing) });
  }
  // Measure how much withdrawable this hold consumes (post() clamps
  // withdrawable down to the new balance), under the row lock taken above.
  const wBefore = await withdrawableOf(tx, bidderId);
  await post(tx, bidderId, -holdCents, 'AUCTION_BID_HOLD', listingId, { bidCents: amountCents, shippingCents: holdCents - amountCents });
  const heldWithdrawable = Number(wBefore - (await withdrawableOf(tx, bidderId)));

  const bid = await tx.bid.create({ data: { listingId, bidderId, amountCents, heldCents: holdCents, heldWithdrawableCents: heldWithdrawable, ageConfirmedAt: confirmation?.ageConfirmedAt ?? null, tosVersion: confirmation?.tosVersion ?? null } });

  let auctionEndsAt = listing.auctionEndsAt;
  if (auctionEndsAt.getTime() - Date.now() < ANTI_SNIPE_WINDOW_MS) {
    auctionEndsAt = new Date(Date.now() + ANTI_SNIPE_EXTENSION_MS);
  }

  await tx.listing.update({ where: { id: listingId }, data: { currentBidCents: amountCents, currentBidderId: bidderId, currentHoldCents: holdCents, currentHoldWithdrawableCents: heldWithdrawable, auctionEndsAt } });
  return bid;
}

/**
 * Takes an auction down without a sale: returns whatever is held from the
 * leader (in the same transaction), clears the lead and marks it REMOVED.
 * Used when the creator removes it, when the seller is banned, and when an
 * ended auction can't sell. Removing a live auction used to strand the
 * leader's hold forever, since only the close and an outbid ever released it.
 */
export async function cancelAuction(tx: Tx, listingId: string, reason: string) {
  const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId } });
  if (listing.saleType !== 'AUCTION') throw statusCode('not_an_auction', 400);
  // Only an ACTIVE auction still holds anything. This read is inside the
  // transaction, so it is the authority: a caller that picked the id out of
  // an earlier, untransacted list (the admin ban loop) may find it already
  // closed by the sweep -- sold, or removed with the hold returned -- and
  // releasing again then would mint the bid a second time.
  if (listing.status !== 'ACTIVE') return { released: 0 };
  const held = heldNow(listing);
  if (listing.currentBidderId && held > 0) {
    await post(tx, listing.currentBidderId, held, 'AUCTION_BID_RELEASE', listingId, { reason }, 'CREDITS', { withdrawableCents: heldWithdrawableNow(listing) });
  }
  await tx.listing.update({
    where: { id: listingId },
    data: { status: 'REMOVED', currentBidderId: null, currentBidCents: null, currentHoldCents: null, currentHoldWithdrawableCents: null },
  });
  await voidBids(tx, listingId);
  return { released: listing.currentBidderId ? held : 0 };
}

/**
 * Withdraws `bidderId`'s standing lead on one auction: returns exactly what
 * is held from them (in this transaction), clears the lead and leaves the
 * auction ACTIVE so anyone else can bid again from the starting price. For a
 * BANNED bidder (core/moderation.ts): a banned account fails app.auth on
 * every route, so it could never open what it won, and its number kept every
 * legitimate bidder paying over it until the close settled the sale to it.
 * Re-read here, inside the transaction, so it no-ops on an auction the
 * sweep closed or someone else took the lead on since the caller's list.
 * There is no bid-history re-promotion: the next bid starts afresh.
 */
export async function dropLead(tx: Tx, listingId: string, bidderId: string, reason: string) {
  const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId } });
  if (listing.saleType !== 'AUCTION' || listing.status !== 'ACTIVE' || listing.currentBidderId !== bidderId) return { released: 0 };
  const held = heldNow(listing);
  if (held > 0) {
    await post(tx, bidderId, held, 'AUCTION_BID_RELEASE', listingId, { reason }, 'CREDITS', { withdrawableCents: heldWithdrawableNow(listing) });
  }
  await tx.listing.update({
    where: { id: listingId },
    data: { currentBidderId: null, currentBidCents: null, currentHoldCents: null, currentHoldWithdrawableCents: null },
  });
  // The auction restarts from the starting price, so every bid so far --
  // the dropped lead and everything below it -- belongs to a run that is
  // over. Left in place, they read as live top bids.
  await voidBids(tx, listingId);
  return { released: held };
}

/**
 * Closes an ended auction: no sale (and a full release) if there were no
 * bids, the reserve wasn't met, the seller is no longer active, or the
 * WINNER is no longer active (suspended or banned -- such an account fails
 * app.auth on every route and could never open the order, and a ban landing
 * after moderation's lead sweep read its list would otherwise still settle
 * to it); otherwise converts the held winning bid into a real order.
 */
export async function closeAuction(tx: Tx, listingId: string, now: Date = new Date()) {
  const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId } });
  if (listing.saleType !== 'AUCTION') throw statusCode('not_an_auction', 400);
  if (listing.status !== 'ACTIVE') throw statusCode('wrong_status', 400);
  // The deadline is re-checked HERE, on the row read inside this transaction.
  // The sweep picks its `due` list outside any transaction, and a bid in the
  // last 5 minutes pushes auctionEndsAt forward (placeBid, anti-snipe): one
  // committing between that list and this read used to be closed anyway,
  // settling to the last-second bidder and cancelling the extension every
  // other bidder was promised. Not due is a no-op -- nothing released, status
  // untouched -- and the sweep after the new deadline closes it.
  if (!listing.auctionEndsAt || listing.auctionEndsAt.getTime() > now.getTime()) return { sold: false as const, notDue: true as const };

  const meetsReserve = listing.currentBidCents != null && (!listing.reserveCents || listing.currentBidCents >= listing.reserveCents);
  const active = await sellerActive(tx, listing.creatorId);
  // Media can be REJECTED (transcode, moderation) after bids were placed:
  // the winner is not charged for an item that can no longer be delivered.
  const deliverable = await hasDeliverable(tx, listing);
  const winnerActive = !listing.currentBidderId
    || (await tx.user.findUnique({ where: { id: listing.currentBidderId }, select: { status: true } }))?.status === 'ACTIVE';
  if (!listing.currentBidderId || !listing.currentBidCents || !meetsReserve || !active || !deliverable || !winnerActive) {
    const held = heldNow(listing);
    if (listing.currentBidderId && held > 0) {
      await post(tx, listing.currentBidderId, held, 'AUCTION_BID_RELEASE', listingId, { reserveNotMet: !meetsReserve, sellerInactive: !active, noDeliverable: !deliverable, winnerInactive: !winnerActive }, 'CREDITS', { withdrawableCents: heldWithdrawableNow(listing) });
    }
    // Clear the lead exactly like cancelAuction: with currentHoldCents null
    // heldNow() falls back to currentBidCents, so leaving the bid set would
    // make a hold that was just returned look like it is still held.
    await tx.listing.update({
      where: { id: listingId },
      data: { status: 'REMOVED', currentBidderId: null, currentBidCents: null, currentHoldCents: null, currentHoldWithdrawableCents: null },
    });
    await voidBids(tx, listingId);
    return { sold: false as const };
  }

  const chargeCents = listing.currentBidCents;
  // Route exactly what was held: the part above the bid is the shipping the
  // winner already paid. Never re-read listing.shippingCents here.
  const held = heldNow(listing);
  const shippingCents = Math.max(0, held - chargeCents);
  const platformFee = Math.floor((chargeCents * PLATFORM_FEE_BPS) / 10_000);
  const listingFee = Math.floor((chargeCents * LISTING_FEE_BPS) / 10_000);
  const net = chargeCents - platformFee - listingFee;

  await tx.listing.update({ where: { id: listingId }, data: { status: 'SOLD' } });

  // The order's 18+ / ToS record is the WINNER's own, given on the winning
  // bid -- never a timestamp invented at close. A bid placed before the bid
  // route required it has none, and the order says so (null) rather than
  // claiming a confirmation that never happened.
  const winning = await tx.bid.findFirst({
    where: { listingId, bidderId: listing.currentBidderId, amountCents: chargeCents, voidedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { ageConfirmedAt: true, tosVersion: true },
  });

  const order = await tx.listingOrder.create({
    data: {
      listingId, buyerId: listing.currentBidderId, priceCents: chargeCents, shippingCents,
      platformFeeCents: platformFee, listingFeeCents: listingFee,
      ageConfirmedAt: winning?.ageConfirmedAt ?? null, tosVersion: winning?.tosVersion ?? null,
      shipStatus: listing.kind === 'PHYSICAL' ? 'AWAITING_SHIPMENT' : 'DIGITAL',
    },
  });

  // The winner's funds (bid + shipping) already left their balance at bid
  // time (AUCTION_BID_HOLD) -- route exactly that total, no second debit:
  // creator net + shipping, platform the fees. The three legs sum to `held`.
  await post(tx, listing.creatorId, net + shippingCents, 'MARKETPLACE_SALE', order.id, { auction: true, gross: chargeCents, platformFee, listingFee, shippingCents, fanId: listing.currentBidderId }, 'CREDITS', { earned: true });
  await postPlatformRevenue(tx, platformFee + listingFee, order.id, { source: 'marketplace_auction', platformFee, listingFee });

  return { sold: true as const, order };
}

/** Same bounds as an auction's duration at creation (modules/marketplace.ts POST /listings). */
export const MIN_AUCTION_HOURS = 1;
export const MAX_AUCTION_HOURS = 24 * 30;

/**
 * Puts an auction that ended (or was taken down) WITHOUT a sale back on
 * sale: either as a fresh auction running `auctionDurationHours` from now,
 * or converted to a fixed-price, one-of-a-kind listing at its current
 * priceCents. Every no-sale close (no bids, reserve not met, an inactive
 * winner, nothing deliverable at the time) marks the listing REMOVED with
 * its deadline in the past, and the listing's product media stays attached
 * to it -- media can only ever be attached to one listing, post or DM -- so
 * without this the creator could never sell those uploads again.
 *
 * Only for the creator's own REMOVED, unmoderated auction with no standing
 * lead and no orders: a moderator's takedown is not theirs to undo, a lead
 * means a hold is still out, and an order means it was sold. The status
 * flip is ONE guarded updateMany re-checking all of that in its WHERE, so a
 * takedown committing mid-request is not overwritten.
 */
export async function relistAuction(
  tx: Tx, listingId: string, creatorId: string,
  opts: { auctionDurationHours?: number; saleType?: 'FIXED' | 'AUCTION' },
  now: Date = new Date(),
) {
  const l = await tx.listing.findFirst({ where: { id: listingId, creatorId } });
  if (!l) throw statusCode('not_found', 404);
  if (l.saleType !== 'AUCTION') throw statusCode('not_an_auction', 400);
  if (l.moderatedAt) throw statusCode('removed_by_moderation', 409);
  if (l.status !== 'REMOVED' || l.currentBidderId) throw statusCode('not_relistable', 409);
  if ((await tx.listingOrder.count({ where: { listingId } })) > 0) throw statusCode('listing_has_orders', 409);
  if (!(await sellerActive(tx, creatorId))) throw statusCode('not_available', 400);

  const toFixed = opts.saleType === 'FIXED';
  let data: Record<string, unknown>;
  if (toFixed) {
    // A fixed-price listing has no deadline, reserve or bid state; clear all
    // of it so nothing auction-shaped is left for the close sweep to find.
    data = {
      status: 'ACTIVE', saleType: 'FIXED', unlimited: false, auctionEndsAt: null, reserveCents: null, minBidIncrementCents: null,
      currentBidCents: null, currentBidderId: null, currentHoldCents: null, currentHoldWithdrawableCents: null,
    };
  } else {
    const h = opts.auctionDurationHours;
    if (!Number.isInteger(h) || (h as number) < MIN_AUCTION_HOURS || (h as number) > MAX_AUCTION_HOURS) {
      throw statusCode('auctionDurationHours is required to relist an auction', 400);
    }
    // Same rule as creation: the hidden reserve can never sit below the
    // starting bid (a price edit in the same request has already landed).
    if (l.reserveCents != null && l.reserveCents < l.priceCents) {
      throw statusCode('reserveCents cannot be below the starting bid (priceCents)', 400);
    }
    data = {
      status: 'ACTIVE', auctionEndsAt: new Date(now.getTime() + (h as number) * 3_600_000),
      currentBidCents: null, currentBidderId: null, currentHoldCents: null, currentHoldWithdrawableCents: null,
    };
  }
  const r = await tx.listing.updateMany({
    where: { id: listingId, creatorId, saleType: 'AUCTION', status: 'REMOVED', moderatedAt: null, currentBidderId: null },
    data,
  });
  if (!r.count) throw statusCode('not_relistable', 409);
  // Every path that ends a run without a sale already voided its bids; this
  // also covers bids from before voidedAt existed, so a relisted auction's
  // history always starts empty.
  await voidBids(tx, listingId, now);
  return tx.listing.findUniqueOrThrow({ where: { id: listingId } });
}
