import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

// Round-22 server regression tests: KYC applicant creation recovers from a
// Sumsub 409 (an applicant created but never saved) and Sumsub failures are
// 502s that never carry the upstream body; the live tip-overlay feed uses the
// room's entitlement rule (per-minute paid time, not "any minute ever") and
// expires with the paid time; the sweep reconciler's walk stops on
// consecutive failures (an RPC-wide outage) but not on scattered ones.

vi.mock('../lib/redis', async (orig) => ({
  ...(await orig<typeof import('../lib/redis')>()),
  publish: async () => 0,
}));

const { PLATFORM_ID } = await import('./ledger');
const { overlayAccess, PAY_GRACE_MS } = await import('./live-sweep');
const { ensureApplicant, SumsubError } = await import('../modules/kyc');
const { ConsecutiveFailureBreaker, walkWithBreaker, shortError } = await import('../workers/reconcile-breaker');

const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
});

async function makeUser(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01'), ...extra } });
  return id;
}
async function makeCreator(extra: Record<string, unknown> = {}) {
  const userId = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED', ...extra });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'C' } });
  return userId;
}
const stream = (creatorId: string, extra: Record<string, unknown> = {}) =>
  prisma.liveStream.create({ data: { creatorId, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't', ...extra } });

describe('srv-auth-core#0: KYC applicant 409 recovery', () => {
  it('adopts the existing applicant when Sumsub answers 409', async () => {
    const calls: string[] = [];
    const call = (async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (method === 'POST') throw new SumsubError(409, 'Applicant with external user id already exists');
      return { id: 'applicant-A' };
    }) as any;
    await expect(ensureApplicant('user-1', 'a@b.c', call)).resolves.toBe('applicant-A');
    expect(calls[1]).toBe('GET /resources/applicants/-;externalUserId=user-1/one');
  });
  it('returns a fresh applicant id on create', async () => {
    await expect(ensureApplicant('user-2', 'a@b.c', (async () => ({ id: 'new-id' })) as any)).resolves.toBe('new-id');
  });
  it('rethrows other failures as a 502 that does not carry the upstream body', async () => {
    const err = await ensureApplicant('u', 'a@b.c', (async () => { throw new SumsubError(500, 'SECRET upstream body'); }) as any).catch((e) => e);
    expect(err).toBeInstanceOf(SumsubError);
    expect(err.statusCode).toBe(502);
    expect(err.message).not.toContain('SECRET');
  });
});

describe('srv-money-modules#0: live overlay entitlement', () => {
  it('refuses a per-minute viewer whose paid time lapsed, even with an old minute on record', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const s = await stream(creator, { perMinuteCents: 5 });
    await prisma.liveMinute.create({ data: { fanId: fan, streamId: s.id, minuteIndex: 0, paidCents: 5, paidThrough: new Date(Date.now() - 10 * 60_000) } });
    expect(await overlayAccess(s, fan)).toBeNull();
  });
  it('admits a paid-up per-minute viewer only until paid time + grace', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const s = await stream(creator, { perMinuteCents: 5 });
    const through = new Date(Date.now() + 45_000);
    await prisma.liveMinute.create({ data: { fanId: fan, streamId: s.id, minuteIndex: 0, paidCents: 5, paidThrough: through } });
    const a = await overlayAccess(s, fan);
    expect(a?.expiresAt?.getTime()).toBe(through.getTime() + PAY_GRACE_MS);
  });
  it('does not admit a subscriber on a per-minute stream without paid time (same rule as /join)', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const tier = await prisma.subscriptionTier.create({ data: { creatorId: creator, name: 't', priceCents: 500 } });
    await prisma.subscription.create({ data: { fanId: fan, creatorId: creator, tierId: tier.id, status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 86_400_000), priceCents: 500 } });
    // Sanity: the same fan IS admitted on a subscriber-only stream.
    expect(await overlayAccess(await stream(creator), fan)).toEqual({ expiresAt: null });
    const s = await stream(creator, { perMinuteCents: 5 });
    expect(await overlayAccess(s, fan)).toBeNull();
  });
  it('refuses a non-ACTIVE fan and anyone on a suspended creator; the creator always gets their own feed', async () => {
    const creator = await makeCreator();
    const fan = await makeUser({ status: 'SUSPENDED' });
    const s = await stream(creator, { perMinuteCents: 5 });
    await prisma.liveMinute.create({ data: { fanId: fan, streamId: s.id, minuteIndex: 0, paidCents: 5, paidThrough: new Date(Date.now() + 60_000) } });
    expect(await overlayAccess(s, fan)).toBeNull();
    expect(await overlayAccess(s, creator)).toEqual({ expiresAt: null });
    const off = await makeCreator({ status: 'SUSPENDED' });
    const fan2 = await makeUser();
    const s2 = await stream(off, { perMinuteCents: 5 });
    await prisma.liveMinute.create({ data: { fanId: fan2, streamId: s2.id, minuteIndex: 0, paidCents: 5, paidThrough: new Date(Date.now() + 60_000) } });
    expect(await overlayAccess(s2, fan2)).toBeNull();
  });
  it('ticketed stream: ticket holder admitted with no expiry, others refused', async () => {
    const creator = await makeCreator();
    const holder = await makeUser();
    const other = await makeUser();
    const s = await stream(creator, { ticketPriceCents: 500 });
    await prisma.liveTicket.create({ data: { fanId: holder, streamId: s.id } });
    expect(await overlayAccess(s, holder)).toEqual({ expiresAt: null });
    expect(await overlayAccess(s, other)).toBeNull();
  });
});

describe('srv-workers-infra#0: reconcile circuit breaker', () => {
  it('stops after N consecutive failures and skips later walks in the same pass', async () => {
    const b = new ConsecutiveFailureBreaker(5);
    let calls = 0;
    const n = await walkWithBreaker(Array.from({ length: 100 }, (_, i) => i), async () => { calls++; throw new Error('429'); }, b, () => {});
    expect(n).toBe(5);
    expect(calls).toBe(5);
    expect(b.tripped).toBe(true);
    let later = 0;
    expect(await walkWithBreaker([1, 2, 3], async () => { later++; }, b, () => {})).toBe(0);
    expect(later).toBe(0);
  });
  it('does not trip on scattered failures (a success resets the run)', async () => {
    const b = new ConsecutiveFailureBreaker(3);
    const n = await walkWithBreaker(Array.from({ length: 30 }, (_, i) => i), async (i) => { if (i % 3 !== 0) throw new Error('x'); }, b, () => {});
    expect(n).toBe(30);
    expect(b.tripped).toBe(false);
    expect(b.failures).toBe(20);
  });
  it('logs only the first few failures per walk, as one line', async () => {
    const b = new ConsecutiveFailureBreaker(100);
    const logged: boolean[] = [];
    await walkWithBreaker(Array.from({ length: 20 }, (_, i) => i), async () => { throw Object.assign(new Error('long\nstack'), { shortMessage: 'HTTP 429' }); }, b, (_i, _e, log) => logged.push(log), 3);
    expect(logged.filter(Boolean).length).toBe(3);
    expect(shortError(Object.assign(new Error('a\nb'), { shortMessage: 'HTTP 429' }))).toBe('HTTP 429');
    expect(shortError(new Error('first\nsecond'))).toBe('first');
  });
});
