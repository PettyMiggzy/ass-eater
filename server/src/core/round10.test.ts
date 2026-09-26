import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, post, PLATFORM_ID } from './ledger';
import { fileReport, listReports } from './reports';
import { applyUserStatus } from './moderation';
import { placeBid } from './auctions';
import { endStaleStreamFor, NEW_STREAM_GRACE_MS } from './live-sweep';
import { requestPayout } from '../modules/payouts';
import { OutflowJournal } from '../lib/outflow-journal';
import { gasTopUpRefusal, claimGasTopUp, depositCreditedFor, SweepGasDeferred, SWEEP_GAS_TOPUP_GWEI } from '../workers/sweep-gas';

// Round-10 server regression tests: a moderator's listing takedown cannot be
// undone by the creator, an identical bid retry from the leader is answered
// rather than refused, cash-out is idempotent per requestId, /live/start
// never ends a just-created stream, and deposit-sweep gas top-ups are
// journaled, capped and require a credited deposit.

const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await prisma.account.upsert({ where: { userId: PLATFORM_ID }, create: { userId: PLATFORM_ID }, update: {} });
});

async function makeUser(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01'), ...extra } });
  return id;
}
async function makeCreator() {
  const userId = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED' });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'C' } });
  return userId;
}
const credit = (userId: string, cents: number, earned = false) =>
  money(prisma, (tx) => post(tx, userId, cents, earned ? 'TIP' : 'DEPOSIT', `t-${randomUUID()}`, {}, 'CREDITS', earned ? { earned: true } : undefined));
const noRooms = { deleteRoom: async () => undefined };

async function adminApp() {
  const Fastify = (await import('fastify')).default;
  const { admin } = await import('../modules/admin');
  const app = Fastify();
  const adminId = await makeUser({ role: 'ADMIN' });
  app.decorate('role', () => async (req: any) => { req.user = { id: adminId, role: 'ADMIN' }; });
  await app.register(admin, { prefix: '/admin' });
  return app;
}
async function marketplaceApp(as: () => string) {
  const Fastify = (await import('fastify')).default;
  const { marketplace } = await import('../modules/marketplace');
  const app = Fastify();
  const hook = async (req: any) => { req.user = { id: as(), role: 'CREATOR' }; };
  app.decorate('auth', hook);
  app.decorate('creatorOk', hook);
  app.decorate('role', () => hook);
  await app.register(marketplace, { prefix: '/marketplace' });
  return app;
}

describe('a moderator\'s listing takedown sticks', () => {
  it('report takedown: stamped moderatedAt, and the creator cannot relist or edit it', async () => {
    const creator = await makeCreator();
    const l = await prisma.listing.create({ data: { creatorId: creator, title: 'names a third party', priceCents: 1000, kind: 'PHYSICAL' } });
    const r = await fileReport(await makeUser(), 'listing', l.id, 'r');
    const other = await fileReport(await makeUser(), 'listing', l.id, 'r2');
    const admin = await adminApp();
    const res = await admin.inject({ method: 'POST', url: `/admin/reports/${r.id}/resolve`, payload: { action: 'remove_content' } });
    expect(res.statusCode).toBe(200);
    await admin.close();
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.status).toBe('REMOVED');
    expect(after.moderatedAt).not.toBeNull();

    const app = await marketplaceApp(() => creator);
    const relist = await app.inject({ method: 'PATCH', url: `/marketplace/listings/${l.id}`, payload: { status: 'ACTIVE' } });
    expect(relist.statusCode).toBe(409);
    expect(relist.json().message).toBe('removed_by_moderation');
    const edit = await app.inject({ method: 'PATCH', url: `/marketplace/listings/${l.id}`, payload: { title: 'new title' } });
    expect(edit.statusCode).toBe(409);
    expect(await prisma.listing.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ status: 'REMOVED', title: 'names a third party' });
    // Not served by id to anyone but its creator.
    const stranger = await makeUser();
    const app2 = await marketplaceApp(() => stranger);
    expect((await app2.inject({ method: 'GET', url: `/marketplace/listings/${l.id}` })).statusCode).toBe(404);
    await app.close(); await app2.close();
    // The other open report on it reads as down.
    const open = await listReports({ status: 'OPEN', targetType: 'listing', limit: 500, offset: 0 });
    // (paged: find ours)
    let found = open.reports.find((x) => x.id === other.id);
    for (let off = 500; !found && off < open.total; off += 500) {
      found = (await listReports({ status: 'OPEN', targetType: 'listing', limit: 500, offset: off })).reports.find((x) => x.id === other.id);
    }
    expect(found?.contentRemoved).toBe(true);
  });

  it('a listing the creator unlisted before the takedown is stamped too; a self-unlist alone is not "down" and can be relisted', async () => {
    const creator = await makeCreator();
    const self = await prisma.listing.create({ data: { creatorId: creator, title: 's', priceCents: 1000, kind: 'PHYSICAL' } });
    const app = await marketplaceApp(() => creator);
    expect((await app.inject({ method: 'PATCH', url: `/marketplace/listings/${self.id}`, payload: { status: 'REMOVED' } })).statusCode).toBe(200);
    const rep = await fileReport(await makeUser(), 'listing', self.id, 'r');
    const q = await listReports({ status: 'OPEN', targetType: 'listing', contentRemoved: false, limit: 1000, offset: 0 });
    expect(q.reports.some((x) => x.id === rep.id)).toBe(true);
    expect((await app.inject({ method: 'PATCH', url: `/marketplace/listings/${self.id}`, payload: { status: 'ACTIVE' } })).statusCode).toBe(200);

    expect((await app.inject({ method: 'PATCH', url: `/marketplace/listings/${self.id}`, payload: { status: 'REMOVED' } })).statusCode).toBe(200);
    const admin = await adminApp();
    expect((await admin.inject({ method: 'POST', url: `/admin/reports/${rep.id}/resolve`, payload: { action: 'remove_content' } })).statusCode).toBe(200);
    await admin.close();
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: self.id } })).moderatedAt).not.toBeNull();
    expect((await app.inject({ method: 'PATCH', url: `/marketplace/listings/${self.id}`, payload: { status: 'ACTIVE' } })).statusCode).toBe(409);
    await app.close();
  });

  it('a ban stamps every listing it takes down, so an un-ban cannot relist them', async () => {
    const creator = await makeCreator();
    const fixed = await prisma.listing.create({ data: { creatorId: creator, title: 'f', priceCents: 1000, kind: 'PHYSICAL' } });
    const auction = await prisma.listing.create({ data: { creatorId: creator, title: 'a', priceCents: 1000, kind: 'PHYSICAL', saleType: 'AUCTION', auctionEndsAt: new Date(Date.now() + 3_600_000) } });
    expect(await applyUserStatus(creator, 'BANNED', { rooms: noRooms })).toBe(true);
    for (const id of [fixed.id, auction.id]) {
      const l = await prisma.listing.findUniqueOrThrow({ where: { id } });
      expect(l.status).toBe('REMOVED');
      expect(l.moderatedAt).not.toBeNull();
    }
    await applyUserStatus(creator, 'ACTIVE', { rooms: noRooms });
    const app = await marketplaceApp(() => creator);
    expect((await app.inject({ method: 'PATCH', url: `/marketplace/listings/${fixed.id}`, payload: { status: 'ACTIVE' } })).statusCode).toBe(409);
    await app.close();
  });
});

describe('bid retry', () => {
  it('the leader repeating their standing bid gets it back (already), with nothing re-held', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await credit(fan, 10_000);
    const l = await prisma.listing.create({ data: {
      creatorId: creator, title: 'a', priceCents: 5000, saleType: 'AUCTION', auctionEndsAt: new Date(Date.now() + 3_600_000),
      media: { create: { ownerId: creator, key: `raw/${creator}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY' } },
    } });
    const first = await money(prisma, (tx) => placeBid(tx, l.id, fan, 5000));
    const balAfterFirst = (await prisma.account.findUniqueOrThrow({ where: { userId: fan } })).balanceCents;
    const retry = await money(prisma, (tx) => placeBid(tx, l.id, fan, 5000));
    expect(retry).toMatchObject({ id: first.id, already: true });
    expect((await prisma.account.findUniqueOrThrow({ where: { userId: fan } })).balanceCents).toBe(balAfterFirst);
    expect(await prisma.bid.count({ where: { listingId: l.id } })).toBe(1);
    // Anyone else bidding the same amount is still below the floor.
    const other = await makeUser();
    await credit(other, 10_000);
    await expect(money(prisma, (tx) => placeBid(tx, l.id, other, 5000))).rejects.toThrow('bid_too_low');
  });
});

describe('cash-out idempotency', () => {
  it('a double-tapped request creates one payout and charges one fee', async () => {
    const creator = await makeCreator();
    await credit(creator, 10_000, true);
    const requestId = randomUUID();
    const args = { requestId, amountCents: 5000, instant: false, address: '0x000000000000000000000000000000000000dEaD' };
    const [a, b] = await Promise.all([requestPayout(creator, args), requestPayout(creator, args)]);
    expect(a.payout.id).toBe(b.payout.id);
    expect([a.already, b.already].sort()).toEqual([false, true]);
    // A sequential retry is answered the same way.
    expect(await requestPayout(creator, args)).toMatchObject({ already: true, payout: { id: a.payout.id } });
    expect(await prisma.payout.count({ where: { creatorId: creator } })).toBe(1);
    const acct = await prisma.account.findUniqueOrThrow({ where: { userId: creator } });
    expect(acct.balanceCents).toBe(5000n);
    expect(acct.withdrawableCents).toBe(5000n);
    // The same id for a different amount is refused, not answered "already".
    await expect(requestPayout(creator, { ...args, amountCents: 4000 })).rejects.toThrow('request_id_reused');
    // A new id is a new payout.
    expect((await requestPayout(creator, { ...args, requestId: randomUUID() })).already).toBe(false);
  });
});

describe('/live/start stale check', () => {
  it('never ends a stream younger than the sweep\'s grace, even if its room is not listed yet', async () => {
    const creator = await makeCreator();
    const s = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID()}`, title: 't' } });
    const gone = { listRooms: async () => [], listParticipants: async () => [], removeParticipant: async () => {} } as any;
    expect(await endStaleStreamFor(gone, creator)).toBe(true);
    expect((await prisma.liveStream.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('LIVE');
    // Past the grace, a missing room is stale.
    expect(await endStaleStreamFor(gone, creator, new Date(s.startedAt.getTime() + NEW_STREAM_GRACE_MS + 1000))).toBe(false);
    expect((await prisma.liveStream.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('ENDED');
  });
});

describe('deposit-sweep gas top-ups', () => {
  it('are journaled and capped; an unusable journal refuses', () => {
    const j = new OutflowJournal({ kind: 'memory' });
    const cap = SWEEP_GAS_TOPUP_GWEI * 2;
    claimGasTopUp(j, 'a', cap);
    claimGasTopUp(j, 'b', cap);
    expect(j.sumSince('gas')).toBe(cap);
    expect(() => claimGasTopUp(j, 'c', cap)).toThrow(SweepGasDeferred);
    expect(gasTopUpRefusal(j, cap)).toMatch(/daily sweep-gas limit/);
    expect(gasTopUpRefusal(new OutflowJournal({ kind: 'missing' }), cap)).toMatch(/journal unavailable/);
    // Gas does not eat into the payout window, nor the reverse.
    expect(j.sumSince('payout')).toBe(0);
  });

  it('need a credited deposit of that asset at the address', async () => {
    const u = await makeUser();
    const chainId = 900_000 + Math.floor(Math.random() * 90_000);
    const idx = Math.floor(Math.random() * 1_000_000);
    await prisma.depositAddress.create({ data: { userId: u, chainId, address: `0x${randomUUID().replace(/-/g, '').padEnd(40, '0')}`, derivationIndex: idx } });
    expect(await depositCreditedFor(chainId, idx, 'STABLE')).toBe(false);
    expect(await depositCreditedFor(chainId, idx + 1, 'STABLE')).toBe(false);
    const base = { userId: u, chainId, logIndex: 0, rawAmount: '1', priceUsed: 1 };
    await prisma.deposit.create({ data: { ...base, txHash: `0x${randomUUID()}`, asset: 'STABLE', usdCents: 0n, pricePending: true } });
    expect(await depositCreditedFor(chainId, idx, 'STABLE')).toBe(false);
    await prisma.deposit.create({ data: { ...base, txHash: `0x${randomUUID()}`, asset: 'STABLE', usdCents: 500n } });
    expect(await depositCreditedFor(chainId, idx, 'STABLE')).toBe(true);
    expect(await depositCreditedFor(chainId, idx, 'ONLYONE')).toBe(false);
  });
});
