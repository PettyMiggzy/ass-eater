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
    await post(tx, listing.currentBidderId, heldNow(listing), 'AUCTION_BID_RELEASE', listingId, { outbidBy: bidderId }, 'CREDITS', { withdrawableCents: heldWithdrawableNow(listing) });
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
  return { released: listing.currentBidderId ? held : 0 };
}

/** Closes an ended auction: no sale (and a full release) if there were no bids, the reserve wasn't met or the seller is no longer active, otherwise converts the held winning bid into a real order. */
export async function closeAuction(tx: Tx, listingId: string) {
  const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId } });
  if (listing.saleType !== 'AUCTION') throw statusCode('not_an_auction', 400);
  if (listing.status !== 'ACTIVE') throw statusCode('wrong_status', 400);

  const meetsReserve = listing.currentBidCents != null && (!listing.reserveCents || listing.currentBidCents >= listing.reserveCents);
  const active = await sellerActive(tx, listing.creatorId);
  // Media can be REJECTED (transcode, moderation) after bids were placed:
  // the winner is not charged for an item that can no longer be delivered.
  const deliverable = await hasDeliverable(tx, listing);
  if (!listing.currentBidderId || !listing.currentBidCents || !meetsReserve || !active || !deliverable) {
    const held = heldNow(listing);
    if (listing.currentBidderId && held > 0) {
      await post(tx, listing.currentBidderId, held, 'AUCTION_BID_RELEASE', listingId, { reserveNotMet: !meetsReserve, sellerInactive: !active, noDeliverable: !deliverable }, 'CREDITS', { withdrawableCents: heldWithdrawableNow(listing) });
    }
    // Clear the lead exactly like cancelAuction: with currentHoldCents null
    // heldNow() falls back to currentBidCents, so leaving the bid set would
    // make a hold that was just returned look like it is still held.
    await tx.listing.update({
      where: { id: listingId },
      data: { status: 'REMOVED', currentBidderId: null, currentBidCents: null, currentHoldCents: null, currentHoldWithdrawableCents: null },
    });
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
    where: { listingId, bidderId: listing.currentBidderId, amountCents: chargeCents },
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
