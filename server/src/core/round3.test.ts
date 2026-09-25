import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, charge, creditDeposit, PLATFORM_ID, zeroOrAtLeast, FEES } from './ledger';
import { creatorMayBePaid } from './creator-standing';
import { renewalShouldExpire } from './renewal-policy';
import { applyUserStatus } from './moderation';
import { placeBid, closeAuction, hasDeliverable } from './auctions';
import { canViewMedia } from './access';
import { minuteRefusal, checkViewerOnJoin } from './live-sweep';
import { payNextMinute } from './live-billing';
import { holdForManualSettlement, isOwnNonceCancel } from './payouts';
import { jobInFlight } from './payout-queue';
import { reconcileProcessingMedia, MAX_TRANSCODE_REQUEUES } from './transcode-reconcile';
import { chargeTip } from '../modules/tips';

// Regression tests for the round-3 server fixes: creator approval on every
// new money flow, suspended fans' renewals, deliverable-less listings, the
// live ticket bypass, media attach rules, tip idempotency, the payout hold
// step and job-state check, and the transcode reconciler.

const prisma = new PrismaClient();

async function makeUser(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01'), ...extra } });
  return id;
}
async function makeCreator(extra: Record<string, unknown> = {}) {
  const userId = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED', ...extra });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'C', payoutAddress: '0x000000000000000000000000000000000000dEaD' } });
  return userId;
}
const deposit = (userId: string, cents: number) => money(prisma, (tx) => creditDeposit(tx, userId, BigInt(cents), `dep-${randomUUID()}`));
const balance = async (userId: string) => (await prisma.account.findUnique({ where: { userId } }))?.balanceCents ?? 0n;
const media = (ownerId: string, extra: Record<string, unknown> = {}) =>
  prisma.media.create({ data: { ownerId, key: `raw/${ownerId}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY', ...extra } });

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await prisma.account.upsert({ where: { userId: PLATFORM_ID }, create: { userId: PLATFORM_ID }, update: {} });
  await prisma.platformConfig.upsert({ where: { id: 1 }, create: { id: 1, vipPriceCents: 2000, burnBps: 2500 }, update: { vipPriceCents: 2000, burnBps: 2500 } });
});
afterAll(async () => { await prisma.$disconnect(); });

describe('creator approval gates every new flow of money', () => {
  const tip = (fan: string, creator: string) =>
    money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: randomUUID() }));

  it('charge() refuses a creator whose KYC is no longer approved, or whom the site moved back to pending', async () => {
    const fan = await makeUser();
    await deposit(fan, 10_000);
    for (const extra of [{ kycStatus: 'PENDING' }, { kycStatus: 'REJECTED' }, { siteUid: randomUUID(), siteCreatorStatus: 'pending' }]) {
      const creator = await makeCreator(extra);
      await expect(tip(fan, creator)).rejects.toThrow('creator_unavailable');
      expect(await balance(creator)).toBe(0n);
    }
    // A bridged creator the site has approved is payable.
    const ok = await makeCreator({ siteUid: randomUUID(), siteCreatorStatus: 'active' });
    await tip(fan, ok);
    expect(await balance(ok)).toBe(900n);
  });

  it('creatorMayBePaid needs status ACTIVE as well as approval', () => {
    const base = { role: 'CREATOR', kycStatus: 'APPROVED', siteUid: null, siteCreatorStatus: null };
    expect(creatorMayBePaid({ ...base, status: 'ACTIVE' })).toBe(true);
    expect(creatorMayBePaid({ ...base, status: 'SUSPENDED' })).toBe(false);
    expect(creatorMayBePaid({ ...base, status: 'ACTIVE', kycStatus: 'PENDING' })).toBe(false);
    expect(creatorMayBePaid({ ...base, status: 'ACTIVE', role: 'FAN' })).toBe(false);
  });

  it('an auction by an unapproved seller takes no bids, and closes with no sale and a full release', async () => {
    const seller = await makeCreator();
    const bidder = await makeUser();
    await deposit(bidder, 10_000);
    const l = await prisma.listing.create({ data: { creatorId: seller, title: 'Lot', saleType: 'AUCTION', priceCents: 1000, auctionEndsAt: new Date(Date.now() + 3_600_000), media: { create: { ownerId: seller, key: `raw/${seller}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY' } } } });
    await money(prisma, (tx) => placeBid(tx, l.id, bidder, 1000));
    const held = await balance(bidder);
    await prisma.user.update({ where: { id: seller }, data: { kycStatus: 'PENDING' } });
    const other = await makeUser();
    await deposit(other, 10_000);
    await expect(money(prisma, (tx) => placeBid(tx, l.id, other, 2000))).rejects.toThrow('not_available');
    const r = await money(prisma, (tx) => closeAuction(tx, l.id));
    expect(r.sold).toBe(false);
    expect(await balance(bidder)).toBe(held + 1000n);
    expect(await balance(seller)).toBe(0n);
  });
});

describe('renewals', () => {
  const creator = { role: 'CREATOR', status: 'ACTIVE', kycStatus: 'APPROVED', siteUid: null, siteCreatorStatus: null };
  it('expires instead of charging a suspended/banned fan, or an unpayable creator', () => {
    const row = { autoRenew: true, status: 'ACTIVE', creator, fan: { status: 'ACTIVE' } };
    expect(renewalShouldExpire(row)).toBe(false);
    expect(renewalShouldExpire({ ...row, fan: { status: 'SUSPENDED' } })).toBe(true);
    expect(renewalShouldExpire({ ...row, fan: { status: 'BANNED' } })).toBe(true);
    expect(renewalShouldExpire({ ...row, creator: { ...creator, kycStatus: 'REJECTED' } })).toBe(true);
    expect(renewalShouldExpire({ ...row, creator: { ...creator, siteUid: 'x', siteCreatorStatus: 'pending' } })).toBe(true);
    expect(renewalShouldExpire({ ...row, autoRenew: false })).toBe(true);
    expect(renewalShouldExpire({ ...row, perkEnabled: false })).toBe(true);
    expect(renewalShouldExpire({ ...row, perkEnabled: true })).toBe(false);
  });

  it('suspending a fan turns off auto-renew on their own subscriptions and token locks', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const tier = await prisma.subscriptionTier.create({ data: { creatorId: creator, name: 't', priceCents: 500 } });
    await prisma.subscription.create({ data: { fanId: fan, creatorId: creator, tierId: tier.id, priceCents: 500, currentPeriodEnd: new Date(Date.now() + 86_400_000) } });
    await prisma.tokenLock.create({ data: { fanId: fan, creatorId: creator, usdCents: 500, tokenAmountAtLock: '0', currentPeriodEnd: new Date(Date.now() + 86_400_000) } });
    await applyUserStatus(fan, 'SUSPENDED', { rooms: { deleteRoom: async () => undefined } });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { fanId_creatorId: { fanId: fan, creatorId: creator } } });
    const lock = await prisma.tokenLock.findUniqueOrThrow({ where: { fanId_creatorId: { fanId: fan, creatorId: creator } } });
    expect(sub.autoRenew).toBe(false);
    expect(sub.status).toBe('ACTIVE');   // the paid period still runs out
    expect(lock.autoRenew).toBe(false);
  });
});

describe('a listing with nothing to deliver is not sold', () => {
  it('bids need a READY media item on a DIGITAL listing', async () => {
    const seller = await makeCreator();
    const bidder = await makeUser();
    await deposit(bidder, 10_000);
    const l = await prisma.listing.create({ data: { creatorId: seller, title: 'Empty', saleType: 'AUCTION', priceCents: 1000, auctionEndsAt: new Date(Date.now() + 3_600_000) } });
    await expect(money(prisma, (tx) => placeBid(tx, l.id, bidder, 1000))).rejects.toThrow('no_deliverable');
    await media(seller, { listingId: l.id, status: 'PROCESSING' });
    expect(await money(prisma, (tx) => hasDeliverable(tx, l))).toBe(false);
    await media(seller, { listingId: l.id });
    expect(await money(prisma, (tx) => hasDeliverable(tx, l))).toBe(true);
    await money(prisma, (tx) => placeBid(tx, l.id, bidder, 1000));
  });

  it('an auction whose media was rejected after bidding closes with no sale and a full release', async () => {
    const seller = await makeCreator();
    const bidder = await makeUser();
    await deposit(bidder, 10_000);
    const l = await prisma.listing.create({ data: { creatorId: seller, title: 'Lot', saleType: 'AUCTION', priceCents: 1000, auctionEndsAt: new Date(Date.now() + 3_600_000) } });
    const m = await media(seller, { listingId: l.id });
    await money(prisma, (tx) => placeBid(tx, l.id, bidder, 1000));
    await prisma.media.update({ where: { id: m.id }, data: { status: 'REJECTED' } });
    const before = await balance(bidder);
    const r = await money(prisma, (tx) => closeAuction(tx, l.id));
    expect(r.sold).toBe(false);
    expect(await balance(bidder)).toBe(before + 1000n);
  });
});

describe('media access', () => {
  it('a listing buyer keeps their purchase even if the media also carries a post', async () => {
    const seller = await makeCreator();
    const buyer = await makeUser();
    const l = await prisma.listing.create({ data: { creatorId: seller, title: 'Set', priceCents: 1000, unlimited: true } });
    const post = await prisma.post.create({ data: { creatorId: seller, visibility: 'SUBSCRIBERS' } });
    const m = await media(seller, { listingId: l.id, postId: post.id });
    await prisma.listingOrder.create({ data: { listingId: l.id, buyerId: buyer, priceCents: 1000, platformFeeCents: 100, listingFeeCents: 50 } });
    expect((await canViewMedia(buyer, m.id)).ok).toBe(true);
    expect((await canViewMedia(await makeUser(), m.id)).ok).toBe(false);
  });
});

describe('live: a ticket cannot be skipped by buying minutes', () => {
  it('/minute is refused without a ticket on a ticketed stream, and the join check removes such a viewer', async () => {
    const creator = await makeCreator();
    const s = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID()}`, title: 't', ticketPriceCents: 5000, perMinuteCents: 10 } });
    const sneak = await makeUser();
    await deposit(sneak, 10_000);
    expect(await minuteRefusal(sneak, s)).toBe('ticket_required');
    // Even with a paid minute on record (e.g. from before the fix), no ticket = removed.
    await payNextMinute(sneak, s);
    const removed: string[] = [];
    const rooms = { removeParticipant: async (_r: string, id: string) => { removed.push(id); return undefined as any; } };
    expect(await checkViewerOnJoin(rooms, s.roomName, sneak)).toBe(true);

    const legit = await makeUser();
    await deposit(legit, 10_000);
    await prisma.liveTicket.create({ data: { fanId: legit, streamId: s.id } });
    expect(await minuteRefusal(legit, s)).toBeNull();
    await payNextMinute(legit, s);
    expect(await checkViewerOnJoin(rooms, s.roomName, legit)).toBe(false);
    expect(removed).toEqual([sneak]);

    await prisma.user.update({ where: { id: creator }, data: { status: 'SUSPENDED' } });
    expect(await minuteRefusal(legit, s)).toBe('not_live');
  });
});

describe('price floors keep the platform fee above zero', () => {
  it('zeroOrAtLeast admits 0 and the floor, not what is in between', () => {
    const ok = zeroOrAtLeast(FEES.MIN_PER_MINUTE_CENTS);
    expect([0, 5, 2000].map(ok)).toEqual([true, true, true]);
    expect([1, 4].map(ok)).toEqual([false, false]);
    expect(Math.floor((FEES.MIN_PER_MINUTE_CENTS * FEES.LIVE_BPS) / 10_000)).toBeGreaterThanOrEqual(1);
    expect(Math.floor((FEES.MIN_PRICED_MESSAGE_CENTS * FEES.DEFAULT_BPS) / 10_000)).toBeGreaterThanOrEqual(1);
    expect(Math.floor((FEES.MIN_DM_FLOOR_CENTS * FEES.DEFAULT_BPS) / 10_000)).toBeGreaterThanOrEqual(1);
    expect(Math.floor((FEES.MIN_TICKET_CENTS * FEES.LIVE_BPS) / 10_000)).toBeGreaterThanOrEqual(1);
  });
});

describe('tips are idempotent per client key', () => {
  it('a double-clicked tip charges once, even when both requests race', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 100_000);
    const before = await balance(fan);
    const key = randomUUID();
    const [a, b] = await Promise.all([
      chargeTip(fan, { creatorId: creator, amountCents: 20_000, idempotencyKey: key, type: 'TIP' }),
      chargeTip(fan, { creatorId: creator, amountCents: 20_000, idempotencyKey: key, type: 'TIP' }),
    ]);
    expect(a.tipId).toBe(b.tipId);
    expect([a.already, b.already].filter(Boolean)).toHaveLength(1);
    expect(await balance(fan)).toBe(before - 20_000n);
    // A new key is a new tip.
    await chargeTip(fan, { creatorId: creator, amountCents: 20_000, idempotencyKey: randomUUID(), type: 'TIP' });
    expect(await balance(fan)).toBe(before - 40_000n);
  });
});

describe('payouts: manual settlement', () => {
  async function payout(status: 'PENDING' | 'FAILED' | 'PROCESSING' | 'HELD') {
    const creator = await makeCreator();
    return prisma.payout.create({ data: { creatorId: creator, asset: 'STABLE', address: '0x000000000000000000000000000000000000dEaD', amountCents: 1000n, feeCents: 100n, status } });
  }
  it('hold moves PENDING / FAILED to HELD and nothing else', async () => {
    for (const s of ['PENDING', 'FAILED'] as const) {
      const p = await payout(s);
      expect(await money(prisma, (tx) => holdForManualSettlement(tx, p.id, 'admin'))).toBe(true);
      expect((await prisma.payout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('HELD');
    }
    const p = await payout('PROCESSING');
    expect(await money(prisma, (tx) => holdForManualSettlement(tx, p.id, 'admin'))).toBe(false);
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PROCESSING');
  });

  it('only the worker\'s own zero-value self-transfer at the nonce counts as its cancel', () => {
    const me = '0x1111111111111111111111111111111111111111';
    const cancel = { from: me, to: me, value: 0n, nonce: 41 };
    expect(isOwnNonceCancel(cancel, me.toUpperCase().replace('0X', '0x'), 41)).toBe(true);
    expect(isOwnNonceCancel({ ...cancel, nonce: 42 }, me, 41)).toBe(false);
    expect(isOwnNonceCancel({ ...cancel, to: '0x2222222222222222222222222222222222222222' }, me, 41)).toBe(false); // e.g. a hand-sent USDG transfer
    expect(isOwnNonceCancel({ ...cancel, value: 1n }, me, 41)).toBe(false);
    expect(isOwnNonceCancel(null, me, 41)).toBe(false);
  });

  it('a prioritized (queued) job counts as in flight', async () => {
    const job = (state: string) => ({ getState: async () => state });
    for (const s of ['active', 'waiting', 'prioritized', 'delayed', 'waiting-children']) expect(await jobInFlight(job(s))).toBe(true);
    for (const s of ['completed', 'failed', 'unknown']) expect(await jobInFlight(job(s))).toBe(false);
    expect(await jobInFlight(null)).toBe(false);
    expect(await jobInFlight({ getState: async () => { throw new Error('redis'); } })).toBe(true);
  });
});

describe('transcode reconciler', () => {
  it('re-queues stuck PROCESSING media with no job, skips ones still queued, and rejects past the cap', async () => {
    const owner = await makeUser();
    const old = new Date(Date.now() - 3_600_000);
    const lost = await media(owner, { status: 'PROCESSING', processingSince: old });
    const queued = await media(owner, { status: 'PROCESSING', processingSince: old });
    const poison = await media(owner, { status: 'PROCESSING', processingSince: old, transcodeRequeues: MAX_TRANSCODE_REQUEUES });
    const fresh = await media(owner, { status: 'PROCESSING', processingSince: new Date() });
    const added: string[] = [];
    const queue = {
      getJob: async (id: string) => (id === `transcode-${queued.id}` ? { getState: async () => 'prioritized' } : null),
      add: async (_n: string, d: any) => { added.push(d.mediaId); },
    };
    await reconcileProcessingMedia(queue);
    expect(added).toContain(lost.id);
    expect(added).not.toContain(queued.id);
    expect(added).not.toContain(fresh.id);
    expect(added).not.toContain(poison.id);
    const row = (id: string) => prisma.media.findUniqueOrThrow({ where: { id } });
    expect((await row(lost.id)).transcodeRequeues).toBe(1);
    expect((await row(lost.id)).status).toBe('PROCESSING');
    expect((await row(poison.id)).status).toBe('REJECTED');
    expect((await row(queued.id)).transcodeRequeues).toBe(0);
  });
});
