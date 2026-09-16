import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, post, PLATFORM_ID, ESCROW_ID } from './ledger';
import { holdInEscrow, markShipped, confirmReceipt, autoRelease, disputeOrder, resolveDispute, voluntaryRefund } from './escrow';

const prisma = new PrismaClient();

async function makeUser() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01') } });
  return id;
}

async function makeCreator() {
  const userId = await makeUser();
  await prisma.user.update({ where: { id: userId }, data: { role: 'CREATOR' } });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'Test Creator', payoutAsset: 'USDC' } });
  return userId;
}

async function balanceOf(userId: string) {
  const acct = await prisma.account.findUnique({ where: { userId } });
  return acct?.balanceCents ?? 0n;
}

/** Mirrors what marketplace.ts's buy handler does for a physical order: creates the order row and holds the creator's net + shipping in escrow. Doesn't debit a buyer balance -- that part of the purchase flow isn't escrow.ts's responsibility. */
async function makePhysicalOrder(opts: { creatorId: string; buyerId: string; priceCents: number; shippingCents: number; platformFeeCents: number; listingFeeCents: number }) {
  const listing = await prisma.listing.create({
    data: { creatorId: opts.creatorId, title: 'Signed poster', priceCents: opts.priceCents, kind: 'PHYSICAL', shippingCents: opts.shippingCents, unlimited: false },
  });
  const netCentsHeld = opts.priceCents - opts.platformFeeCents - opts.listingFeeCents + opts.shippingCents;
  const order = await money(prisma, async (tx) => {
    const o = await tx.listingOrder.create({
      data: {
        listingId: listing.id, buyerId: opts.buyerId, priceCents: opts.priceCents, shippingCents: opts.shippingCents,
        platformFeeCents: opts.platformFeeCents, listingFeeCents: opts.listingFeeCents,
        ageConfirmedAt: new Date(), tosVersion: 'v1', fulfillmentStatus: 'AWAITING_SHIPMENT', netCentsHeld,
      },
    });
    await holdInEscrow(tx, o.id, netCentsHeld);
    await post(tx, PLATFORM_ID, opts.platformFeeCents + opts.listingFeeCents, 'PLATFORM_FEE', o.id);
    return o;
  });
  return { listing, order, netCentsHeld };
}

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: ESCROW_ID },
    create: { id: ESCROW_ID, email: 'escrow@internal', username: '__escrow__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('escrow: purchase holds the creator payout, never pays out immediately', () => {
  it('leaves the creator balance at zero right after purchase -- money sits in ESCROW_ID', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const escrowBefore = await balanceOf(ESCROW_ID); // ESCROW_ID is a shared pseudo-account across every test in this file -- always diff, never assert absolute
    const { netCentsHeld } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 5000, shippingCents: 800, platformFeeCents: 500, listingFeeCents: 250 });

    expect(await balanceOf(creatorId)).toBe(0n);
    expect((await balanceOf(ESCROW_ID)) - escrowBefore).toBe(BigInt(netCentsHeld));
    expect(netCentsHeld).toBe(5000 - 500 - 250 + 800); // net of item price + full shipping pass-through
  });
});

describe('escrow: markShipped', () => {
  it('starts the auto-release clock and only the listing\'s own creator can do it', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const other = await makeCreator();
    const { order } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 2000, shippingCents: 0, platformFeeCents: 200, listingFeeCents: 100 });

    await expect(money(prisma, (tx) => markShipped(tx, order.id, other, { carrier: 'USPS', trackingNumber: '123' }))).rejects.toThrow('not_found');

    const shipped = await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'ABC123' }));
    expect(shipped.fulfillmentStatus).toBe('SHIPPED');
    expect(shipped.trackingNumber).toBe('ABC123');
    expect(shipped.autoReleaseAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses to ship an order twice', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const { order } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 2000, shippingCents: 0, platformFeeCents: 200, listingFeeCents: 100 });
    await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'A' }));
    await expect(money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'B' }))).rejects.toThrow('wrong_status');
  });
});

describe('escrow: confirmReceipt', () => {
  it('releases escrow to the creator only once the buyer confirms, and only that buyer can', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const someoneElse = await makeUser();
    const escrowBefore = await balanceOf(ESCROW_ID);
    const { order, netCentsHeld } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 5000, shippingCents: 500, platformFeeCents: 500, listingFeeCents: 250 });
    await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'A' }));

    await expect(money(prisma, (tx) => confirmReceipt(tx, order.id, someoneElse))).rejects.toThrow('not_found');
    expect(await balanceOf(creatorId)).toBe(0n); // still held

    const released = await money(prisma, (tx) => confirmReceipt(tx, order.id, buyerId));
    expect(released.fulfillmentStatus).toBe('DELIVERED_CONFIRMED');
    expect(released.netCentsHeld).toBe(0);
    expect(await balanceOf(creatorId)).toBe(BigInt(netCentsHeld));
    expect(await balanceOf(ESCROW_ID)).toBe(escrowBefore); // held then released within this test -- nets back to where it started
  });

  it('cannot be released twice (no double-pay)', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const { order } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 3000, shippingCents: 0, platformFeeCents: 300, listingFeeCents: 150 });
    await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'A' }));
    await money(prisma, (tx) => confirmReceipt(tx, order.id, buyerId));
    await expect(money(prisma, (tx) => confirmReceipt(tx, order.id, buyerId))).rejects.toThrow('wrong_status');
  });

  it('cannot be confirmed before shipping', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const { order } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 3000, shippingCents: 0, platformFeeCents: 300, listingFeeCents: 150 });
    await expect(money(prisma, (tx) => confirmReceipt(tx, order.id, buyerId))).rejects.toThrow('wrong_status');
  });
});

describe('escrow: autoRelease', () => {
  it('pays out the creator the same way confirmReceipt does, but tags the order AUTO_RELEASED', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const { order, netCentsHeld } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 4000, shippingCents: 300, platformFeeCents: 400, listingFeeCents: 200 });
    await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'A' }));

    const released = await money(prisma, (tx) => autoRelease(tx, order.id));
    expect(released.fulfillmentStatus).toBe('AUTO_RELEASED');
    expect(await balanceOf(creatorId)).toBe(BigInt(netCentsHeld));
  });
});

describe('escrow: disputeOrder', () => {
  it('extends the clock instead of freezing it, and files a Report only the buyer can raise', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const someoneElse = await makeUser();
    const { order } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 3000, shippingCents: 0, platformFeeCents: 300, listingFeeCents: 150 });
    const shipped = await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'A' }));

    await expect(money(prisma, (tx) => disputeOrder(tx, order.id, someoneElse, 'never arrived'))).rejects.toThrow('not_found');

    const disputed = await money(prisma, (tx) => disputeOrder(tx, order.id, buyerId, 'item never arrived'));
    expect(disputed.fulfillmentStatus).toBe('DISPUTED');
    // A dispute is a pause button, not a freeze -- it still has a real (extended) auto-release date, not null.
    expect(disputed.autoReleaseAt).not.toBeNull();
    expect(disputed.autoReleaseAt!.getTime()).toBeGreaterThan(shipped.autoReleaseAt!.getTime());

    const report = await prisma.report.findFirst({ where: { targetType: 'listing_order', targetId: order.id } });
    expect(report?.reason).toBe('item never arrived');
    expect(report?.reporterId).toBe(buyerId);
  });

  it('still auto-releases to the creator if the dispute grace period runs out unresolved -- silence favors whoever already shipped', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const { order, netCentsHeld } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 3000, shippingCents: 0, platformFeeCents: 300, listingFeeCents: 150 });
    await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'A' }));
    await money(prisma, (tx) => disputeOrder(tx, order.id, buyerId, 'never arrived'));

    // autoRelease doesn't check the clock itself (the worker's query does) -- it just needs the status to still allow it.
    const released = await money(prisma, (tx) => autoRelease(tx, order.id));
    expect(released.fulfillmentStatus).toBe('AUTO_RELEASED');
    expect(await balanceOf(creatorId)).toBe(BigInt(netCentsHeld));
  });

  it('cannot be raised before shipping, or twice', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const { order } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 3000, shippingCents: 0, platformFeeCents: 300, listingFeeCents: 150 });
    await expect(money(prisma, (tx) => disputeOrder(tx, order.id, buyerId, 'too early'))).rejects.toThrow('wrong_status');

    await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'A' }));
    await money(prisma, (tx) => disputeOrder(tx, order.id, buyerId, 'first dispute'));
    await expect(money(prisma, (tx) => disputeOrder(tx, order.id, buyerId, 'second dispute'))).rejects.toThrow('wrong_status');
  });
});

describe('escrow: resolveDispute', () => {
  it('release sides with the creator -- same payout as confirmation', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const { order, netCentsHeld } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 3000, shippingCents: 0, platformFeeCents: 300, listingFeeCents: 150 });
    await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'A' }));
    await money(prisma, (tx) => disputeOrder(tx, order.id, buyerId, 'wrong item'));

    const resolved = await money(prisma, (tx) => resolveDispute(tx, order.id, 'release'));
    expect(resolved.fulfillmentStatus).toBe('DELIVERED_CONFIRMED');
    expect(await balanceOf(creatorId)).toBe(BigInt(netCentsHeld));
  });

  it('refund gives the buyer everything back (price + shipping) and claws back the platform fee too', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const priceCents = 5000, shippingCents = 700, platformFeeCents = 500, listingFeeCents = 250;
    const escrowBefore = await balanceOf(ESCROW_ID);
    const { order } = await makePhysicalOrder({ creatorId, buyerId, priceCents, shippingCents, platformFeeCents, listingFeeCents });
    await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'A' }));
    await money(prisma, (tx) => disputeOrder(tx, order.id, buyerId, 'item destroyed in transit'));

    const platformBefore = await balanceOf(PLATFORM_ID);
    const resolved = await money(prisma, (tx) => resolveDispute(tx, order.id, 'refund'));

    expect(resolved.fulfillmentStatus).toBe('REFUNDED');
    expect(resolved.netCentsHeld).toBe(0);
    expect(await balanceOf(creatorId)).toBe(0n); // creator never got paid for a refunded sale
    expect(await balanceOf(ESCROW_ID)).toBe(escrowBefore); // held then refunded within this test -- nets back to where it started
    expect(await balanceOf(buyerId)).toBe(BigInt(priceCents + shippingCents));
    expect(await balanceOf(PLATFORM_ID)).toBe(platformBefore - BigInt(platformFeeCents + listingFeeCents));
  });

  it('refuses to resolve a dispute that was never opened', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const { order } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 2000, shippingCents: 0, platformFeeCents: 200, listingFeeCents: 100 });
    await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'A' }));
    await expect(money(prisma, (tx) => resolveDispute(tx, order.id, 'release'))).rejects.toThrow('wrong_status');
  });
});

describe('escrow: voluntaryRefund', () => {
  it('lets the creator refund on their own, no dispute or admin needed', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const priceCents = 4000, shippingCents = 500, platformFeeCents = 400, listingFeeCents = 200;
    const { order } = await makePhysicalOrder({ creatorId, buyerId, priceCents, shippingCents, platformFeeCents, listingFeeCents });
    await money(prisma, (tx) => markShipped(tx, order.id, creatorId, { carrier: 'USPS', trackingNumber: 'A' }));
    // No dispute was ever raised -- the creator just decided to refund.

    const platformBefore = await balanceOf(PLATFORM_ID);
    const refunded = await money(prisma, (tx) => voluntaryRefund(tx, order.id, creatorId));

    expect(refunded.fulfillmentStatus).toBe('REFUNDED');
    expect(await balanceOf(creatorId)).toBe(0n);
    expect(await balanceOf(buyerId)).toBe(BigInt(priceCents + shippingCents));
    expect(await balanceOf(PLATFORM_ID)).toBe(platformBefore - BigInt(platformFeeCents + listingFeeCents));
  });

  it('works even before shipping (creator realizes they can\'t fulfill it) and only the listing\'s own creator can call it', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const other = await makeCreator();
    const priceCents = 2000, platformFeeCents = 200, listingFeeCents = 100;
    const { order } = await makePhysicalOrder({ creatorId, buyerId, priceCents, shippingCents: 0, platformFeeCents, listingFeeCents });

    await expect(money(prisma, (tx) => voluntaryRefund(tx, order.id, other))).rejects.toThrow('not_found');

    const refunded = await money(prisma, (tx) => voluntaryRefund(tx, order.id, creatorId));
    expect(refunded.fulfillmentStatus).toBe('REFUNDED');
    expect(await balanceOf(buyerId)).toBe(BigInt(priceCents));
  });

  it('cannot be done twice', async () => {
    const creatorId = await makeCreator();
    const buyerId = await makeUser();
    const { order } = await makePhysicalOrder({ creatorId, buyerId, priceCents: 2000, shippingCents: 0, platformFeeCents: 200, listingFeeCents: 100 });
    await money(prisma, (tx) => voluntaryRefund(tx, order.id, creatorId));
    await expect(money(prisma, (tx) => voluntaryRefund(tx, order.id, creatorId))).rejects.toThrow('wrong_status');
  });
});
