import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'crypto';
import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { money, post, PLATFORM_ID } from './ledger';
import { fileReport } from './reports';
import { applyUserStatus, restoreBanTakedowns } from './moderation';
import { OutflowJournal } from '../lib/outflow-journal';
import { claimGasTopUp, gasTopUpRefusal, gasTopUpRef, isPlatformSender, sweepWorthTopUp, SweepGasDeferred, SWEEP_GAS_TOPUP_GWEI } from '../workers/sweep-gas';

// Round-11 server regression tests: a reversed ban does not leave past
// buyers on a permanent 404 and an admin can restore what the ban took down
// (a report takedown stays down), /auth/login costs one argon2 verify on
// every path, an earned credit on a negative balance keeps withdrawable <=
// balance, sweep gas top-ups have a dollar floor, a per-address limit and
// are journaled only once signed, the treasury's own top-ups are not fan
// ETH deposits, and a journal clock clamp survives a restart.

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
  app.decorateRequest('jwtVerify', async function (this: any) { this.user = { id: as(), role: 'FAN' }; });
  await app.register(marketplace, { prefix: '/marketplace' });
  return app;
}

/** An unlimited digital listing with one READY product item and `buyers` past orders. */
async function soldDigitalListing(creator: string, buyers: string[]) {
  const l = await prisma.listing.create({ data: { creatorId: creator, title: 'pack', priceCents: 2000, unlimited: true } });
  await prisma.media.create({ data: { ownerId: creator, key: `raw/${creator}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY', listingId: l.id } });
  for (const b of buyers) {
    await prisma.listingOrder.create({ data: { listingId: l.id, buyerId: b, priceCents: 2000, platformFeeCents: 200, listingFeeCents: 100 } });
  }
  return l;
}

describe('reversing a ban', () => {
  it('past buyers get the listing back once the seller is ACTIVE; an admin restore lets the creator relist', async () => {
    const creator = await makeCreator();
    const buyer = await makeUser();
    const stranger = await makeUser();
    const l = await soldDigitalListing(creator, [buyer]);
    let as = buyer;
    const app = await marketplaceApp(() => as);
    const get = () => app.inject({ method: 'GET', url: `/marketplace/listings/${l.id}` });
    expect((await get()).statusCode).toBe(200);

    expect(await applyUserStatus(creator, 'BANNED', { rooms: noRooms })).toBe(true);
    const banned = await prisma.listing.findUniqueOrThrow({ where: { id: l.id } });
    expect(banned).toMatchObject({ status: 'REMOVED', moderatedReason: 'BAN' });
    expect(banned.moderatedAt).not.toBeNull();
    // While the ban stands the buyer does not see it (seller not ACTIVE).
    expect((await get()).statusCode).toBe(404);

    const admin = await adminApp();
    // A single-listing restore is refused while the seller is still banned.
    expect((await admin.inject({ method: 'POST', url: `/admin/listings/${l.id}/restore` })).json().error).toBe('seller_not_active');
    expect(await restoreBanTakedowns({ creatorId: creator })).toBe(0);

    // Reactivation alone: buyers see it again, strangers do not, and the
    // creator still cannot relist it by themselves.
    await applyUserStatus(creator, 'ACTIVE', { rooms: noRooms });
    expect((await get()).statusCode).toBe(200);
    as = stranger;
    expect((await get()).statusCode).toBe(404);
    as = creator;
    expect((await app.inject({ method: 'PATCH', url: `/marketplace/listings/${l.id}`, payload: { status: 'ACTIVE' } })).statusCode).toBe(409);

    // Admin restore (single listing): the stamp is cleared, still REMOVED,
    // and the creator's own PATCH relists it.
    const res = await admin.inject({ method: 'POST', url: `/admin/listings/${l.id}/restore` });
    expect(res.statusCode).toBe(200);
    expect(await prisma.listing.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ status: 'REMOVED', moderatedAt: null, moderatedReason: null });
    expect((await app.inject({ method: 'PATCH', url: `/marketplace/listings/${l.id}`, payload: { status: 'ACTIVE' } })).statusCode).toBe(200);
    as = stranger;
    expect((await get()).statusCode).toBe(200);
    expect((await admin.inject({ method: 'POST', url: `/admin/listings/${l.id}/restore` })).json().error).toBe('not_moderated');
    await app.close(); await admin.close();
  });

  it('reactivating with restoreListings clears every BAN stamp of that creator, never a REPORT one or another creator\'s', async () => {
    const creator = await makeCreator();
    const other = await makeCreator();
    const a = await soldDigitalListing(creator, []);
    const b = await soldDigitalListing(creator, []);
    const reported = await soldDigitalListing(creator, []);
    const elsewhere = await soldDigitalListing(other, []);
    await applyUserStatus(creator, 'BANNED', { rooms: noRooms });
    await applyUserStatus(other, 'BANNED', { rooms: noRooms });
    // A report takedown on an item the ban already stamped upgrades it to REPORT.
    const rep = await fileReport(await makeUser(), 'listing', reported.id, 'r');
    const admin = await adminApp();
    expect((await admin.inject({ method: 'POST', url: `/admin/reports/${rep.id}/resolve`, payload: { action: 'remove_content' } })).statusCode).toBe(200);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: reported.id } })).moderatedReason).toBe('REPORT');

    // Only with ACTIVE.
    expect((await admin.inject({ method: 'POST', url: `/admin/users/${creator}/status`, payload: { status: 'SUSPENDED', restoreListings: true } })).statusCode).toBe(400);
    const res = await admin.inject({ method: 'POST', url: `/admin/users/${creator}/status`, payload: { status: 'ACTIVE', restoreListings: true } });
    expect(res.json()).toMatchObject({ ok: true, restoredListings: 2 });
    for (const id of [a.id, b.id]) expect((await prisma.listing.findUniqueOrThrow({ where: { id } })).moderatedAt).toBeNull();
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: reported.id } })).moderatedReason).toBe('REPORT');
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: elsewhere.id } })).moderatedReason).toBe('BAN');
    expect((await admin.inject({ method: 'POST', url: `/admin/listings/${reported.id}/restore` })).json().error).toBe('report_takedown');
    // Plain reactivation (no flag) restores nothing.
    const plain = await admin.inject({ method: 'POST', url: `/admin/users/${other}/status`, payload: { status: 'ACTIVE' } });
    expect(plain.json()).toEqual({ ok: true });
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: elsewhere.id } })).moderatedReason).toBe('BAN');
    await admin.close();
  });

  it('a REPORT takedown stays hidden from past buyers after the seller is reactivated', async () => {
    const creator = await makeCreator();
    const buyer = await makeUser();
    const l = await soldDigitalListing(creator, [buyer]);
    const rep = await fileReport(await makeUser(), 'listing', l.id, 'r');
    const admin = await adminApp();
    expect((await admin.inject({ method: 'POST', url: `/admin/reports/${rep.id}/resolve`, payload: { action: 'ban_user' } })).statusCode).toBe(200);
    await admin.inject({ method: 'POST', url: `/admin/users/${creator}/status`, payload: { status: 'ACTIVE', restoreListings: true } });
    expect(await prisma.listing.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ moderatedReason: 'REPORT' });
    const app = await marketplaceApp(() => buyer);
    expect((await app.inject({ method: 'GET', url: `/marketplace/listings/${l.id}` })).statusCode).toBe(404);
    await app.close(); await admin.close();
  });
});

describe('/auth/login timing', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('runs one argon2 verify whether or not the identifier may log in', async () => {
    const Fastify = (await import('fastify')).default;
    const { auth } = await import('../modules/auth');
    const app = Fastify();
    await app.register(auth, { prefix: '/auth' });
    const spy = vi.spyOn(argon2, 'verify');
    const fan = await makeUser();   // not an operator: password login not allowed
    for (const email of [`missing-${randomUUID()}@x.test`, `${fan}@test.local`]) {
      spy.mockClear();
      const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'wrong-password' } });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'bad_credentials' });
      expect(spy).toHaveBeenCalledTimes(1);
    }
    await app.close();
  });
});

describe('closed-loop credits: withdrawable never exceeds balance', () => {
  it('an earning on a negative balance raises withdrawable only up to the new balance', async () => {
    const creator = await makeCreator();
    await money(prisma, (tx) => post(tx, creator, -500, 'ADJUSTMENT', undefined, {}));
    await money(prisma, (tx) => post(tx, creator, 900, 'TIP', `t-${randomUUID()}`, {}, 'CREDITS', { earned: true }));
    let a = await prisma.account.findUniqueOrThrow({ where: { userId: creator } });
    expect(a.balanceCents).toBe(400n);
    expect(a.withdrawableCents).toBe(400n);
    // Neighbours unchanged: a plain earning on a positive balance is all withdrawable,
    // a deposit is not withdrawable at all.
    await money(prisma, (tx) => post(tx, creator, 300, 'TIP', `t-${randomUUID()}`, {}, 'CREDITS', { earned: true }));
    await money(prisma, (tx) => post(tx, creator, 1000, 'DEPOSIT', `d-${randomUUID()}`, {}));
    a = await prisma.account.findUniqueOrThrow({ where: { userId: creator } });
    expect(a.balanceCents).toBe(1700n);
    expect(a.withdrawableCents).toBe(700n);
    // An earning that leaves the balance still negative adds nothing withdrawable.
    const other = await makeCreator();
    await money(prisma, (tx) => post(tx, other, -1000, 'ADJUSTMENT', undefined, {}));
    await money(prisma, (tx) => post(tx, other, 400, 'TIP', `t-${randomUUID()}`, {}, 'CREDITS', { earned: true }));
    a = await prisma.account.findUniqueOrThrow({ where: { userId: other } });
    expect(a.balanceCents).toBe(-600n);
    expect(a.withdrawableCents).toBe(0n);
  });
});

describe('deposit-sweep gas top-ups (round 11)', () => {
  it('are worth making only for a dollar or more', () => {
    expect(sweepWorthTopUp(10n ** 6n, 6, 1)).toBe(true);
    expect(sweepWorthTopUp(10n ** 6n - 1n, 6, 1)).toBe(false);
    expect(sweepWorthTopUp(10_000n, 6, 1)).toBe(false);          // one cent
    expect(sweepWorthTopUp(100n * 10n ** 18n, 18, 0.01)).toBe(true);   // 100 tokens at $0.01
    expect(sweepWorthTopUp(99n * 10n ** 18n, 18, 0.01)).toBe(false);
    expect(sweepWorthTopUp(10n ** 30n, 18, 0)).toBe(false);          // no price: never
    expect(sweepWorthTopUp(10n ** 30n, 18, NaN)).toBe(false);
  });

  it('are limited per deposit address, so one address cannot use up the global cap', () => {
    const j = new OutflowJournal({ kind: 'memory' });
    const cap = SWEEP_GAS_TOPUP_GWEI * 100;
    const a = gasTopUpRef(1, 7), b = gasTopUpRef(1, 8);
    claimGasTopUp(j, a, cap, 2);
    claimGasTopUp(j, a, cap, 2);
    expect(() => claimGasTopUp(j, a, cap, 2)).toThrow(SweepGasDeferred);
    expect(gasTopUpRefusal(j, cap, SWEEP_GAS_TOPUP_GWEI, a, 2)).toMatch(/per-address/);
    // Another address is unaffected; the global cap still applies on top.
    expect(gasTopUpRefusal(j, cap, SWEEP_GAS_TOPUP_GWEI, b, 2)).toBeNull();
    claimGasTopUp(j, b, cap, 2);
    expect(j.sumSince('gas')).toBe(SWEEP_GAS_TOPUP_GWEI * 3);
    expect(j.sumSince('gas', undefined, b)).toBe(SWEEP_GAS_TOPUP_GWEI);
    expect(gasTopUpRefusal(j, SWEEP_GAS_TOPUP_GWEI * 3, SWEEP_GAS_TOPUP_GWEI, gasTopUpRef(1, 9), 2)).toMatch(/daily sweep-gas limit/);
    // A refusal check alone records nothing.
    expect(j.sumSince('gas')).toBe(SWEEP_GAS_TOPUP_GWEI * 3);
  });

  it('the treasury\'s own top-up (or ETH between deposit addresses) is not a fan deposit', () => {
    const treasury = '0x' + 'aB'.repeat(20);
    const addrs = new Map([['0x' + '11'.repeat(20), {}]]);
    expect(isPlatformSender(treasury.toLowerCase(), treasury, addrs)).toBe(true);
    expect(isPlatformSender(treasury.toUpperCase().replace('0X', '0x'), treasury, addrs)).toBe(true);
    expect(isPlatformSender('0x' + '11'.repeat(20), treasury, addrs)).toBe(true);
    expect(isPlatformSender('0x' + '22'.repeat(20), treasury, addrs)).toBe(false);
    expect(isPlatformSender('0x' + '22'.repeat(20), null, addrs)).toBe(false);
    expect(isPlatformSender(undefined, treasury, addrs)).toBe(false);
  });
});

describe('outflow journal clock clamp', () => {
  it('a clamp made while running is persisted, so a restart does not start the window over', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outflow-'));
    let now = Date.now() + 7 * 24 * 3_600_000;   // clock a week fast
    const a = new OutflowJournal({ kind: 'file', dir }, () => now);
    a.record('payout', 1000, 'p1');
    expect(a.sumSince('payout')).toBe(1000);
    const t0 = now = Date.now();   // NTP steps it back while running
    expect(a.sumSince('payout')).toBe(1000);
    const onDisk = fs.readFileSync(path.join(dir, 'treasury-outflow.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].at).toBe(t0);
    // Restart 20h later: still counted (inside the window from t0)...
    now = t0 + 20 * 3_600_000;
    expect(new OutflowJournal({ kind: 'file', dir }, () => now).sumSince('payout')).toBe(1000);
    // ...and gone 24h after t0, not 24h after the restart.
    now = t0 + 24 * 3_600_000 + 1000;
    expect(new OutflowJournal({ kind: 'file', dir }, () => now).sumSince('payout')).toBe(0);
  });
});
