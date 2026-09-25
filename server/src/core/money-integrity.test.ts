import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, post, PLATFORM_ID } from './ledger';
import { placeBid, closeAuction, cancelAuction } from './auctions';
import { canViewPost, inVipWindow } from './access';
import { payNextMinute, ensureMinutePaid, MAX_PREPAID_MS } from './live-billing';
import { sweepLive, endStaleStreamFor } from './live-sweep';
import { storageKeyOf, broadcastCopyKey } from './media-key';

// Regression tests for the P7A2 fix round: auction holds (shipping minted
// from nothing, stranded holds), banned sellers, VIP windows by id, per-
// minute live billing, the live sweep, broadcast media keys and money()'s
// conflict handling.

const prisma = new PrismaClient();

async function makeUser() {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01') } });
  return id;
}
async function makeCreator() {
  const userId = await makeUser();
  await prisma.user.update({ where: { id: userId }, data: { role: 'CREATOR', kycStatus: 'APPROVED' } });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'C', payoutAsset: 'STABLE' } });
  return userId;
}
async function fund(userId: string, cents: number) {
  await money(prisma, (tx) => post(tx, userId, cents, 'ADJUSTMENT'));
}
async function bal(userId: string) {
  return (await prisma.account.findUnique({ where: { userId } }))?.balanceCents ?? 0n;
}
function auction(creatorId: string, o: { kind?: 'DIGITAL' | 'PHYSICAL'; shippingCents?: number; endsInMs?: number; vipEarlyUntil?: Date } = {}) {
  return prisma.listing.create({
    data: {
      creatorId, title: 'Lot', saleType: 'AUCTION', priceCents: 1000, kind: o.kind ?? 'DIGITAL', shippingCents: o.shippingCents ?? 0,
      auctionEndsAt: new Date(Date.now() + (o.endsInMs ?? 3_600_000)), vipEarlyUntil: o.vipEarlyUntil,
      // DIGITAL needs a READY media item to be biddable (core/auctions.ts hasDeliverable).
      ...((o.kind ?? 'DIGITAL') === 'DIGITAL' ? { media: { create: { ownerId: creatorId, key: `raw/${creatorId}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY' as const } } } : {}),
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
afterAll(async () => { await prisma.$disconnect(); });

describe('auction holds', () => {
  it('releases bid + shipping to an outbid bidder, and settles exactly the held total', async () => {
    const creatorId = await makeCreator();
    const a = await makeUser(); const b = await makeUser();
    await fund(a, 10_000); await fund(b, 10_000);
    const l = await auction(creatorId, { kind: 'PHYSICAL', shippingCents: 700 });
    await money(prisma, (tx) => placeBid(tx, l.id, a, 1000));
    expect(await bal(a)).toBe(8300n);
    await money(prisma, (tx) => placeBid(tx, l.id, b, 2000));
    expect(await bal(a)).toBe(10_000n);
    expect(await bal(b)).toBe(7300n);

    // A later edit to the listing's shipping (the old minting lever) changes nothing at close.
    await prisma.listing.update({ where: { id: l.id }, data: { shippingCents: 10_000_000, auctionEndsAt: new Date(Date.now() - 1000) } });
    const r = await money(prisma, (tx) => closeAuction(tx, l.id));
    expect(r.sold).toBe(true);
    expect(await bal(creatorId)).toBe(1700n + 700n);
    const order = await prisma.listingOrder.findFirstOrThrow({ where: { listingId: l.id } });
    expect(order.shippingCents).toBe(700);
    const sum = await prisma.ledgerEntry.aggregate({ _sum: { amountCents: true }, where: { refId: { in: [l.id, order.id] } } });
    expect(sum._sum.amountCents).toBe(0n);
  });

  it('lets a leader raise their own bid with only the increase spendable', async () => {
    const creatorId = await makeCreator();
    const a = await makeUser();
    await fund(a, 2500);
    const l = await auction(creatorId);
    await money(prisma, (tx) => placeBid(tx, l.id, a, 2000));
    await money(prisma, (tx) => placeBid(tx, l.id, a, 2500));
    expect(await bal(a)).toBe(0n);
  });

  it('cancelAuction returns the held total and clears the lead', async () => {
    const creatorId = await makeCreator();
    const a = await makeUser();
    await fund(a, 5000);
    const l = await auction(creatorId, { kind: 'PHYSICAL', shippingCents: 300 });
    await money(prisma, (tx) => placeBid(tx, l.id, a, 1000));
    expect(await bal(a)).toBe(3700n);
    await money(prisma, (tx) => cancelAuction(tx, l.id, 'removed_by_creator'));
    expect(await bal(a)).toBe(5000n);
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.status).toBe('REMOVED');
    expect(after.currentBidderId).toBeNull();
    expect(after.currentHoldCents).toBeNull();
  });

  it('closes with no sale and a full release when the seller was banned', async () => {
    const creatorId = await makeCreator();
    const a = await makeUser();
    await fund(a, 5000);
    const l = await auction(creatorId);
    await money(prisma, (tx) => placeBid(tx, l.id, a, 1500));
    await prisma.user.update({ where: { id: creatorId }, data: { status: 'BANNED' } });
    await prisma.listing.update({ where: { id: l.id }, data: { auctionEndsAt: new Date(Date.now() - 1000) } });
    const r = await money(prisma, (tx) => closeAuction(tx, l.id));
    expect(r.sold).toBe(false);
    expect(await bal(a)).toBe(5000n);
    expect(await bal(creatorId)).toBe(0n);
  });

  it('refuses new bids on a suspended seller and inside a VIP window', async () => {
    const creatorId = await makeCreator();
    const a = await makeUser();
    await fund(a, 5000);
    const vipOnly = await auction(creatorId, { vipEarlyUntil: new Date(Date.now() + 3_600_000) });
    await expect(money(prisma, (tx) => placeBid(tx, vipOnly.id, a, 1000))).rejects.toThrow('vip_early_access');
    await prisma.account.update({ where: { userId: a }, data: { vipUntil: new Date(Date.now() + 86_400_000) } });
    await money(prisma, (tx) => placeBid(tx, vipOnly.id, a, 1000));

    const other = await auction(creatorId);
    await prisma.user.update({ where: { id: creatorId }, data: { status: 'SUSPENDED' } });
    await expect(money(prisma, (tx) => placeBid(tx, other.id, a, 1000))).rejects.toThrow('not_available');
  });
});

describe('content access', () => {
  it('stops serving a banned creator\'s PUBLIC posts to everyone but the creator', async () => {
    const creatorId = await makeCreator();
    const fan = await makeUser();
    const p = await prisma.post.create({ data: { creatorId, visibility: 'PUBLIC', text: 'hi' } });
    expect(await canViewPost(fan, p)).toBe(true);
    await prisma.user.update({ where: { id: creatorId }, data: { status: 'BANNED' } });
    expect(await canViewPost(fan, p)).toBe(false);
    expect(await canViewPost(null, p)).toBe(false);
    expect(await canViewPost(creatorId, p)).toBe(true);
  });

  it('enforces the VIP early-access window on a post held by id', async () => {
    const creatorId = await makeCreator();
    const fan = await makeUser();
    const p = await prisma.post.create({ data: { creatorId, visibility: 'PUBLIC', vipEarlyUntil: new Date(Date.now() + 3_600_000) } });
    expect(await inVipWindow(p, fan)).toBe(true);
    expect(await canViewPost(fan, p)).toBe(false);
    expect(await canViewPost(creatorId, p)).toBe(true);
    await money(prisma, (tx) => post(tx, fan, 0, 'ADJUSTMENT'));
    await prisma.account.update({ where: { userId: fan }, data: { vipUntil: new Date(Date.now() + 86_400_000) } });
    expect(await canViewPost(fan, p)).toBe(true);
  });
});

describe('per-minute live billing', () => {
  async function stream(perMinuteCents = 200) {
    const creatorId = await makeCreator();
    const s = await prisma.liveStream.create({ data: { creatorId, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't', perMinuteCents } });
    return s;
  }

  it('charges the first minute on join and not again while inside paid time', async () => {
    const s = await stream();
    const fan = await makeUser();
    await fund(fan, 1000);
    const first = await ensureMinutePaid(fan, s);
    expect(first.charged).toBe(true);
    expect(await bal(fan)).toBe(800n);
    const again = await ensureMinutePaid(fan, s);
    expect(again.charged).toBe(false);
    expect(await bal(fan)).toBe(800n);
  });

  it('extends paid-through a minute per purchase and caps how far ahead a client can pre-buy', async () => {
    const s = await stream(100);
    const fan = await makeUser();
    await fund(fan, 100_000);
    const a = await payNextMinute(fan, s);
    const b = await payNextMinute(fan, s);
    expect(b.paidThrough.getTime() - a.paidThrough.getTime()).toBe(60_000);
    for (let i = 0; i < 20; i++) await payNextMinute(fan, s);
    const rows = await prisma.liveMinute.count({ where: { fanId: fan, streamId: s.id } });
    expect(rows).toBeLessThanOrEqual(MAX_PREPAID_MS / 60_000 + 1);
    expect(await bal(fan)).toBe(100_000n - BigInt(rows * 100));
  });

  it('sweep removes a viewer whose paid time lapsed, keeps a paying one, and ends a stream whose room is gone', async () => {
    const s = await stream(100);
    const payer = await makeUser(); const lapsed = await makeUser(); const never = await makeUser();
    await fund(payer, 1000); await fund(lapsed, 1000);
    await payNextMinute(payer, s);
    await payNextMinute(lapsed, s);
    await prisma.liveMinute.updateMany({ where: { fanId: lapsed, streamId: s.id }, data: { paidThrough: new Date(Date.now() - 5 * 60_000) } });

    const removed: string[] = [];
    const fake = {
      listRooms: async (names?: string[]) => (names ?? []).filter((n) => n === s.roomName).map((name) => ({ name })),
      listParticipants: async () => [{ identity: s.creatorId }, { identity: payer }, { identity: lapsed }, { identity: never }],
      removeParticipant: async (_room: string, id: string) => { removed.push(id); },
    } as any;
    const r = await sweepLive(fake);
    expect(removed.sort()).toEqual([lapsed, never].sort());
    // The sweep is global, so r.ended also counts stale streams left LIVE by
    // earlier runs against a persistent test DB -- assert on this stream.
    expect(r.removed).toBeGreaterThanOrEqual(2);
    expect((await prisma.liveStream.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('LIVE');

    // Room gone (crash, no webhook) and the stream is past its start grace.
    await prisma.liveStream.update({ where: { id: s.id }, data: { startedAt: new Date(Date.now() - 10 * 60_000) } });
    const gone = { ...fake, listRooms: async () => [] };
    const r2 = await sweepLive(gone);
    expect(r2.ended).toBeGreaterThanOrEqual(1);
    expect((await prisma.liveStream.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('ENDED');
  });

  it('never ends a stream on a LiveKit error, and /start clears only a stream whose room is gone', async () => {
    const s = await stream(0);
    await prisma.liveStream.update({ where: { id: s.id }, data: { startedAt: new Date(Date.now() - 10 * 60_000) } });
    const broken = { listRooms: async () => { throw new Error('network'); }, listParticipants: async () => [], removeParticipant: async () => {} } as any;
    await sweepLive(broken, new Date(), () => {});
    expect((await prisma.liveStream.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('LIVE');
    expect(await endStaleStreamFor(broken, s.creatorId)).toBe(true);
    const present = { ...broken, listRooms: async () => [{ name: s.roomName }] };
    expect(await endStaleStreamFor(present, s.creatorId)).toBe(true);
    const gone = { ...broken, listRooms: async () => [] };
    expect(await endStaleStreamFor(gone, s.creatorId)).toBe(false);
    expect((await prisma.liveStream.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('ENDED');
  });
});

describe('broadcast media copies', () => {
  it('gives each copy its own unique key that resolves to the source object', async () => {
    const creatorId = await makeCreator();
    const src = await prisma.media.create({ data: { ownerId: creatorId, key: `raw/${creatorId}/abc`, mime: 'image/jpeg', status: 'READY' } });
    const conv = await prisma.conversation.create({ data: { aId: creatorId < src.id ? creatorId : src.id, bId: creatorId < src.id ? src.id : creatorId } });
    const m1 = await prisma.message.create({ data: { conversationId: conv.id, senderId: creatorId, broadcastId: 'b1' } });
    const m2 = await prisma.message.create({ data: { conversationId: conv.id, senderId: creatorId, broadcastId: 'b2' } });
    for (const m of [m1, m2]) {
      await prisma.media.create({ data: { ownerId: creatorId, key: broadcastCopyKey(src.key, m.id), sourceMediaId: src.id, mime: 'image/jpeg', status: 'READY', messageId: m.id } });
    }
    const copies = await prisma.media.findMany({ where: { sourceMediaId: src.id } });
    expect(copies).toHaveLength(2);
    for (const c of copies) expect(storageKeyOf(c.key)).toBe(src.key);
    // The same broadcast can't land twice in one conversation (resumable retries).
    await expect(prisma.message.create({ data: { conversationId: conv.id, senderId: creatorId, broadcastId: 'b1' } })).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('money() conflict handling', () => {
  it('retries a serialization conflict and succeeds', async () => {
    let calls = 0;
    const fake = { $transaction: async () => { calls++; if (calls < 3) throw Object.assign(new Error('conflict'), { code: 'P2034' }); return 'ok'; } } as any;
    expect(await money(fake, async () => 'ok')).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up with a 503 busy_retry, and never retries other errors', async () => {
    let calls = 0;
    const always = { $transaction: async () => { calls++; throw Object.assign(new Error('x'), { code: 'P2010', meta: { code: '40001' } }); } } as any;
    await expect(money(always, async () => 1)).rejects.toMatchObject({ message: 'busy_retry', statusCode: 503 });
    expect(calls).toBe(8);
    let other = 0;
    const boom = { $transaction: async () => { other++; throw Object.assign(new Error('nope'), { code: 'P2002' }); } } as any;
    await expect(money(boom, async () => 1)).rejects.toMatchObject({ code: 'P2002' });
    expect(other).toBe(1);
  }, 20_000);
});
