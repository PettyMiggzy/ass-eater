import { post, lockBalance, PLATFORM_ID, InsufficientFunds, type Tx } from './ledger';
import { PLATFORM_FEE_BPS, LISTING_FEE_BPS, MARKETPLACE_TOS_VERSION } from './marketplace-fees';

// eBay-style auctions on the marketplace. Bids settle in the USD-backed
// balanceCents pool ONLY -- never the $ONLYASS discount pool. A bid has to
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

export async function placeBid(tx: Tx, listingId: string, bidderId: string, amountCents: number) {
  const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId } });
  if (listing.saleType !== 'AUCTION') throw statusCode('not_an_auction', 400);
  if (listing.status !== 'ACTIVE') throw statusCode('not_available', 400);
  if (!listing.auctionEndsAt || listing.auctionEndsAt <= new Date()) throw statusCode('auction_ended', 400);
  if (listing.creatorId === bidderId) throw statusCode('self_bid', 400);

  const floor = listing.currentBidCents != null
    ? listing.currentBidCents + minIncrement(listing.currentBidCents, listing.minBidIncrementCents)
    : listing.priceCents; // starting bid
  if (amountCents < floor) throw statusCode('bid_too_low', 400);

  const bal = await lockBalance(tx, bidderId, 'USD');
  if (bal < BigInt(amountCents)) throw new InsufficientFunds();

  // Release the previous leading bid's hold before taking the new one -- covers a bidder raising their own bid too (net effect: the marginal increase is held).
  if (listing.currentBidderId && listing.currentBidCents) {
    await post(tx, listing.currentBidderId, listing.currentBidCents, 'AUCTION_BID_RELEASE', listingId, { outbidBy: bidderId });
  }
  await post(tx, bidderId, -amountCents, 'AUCTION_BID_HOLD', listingId);

  const bid = await tx.bid.create({ data: { listingId, bidderId, amountCents } });

  let auctionEndsAt = listing.auctionEndsAt;
  if (auctionEndsAt.getTime() - Date.now() < ANTI_SNIPE_WINDOW_MS) {
    auctionEndsAt = new Date(Date.now() + ANTI_SNIPE_EXTENSION_MS);
  }

  await tx.listing.update({ where: { id: listingId }, data: { currentBidCents: amountCents, currentBidderId: bidderId, auctionEndsAt } });
  return bid;
}

/** Closes an ended auction: no sale (and a full release) if there were no bids or the reserve wasn't met, otherwise converts the held winning bid into a real order. */
export async function closeAuction(tx: Tx, listingId: string) {
  const listing = await tx.listing.findUniqueOrThrow({ where: { id: listingId } });
  if (listing.saleType !== 'AUCTION') throw statusCode('not_an_auction', 400);
  if (listing.status !== 'ACTIVE') throw statusCode('wrong_status', 400);

  const meetsReserve = listing.currentBidCents != null && (!listing.reserveCents || listing.currentBidCents >= listing.reserveCents);
  if (!listing.currentBidderId || !listing.currentBidCents || !meetsReserve) {
    if (listing.currentBidderId && listing.currentBidCents) {
      await post(tx, listing.currentBidderId, listing.currentBidCents, 'AUCTION_BID_RELEASE', listingId, { reserveNotMet: !meetsReserve });
    }
    await tx.listing.update({ where: { id: listingId }, data: { status: 'REMOVED' } });
    return { sold: false as const };
  }

  const chargeCents = listing.currentBidCents;
  const shippingCents = listing.kind === 'PHYSICAL' ? listing.shippingCents : 0;
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

  // The winning bidder's funds already left their balance at bid time (AUCTION_BID_HOLD) -- just route the proceeds, no second debit.
  await post(tx, listing.creatorId, net + shippingCents, 'MARKETPLACE_SALE', order.id, { auction: true, gross: chargeCents, platformFee, listingFee, shippingCents });
  await post(tx, PLATFORM_ID, platformFee + listingFee, 'PLATFORM_FEE', order.id, { source: 'marketplace_auction', platformFee, listingFee });

  return { sold: true as const, order };
}
