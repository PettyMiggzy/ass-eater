import { post, lockBalance, InsufficientFunds, isVip, type Tx, postPlatformRevenue } from './ledger.js';
import { PLATFORM_FEE_BPS, LISTING_FEE_BPS, MARKETPLACE_TOS_VERSION } from './marketplace-fees.js';

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

async function sellerActive(tx: Tx, creatorId: string) {
  const u = await tx.user.findUnique({ where: { id: creatorId }, select: { status: true } });
  return u?.status === 'ACTIVE';
}

export async function placeBid(tx: Tx, listingId: string, bidderId: string, amountCents: number) {
  const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId } });
  if (listing.saleType !== 'AUCTION') throw statusCode('not_an_auction', 400);
  if (listing.status !== 'ACTIVE') throw statusCode('not_available', 400);
  if (!listing.auctionEndsAt || listing.auctionEndsAt <= new Date()) throw statusCode('auction_ended', 400);
  if (listing.creatorId === bidderId) throw statusCode('self_bid', 400);
  // A suspended or banned seller's auctions stay up only so the close can
  // release holds -- nobody new gets their money tied up in one.
  if (!(await sellerActive(tx, listing.creatorId))) throw statusCode('not_available', 400);
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
  if (listing.currentBidderId && heldNow(listing) > 0) {
    await post(tx, listing.currentBidderId, heldNow(listing), 'AUCTION_BID_RELEASE', listingId, { outbidBy: bidderId });
  }
  await post(tx, bidderId, -holdCents, 'AUCTION_BID_HOLD', listingId, { bidCents: amountCents, shippingCents: holdCents - amountCents });

  const bid = await tx.bid.create({ data: { listingId, bidderId, amountCents, heldCents: holdCents } });

  let auctionEndsAt = listing.auctionEndsAt;
  if (auctionEndsAt.getTime() - Date.now() < ANTI_SNIPE_WINDOW_MS) {
    auctionEndsAt = new Date(Date.now() + ANTI_SNIPE_EXTENSION_MS);
  }

  await tx.listing.update({ where: { id: listingId }, data: { currentBidCents: amountCents, currentBidderId: bidderId, currentHoldCents: holdCents, auctionEndsAt } });
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
    await post(tx, listing.currentBidderId, held, 'AUCTION_BID_RELEASE', listingId, { reason });
  }
  await tx.listing.update({
    where: { id: listingId },
    data: { status: 'REMOVED', currentBidderId: null, currentBidCents: null, currentHoldCents: null },
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
  if (!listing.currentBidderId || !listing.currentBidCents || !meetsReserve || !active) {
    const held = heldNow(listing);
    if (listing.currentBidderId && held > 0) {
      await post(tx, listing.currentBidderId, held, 'AUCTION_BID_RELEASE', listingId, { reserveNotMet: !meetsReserve, sellerInactive: !active });
    }
    // Clear the lead exactly like cancelAuction: with currentHoldCents null
    // heldNow() falls back to currentBidCents, so leaving the bid set would
    // make a hold that was just returned look like it is still held.
    await tx.listing.update({
      where: { id: listingId },
      data: { status: 'REMOVED', currentBidderId: null, currentBidCents: null, currentHoldCents: null },
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

  const order = await tx.listingOrder.create({
    data: {
      listingId, buyerId: listing.currentBidderId, priceCents: chargeCents, shippingCents,
      platformFeeCents: platformFee, listingFeeCents: listingFee,
      ageConfirmedAt: new Date(), tosVersion: MARKETPLACE_TOS_VERSION,
      shipStatus: listing.kind === 'PHYSICAL' ? 'AWAITING_SHIPMENT' : 'DIGITAL',
    },
  });

  // The winner's funds (bid + shipping) already left their balance at bid
  // time (AUCTION_BID_HOLD) -- route exactly that total, no second debit:
  // creator net + shipping, platform the fees. The three legs sum to `held`.
  await post(tx, listing.creatorId, net + shippingCents, 'MARKETPLACE_SALE', order.id, { auction: true, gross: chargeCents, platformFee, listingFee, shippingCents, fanId: listing.currentBidderId });
  await postPlatformRevenue(tx, platformFee + listingFee, order.id, { source: 'marketplace_auction', platformFee, listingFee });

  return { sold: true as const, order };
}
