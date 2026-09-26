import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, post, PLATFORM_ID } from './ledger';
import { placeBid, closeAuction, cancelAuction, minIncrement, relistAuction } from './auctions';

const prisma = new PrismaClient();

async function makeUser() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01') } });
  return id;
}

async function makeCreator() {
  const userId = await makeUser();
  await prisma.user.update({ where: { id: userId }, data: { role: 'CREATOR', kycStatus: 'APPROVED' } });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'Test Creator', payoutAsset: 'STABLE' } });
  return userId;
}

async function fund(userId: string, cents: number) {
  await money(prisma, (tx) => post(tx, userId, cents, 'ADJUSTMENT'));
}

async function balanceOf(userId: string) {
  const acct = await prisma.account.findUnique({ where: { userId } });
  return acct?.balanceCents ?? 0n;
}

async function fundOnlyOne(userId: string, cents: number) {
  await money(prisma, (tx) => post(tx, userId, cents, 'DEPOSIT', undefined, undefined, 'ONLYONE'));
}

/** endsInMs negative = already-ended, for testing closeAuction directly. */
async function makeAuctionListing(creatorId: string, opts: { startingBidCents?: number; endsInMs?: number; reserveCents?: number; minBidIncrementCents?: number; kind?: 'DIGITAL' | 'PHYSICAL'; shippingCents?: number } = {}) {
  return prisma.listing.create({
    data: {
      creatorId, title: 'Signed poster', unlimited: false, kind: opts.kind ?? 'DIGITAL', shippingCents: opts.shippingCents ?? 0,
      saleType: 'AUCTION', priceCents: opts.startingBidCents ?? 1000,
      auctionEndsAt: new Date(Date.now() + (opts.endsInMs ?? 3_600_000)),
      reserveCents: opts.reserveCents, minBidIncrementCents: opts.minBidIncrementCents,
      // A DIGITAL listing's product is its media; without a READY item there
      // is nothing to deliver and bids are refused (hasDeliverable).
      ...((opts.kind ?? 'DIGITAL') === 'DIGITAL' ? { media: { create: { ownerId: creatorId, key: `raw/${creatorId}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY' } } } : {}),
    },
  });
}

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('auctions minIncrement', () => {
  it('uses the greater of the $1 floor or 5%', () => {
    expect(minIncrement(1000)).toBe(100); // 5% of 1000 = 50, floor wins
    expect(minIncrement(10_000)).toBe(500); // 5% of 10000 = 500, bps wins
  });

  it('respects a creator-set override', () => {
    expect(minIncrement(10_000, 50)).toBe(50);
    expect(minIncrement(10_000, 0)).toBe(0); // an explicit 0 is still an override, not "unset"
  });
});

describe('auctions placeBid', () => {
  it('accepts a valid first bid at the starting price and holds the bidder\'s funds', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 5000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000 });

    const bid = await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 1000));
    expect(bid.amountCents).toBe(1000);
    expect(await balanceOf(bidderId)).toBe(4000n);

    const updated = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.currentBidCents).toBe(1000);
    expect(updated.currentBidderId).toBe(bidderId);
  });

  it('rejects a bid below the starting price', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 5000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000 });
    await expect(money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 999))).rejects.toThrow('bid_too_low');
  });

  it('rejects a bid that does not clear the minimum increment over the current bid', async () => {
    const creatorId = await makeCreator();
    const bidder1 = await makeUser(), bidder2 = await makeUser();
    await fund(bidder1, 50_000); await fund(bidder2, 50_000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 10_000 });
    await money(prisma, (tx) => placeBid(tx, listing.id, bidder1, 10_000));
    // 5% of 10,000 = 500 (bigger than the $1 floor here), so 10,490 doesn't clear it
    await expect(money(prisma, (tx) => placeBid(tx, listing.id, bidder2, 10_490))).rejects.toThrow('bid_too_low');
    await expect(money(prisma, (tx) => placeBid(tx, listing.id, bidder2, 10_500))).resolves.toBeDefined();
  });

  it('releases the outbid bidder\'s hold and holds the new leader\'s funds instead', async () => {
    const creatorId = await makeCreator();
    const bidder1 = await makeUser(), bidder2 = await makeUser();
    await fund(bidder1, 5000); await fund(bidder2, 5000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000 });

    await money(prisma, (tx) => placeBid(tx, listing.id, bidder1, 1000));
    expect(await balanceOf(bidder1)).toBe(4000n);

    await money(prisma, (tx) => placeBid(tx, listing.id, bidder2, 2000));
    expect(await balanceOf(bidder1)).toBe(5000n); // fully released
    expect(await balanceOf(bidder2)).toBe(3000n); // now holding

    const updated = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.currentBidderId).toBe(bidder2);
    expect(updated.currentBidCents).toBe(2000);
  });

  it('lets a bidder raise their own leading bid, holding only the marginal increase', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 5000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000 });

    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 1000));
    expect(await balanceOf(bidderId)).toBe(4000n);
    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 1500));
    expect(await balanceOf(bidderId)).toBe(3500n); // only the extra 500 held, not double-charged
  });

  it('rejects insufficient funds without touching any balance', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 500);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000 });
    await expect(money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 1000))).rejects.toThrow('insufficient_funds');
    expect(await balanceOf(bidderId)).toBe(500n);
  });

  it('rejects a bid from the listing\'s own creator', async () => {
    const creatorId = await makeCreator();
    await fund(creatorId, 5000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000 });
    await expect(money(prisma, (tx) => placeBid(tx, listing.id, creatorId, 1000))).rejects.toThrow('self_bid');
  });

  it('rejects a bid on an auction that has already ended', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 5000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000, endsInMs: -1000 });
    await expect(money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 1000))).rejects.toThrow('auction_ended');
  });

  it('rejects bidding on a FIXED-price listing', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 5000);
    const listing = await prisma.listing.create({ data: { creatorId, title: 'Fixed item', priceCents: 1000, saleType: 'FIXED' } });
    await expect(money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 1000))).rejects.toThrow('not_an_auction');
  });

  it('extends the deadline (anti-snipe) when a bid lands in the closing window', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 5000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000, endsInMs: 60_000 }); // 1 minute left -- inside the 5-minute anti-snipe window
    const before = listing.auctionEndsAt!.getTime();
    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 1000));
    const updated = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.auctionEndsAt!.getTime()).toBeGreaterThan(before);
  });

  it('does not extend the deadline for a bid well before the closing window', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 5000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000, endsInMs: 3_600_000 }); // 1 hour left
    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 1000));
    const updated = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.auctionEndsAt!.getTime()).toBe(listing.auctionEndsAt!.getTime());
  });

  it('only ever locks the USD balanceCents pool, never the $ONLYONE pool, regardless of how much ONLYONE balance the bidder holds', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fundOnlyOne(bidderId, 100_000); // plenty of ONLYONE balance
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000 });
    await expect(money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 1000))).rejects.toThrow('insufficient_funds');
  });
});

describe('auctions closeAuction', () => {
  it('is a no-op while the deadline is still in the future (an anti-snipe extension landed after the sweep picked it)', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 10_000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000, endsInMs: 60_000 });
    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 1000));
    const result = await money(prisma, (tx) => closeAuction(tx, listing.id));
    expect(result.sold).toBe(false);
    expect((result as { notDue?: boolean }).notDue).toBe(true);
    const still = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(still.status).toBe('ACTIVE');
    expect(still.currentBidderId).toBe(bidderId);
    expect(await balanceOf(bidderId)).toBe(9000n); // hold not released
    // Once the (extended) deadline passes, the next sweep sells it.
    const sold = await money(prisma, (tx) => closeAuction(tx, listing.id, new Date(still.auctionEndsAt!.getTime() + 1)));
    expect(sold.sold).toBe(true);
  });

  it('removes the listing with no sale when there were no bids', async () => {
    const creatorId = await makeCreator();
    const listing = await makeAuctionListing(creatorId, { endsInMs: -1000 });
    const result = await money(prisma, (tx) => closeAuction(tx, listing.id));
    expect(result.sold).toBe(false);
    const updated = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.status).toBe('REMOVED');
  });

  it('sells to the leading bidder, pays the creator, and takes the platform fee -- no second charge to the bidder', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 10_000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000, endsInMs: 1000 });
    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 2000));
    expect(await balanceOf(bidderId)).toBe(8000n); // held at bid time

    // simulate the clock running out
    await prisma.listing.update({ where: { id: listing.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });
    const platformBefore = await balanceOf(PLATFORM_ID);
    const result = await money(prisma, (tx) => closeAuction(tx, listing.id));

    expect(result.sold).toBe(true);
    expect(await balanceOf(bidderId)).toBe(8000n); // unchanged -- no second debit
    expect(await balanceOf(creatorId)).toBe(1700n); // 2000 - 10% - 5% = 1700
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(300n);

    const updated = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.status).toBe('SOLD');
  });

  it('releases the held bid and removes the listing when the reserve is not met', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 10_000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000, reserveCents: 5000, endsInMs: 1000 });
    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 2000));
    expect(await balanceOf(bidderId)).toBe(8000n);

    await prisma.listing.update({ where: { id: listing.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });
    const result = await money(prisma, (tx) => closeAuction(tx, listing.id));

    expect(result.sold).toBe(false);
    expect(await balanceOf(bidderId)).toBe(10_000n); // fully released
    const updated = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(updated.status).toBe('REMOVED');
  });

  it('adds the shipping fee on top for a physical auction item, still not commissioned', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 10_000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000, kind: 'PHYSICAL', shippingCents: 500, endsInMs: 1000 });
    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 2000));

    await prisma.listing.update({ where: { id: listing.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });
    await money(prisma, (tx) => closeAuction(tx, listing.id));

    // The winner pays shipping too: bid + shipping is held at bid time.
    expect(await balanceOf(bidderId)).toBe(7500n);
    // creator gets (2000 - 10% - 5%) + 500 shipping = 1700 + 500 = 2200; platform fee still only off the 2000 item price
    expect(await balanceOf(creatorId)).toBe(2200n);
    // Nothing minted: every posting for this auction nets to zero.
    const order0 = await prisma.listingOrder.findFirstOrThrow({ where: { listingId: listing.id } });
    const legs = await prisma.ledgerEntry.aggregate({ _sum: { amountCents: true }, where: { refId: { in: [listing.id, order0.id] } } });
    expect(legs._sum.amountCents).toBe(0n);
    const order = await prisma.listingOrder.findFirstOrThrow({ where: { listingId: listing.id } });
    expect(order.shippingCents).toBe(500);
    expect(order.shipStatus).toBe('AWAITING_SHIPMENT');
  });

  it('never releases a hold twice: cancelling an auction already closed without a sale is a no-op', async () => {
    // The admin ban loop reads the seller's ACTIVE auctions outside any
    // transaction; the sweep can close one (seller now inactive -> no sale,
    // full release) before its cancelAuction runs.
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 10_000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000, endsInMs: 1000 });
    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 2000));
    await prisma.user.update({ where: { id: creatorId }, data: { status: 'BANNED' } });
    await prisma.listing.update({ where: { id: listing.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });

    const closed = await money(prisma, (tx) => closeAuction(tx, listing.id));
    expect(closed.sold).toBe(false);
    expect(await balanceOf(bidderId)).toBe(10_000n);
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(after.currentBidderId).toBeNull();
    expect(after.currentHoldCents).toBeNull();

    const r = await money(prisma, (tx) => cancelAuction(tx, listing.id, 'seller_banned'));
    expect(r.released).toBe(0);
    expect(await balanceOf(bidderId)).toBe(10_000n);
    const legs = await prisma.ledgerEntry.aggregate({ _sum: { amountCents: true }, where: { refId: listing.id } });
    expect(legs._sum.amountCents).toBe(0n);
  });

  it('cancelling an auction the sweep already SOLD is a no-op, not an error', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 10_000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000, endsInMs: 1000 });
    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 2000));
    await prisma.listing.update({ where: { id: listing.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });
    expect((await money(prisma, (tx) => closeAuction(tx, listing.id))).sold).toBe(true);

    const r = await money(prisma, (tx) => cancelAuction(tx, listing.id, 'seller_banned'));
    expect(r.released).toBe(0);
    expect(await balanceOf(bidderId)).toBe(8000n);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('SOLD');
  });

  it('refuses to close an auction that is not ACTIVE', async () => {
    const creatorId = await makeCreator();
    const listing = await makeAuctionListing(creatorId, { endsInMs: -1000 });
    await money(prisma, (tx) => closeAuction(tx, listing.id)); // first close: REMOVED (no bids)
    await expect(money(prisma, (tx) => closeAuction(tx, listing.id))).rejects.toThrow('wrong_status');
  });
});

describe('auctions relistAuction (an unsold auction can go back on sale)', () => {
  it('restarts an auction that closed with the reserve unmet, with a fresh deadline and no bid state, and it can then sell', async () => {
    const creatorId = await makeCreator();
    const bidderId = await makeUser();
    await fund(bidderId, 10_000);
    const listing = await makeAuctionListing(creatorId, { startingBidCents: 1000, reserveCents: 5000, endsInMs: 1000 });
    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 4000));
    await prisma.listing.update({ where: { id: listing.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });
    expect((await money(prisma, (tx) => closeAuction(tx, listing.id))).sold).toBe(false);
    const mediaBefore = await prisma.media.findMany({ where: { listingId: listing.id } });
    expect(mediaBefore.length).toBe(1);

    const before = Date.now();
    const relisted = await money(prisma, (tx) => relistAuction(tx, listing.id, creatorId, { auctionDurationHours: 24 }));
    expect(relisted.status).toBe('ACTIVE');
    expect(relisted.saleType).toBe('AUCTION');
    expect(relisted.currentBidderId).toBeNull();
    expect(relisted.currentBidCents).toBeNull();
    expect(relisted.auctionEndsAt!.getTime()).toBeGreaterThanOrEqual(before + 24 * 3_600_000 - 1000);
    // Same media, still attached -- nothing had to be uploaded again.
    expect((await prisma.media.findMany({ where: { listingId: listing.id } })).map((m) => m.id)).toEqual(mediaBefore.map((m) => m.id));

    // The rerun works end to end: a bid meeting the reserve sells.
    await money(prisma, (tx) => placeBid(tx, listing.id, bidderId, 5000));
    await prisma.listing.update({ where: { id: listing.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });
    expect((await money(prisma, (tx) => closeAuction(tx, listing.id))).sold).toBe(true);
    expect(await balanceOf(bidderId)).toBe(5000n);
  });

  it('converts an unsold auction into a fixed-price one-of-a-kind listing with every auction field cleared', async () => {
    const creatorId = await makeCreator();
    const listing = await makeAuctionListing(creatorId, { endsInMs: -1000, reserveCents: 2000, minBidIncrementCents: 50 });
    await money(prisma, (tx) => closeAuction(tx, listing.id));
    const fixed = await money(prisma, (tx) => relistAuction(tx, listing.id, creatorId, { saleType: 'FIXED' }));
    expect(fixed).toMatchObject({ status: 'ACTIVE', saleType: 'FIXED', unlimited: false, auctionEndsAt: null, reserveCents: null, minBidIncrementCents: null });
  });

  it('refuses without a duration, on a live auction, on a moderated takedown, on a sold one, and for anyone but the creator', async () => {
    const creatorId = await makeCreator();
    const other = await makeCreator();
    const ended = await makeAuctionListing(creatorId, { endsInMs: -1000 });
    await money(prisma, (tx) => closeAuction(tx, ended.id));
    await expect(money(prisma, (tx) => relistAuction(tx, ended.id, creatorId, {}))).rejects.toThrow(/auctionDurationHours/);
    await expect(money(prisma, (tx) => relistAuction(tx, ended.id, creatorId, { auctionDurationHours: 0 }))).rejects.toThrow(/auctionDurationHours/);
    await expect(money(prisma, (tx) => relistAuction(tx, ended.id, other, { auctionDurationHours: 24 }))).rejects.toThrow('not_found');

    const live = await makeAuctionListing(creatorId, { endsInMs: 3_600_000 });
    await expect(money(prisma, (tx) => relistAuction(tx, live.id, creatorId, { auctionDurationHours: 24 }))).rejects.toThrow('not_relistable');

    const takenDown = await makeAuctionListing(creatorId, { endsInMs: -1000 });
    await prisma.listing.update({ where: { id: takenDown.id }, data: { status: 'REMOVED', moderatedAt: new Date(), moderatedReason: 'REPORT' } });
    await expect(money(prisma, (tx) => relistAuction(tx, takenDown.id, creatorId, { auctionDurationHours: 24 }))).rejects.toThrow('removed_by_moderation');

    const bidderId = await makeUser();
    await fund(bidderId, 10_000);
    const sold = await makeAuctionListing(creatorId, { endsInMs: 1000 });
    await money(prisma, (tx) => placeBid(tx, sold.id, bidderId, 1000));
    await prisma.listing.update({ where: { id: sold.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });
    await money(prisma, (tx) => closeAuction(tx, sold.id));
    await expect(money(prisma, (tx) => relistAuction(tx, sold.id, creatorId, { auctionDurationHours: 24 }))).rejects.toThrow('not_relistable');
  });

  it('refuses a relist whose reserve would sit below the starting price', async () => {
    const creatorId = await makeCreator();
    const listing = await makeAuctionListing(creatorId, { endsInMs: -1000, startingBidCents: 1000, reserveCents: 1500 });
    await money(prisma, (tx) => closeAuction(tx, listing.id));
    await expect(money(prisma, async (tx) => {
      await tx.listing.update({ where: { id: listing.id }, data: { priceCents: 3000 } });
      return relistAuction(tx, listing.id, creatorId, { auctionDurationHours: 24 });
    })).rejects.toThrow(/reserveCents/);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('REMOVED');
  });
});
