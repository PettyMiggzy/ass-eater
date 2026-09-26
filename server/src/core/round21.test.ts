import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

// Round-21 server regression tests: KYC webhook events apply in event-time
// order and only for the stored applicant (admin overrides stamp the time);
// a suspended/banned creator is not mailed DM notifications; a ban cancels
// only live subscriptions; admin adjust can move withdrawable earnings
// explicitly; the sweep reconciler's candidate walk is bounded and paged.

vi.mock('../lib/redis', async (orig) => ({
  ...(await orig<typeof import('../lib/redis')>()),
  publish: async () => 0,
}));

process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'test-lk-key';
process.env.LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'test-lk-secret-' + randomUUID();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-' + randomUUID();

const { money, post, PLATFORM_ID } = await import('./ledger');
const { applyKycEvent, kycEventTime } = await import('./kyc-events');
const { notifyDmReceived } = await import('./notify');
const { registerMailTransport } = await import('../lib/mailer');
const { adminAdjust } = await import('./admin-adjust');
const { applyUserStatus } = await import('./moderation');
const { sweepCandidates, ethSweepCandidates, TooManyDepositAddresses } = await import('../workers/sweep-gas');

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
async function makeCreator(extra: Record<string, unknown> = {}, profile: Record<string, unknown> = {}) {
  const userId = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED', ...extra });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'C', ...profile } });
  return userId;
}
const acct = (userId: string) => prisma.account.findUniqueOrThrow({ where: { userId } });
const kyc = async (id: string) => prisma.user.findUniqueOrThrow({ where: { id }, select: { kycStatus: true, kycStatusAt: true, kycRef: true } });
const reviewed = (userId: string, applicantId: string, answer: 'GREEN' | 'RED', at: string) =>
  ({ type: 'applicantReviewed', externalUserId: userId, applicantId, reviewResult: { reviewAnswer: answer }, createdAtMs: at });

describe('srv-auth-core#1: KYC webhook ordering', () => {
  it('parses Sumsub timestamps', () => {
    expect(kycEventTime({ createdAtMs: '2026-09-01 10:00:00.123' })?.toISOString()).toBe('2026-09-01T10:00:00.123Z');
    expect(kycEventTime({ createdAt: '2026-09-01 10:00:00+0000' })?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(kycEventTime({ createdAtMs: 'garbage' })).toBeNull();
  });

  it('a delayed older GREEN cannot overwrite a newer RED', async () => {
    const u = await makeUser({ role: 'CREATOR', kycRef: 'app-1' });
    expect(await applyKycEvent(reviewed(u, 'app-1', 'RED', '2026-09-01 12:00:00.000'))).toBe('applied');
    expect(await applyKycEvent(reviewed(u, 'app-1', 'GREEN', '2026-09-01 11:00:00.000'))).toBe('stale');
    expect((await kyc(u)).kycStatus).toBe('REJECTED');
    // A genuinely newer GREEN still applies; a retry of the same event is idempotent.
    expect(await applyKycEvent(reviewed(u, 'app-1', 'GREEN', '2026-09-01 13:00:00.000'))).toBe('applied');
    expect(await applyKycEvent(reviewed(u, 'app-1', 'GREEN', '2026-09-01 13:00:00.000'))).toBe('applied');
    expect((await kyc(u)).kycStatus).toBe('APPROVED');
  });

  it('an older reset cannot undo a newer approval; events for a different applicant are ignored', async () => {
    const u = await makeUser({ role: 'CREATOR', kycRef: 'app-2' });
    await applyKycEvent(reviewed(u, 'app-2', 'GREEN', '2026-09-02 12:00:00.000'));
    expect(await applyKycEvent({ type: 'applicantReset', externalUserId: u, applicantId: 'app-2', createdAtMs: '2026-09-02 11:00:00.000' })).toBe('stale');
    expect(await applyKycEvent(reviewed(u, 'app-OTHER', 'RED', '2026-09-02 13:00:00.000'))).toBe('stale');
    expect(await kyc(u)).toMatchObject({ kycStatus: 'APPROVED', kycRef: 'app-2' });
  });

  it('an admin override (kycStatusAt = now) is not undone by an older webhook', async () => {
    const u = await makeUser({ role: 'CREATOR', kycRef: 'app-3' });
    const before = new Date(Date.now() - 60_000);
    // What POST /admin/users/:id/kyc writes.
    await prisma.user.updateMany({ where: { id: u }, data: { kycStatus: 'REJECTED', kycStatusAt: new Date() } });
    expect(await applyKycEvent({ ...reviewed(u, 'app-3', 'GREEN', ''), createdAtMs: before.getTime() })).toBe('stale');
    expect((await kyc(u)).kycStatus).toBe('REJECTED');
  });

  it('first review with no stored applicant records it', async () => {
    const u = await makeUser({ role: 'CREATOR' });
    expect(await applyKycEvent(reviewed(u, 'app-4', 'GREEN', '2026-09-03 10:00:00.000'))).toBe('applied');
    expect(await kyc(u)).toMatchObject({ kycStatus: 'APPROVED', kycRef: 'app-4' });
  });
});

describe('srv-auth-core#0: suspended/banned creators are not mailed', () => {
  for (const status of ['SUSPENDED', 'BANNED'] as const) {
    it(`${status}: row recorded, no mail`, async () => {
      const sent: unknown[] = [];
      registerMailTransport(async (m) => { sent.push(m); });
      const c = await makeCreator({ status }, { notifyEmail: `n-${randomUUID()}@example.test`, notifyEmailVerifiedAt: new Date(), notifyOnDm: true });
      const fan = await makeUser();
      await notifyDmReceived({ recipientId: c, actorId: fan, messageId: randomUUID(), siteUrl: 'https://example.test' });
      expect(await prisma.notification.count({ where: { userId: c } })).toBe(1);
      expect(sent).toHaveLength(0);
    });
  }
  it('an ACTIVE operating creator is still mailed', async () => {
    const sent: unknown[] = [];
    registerMailTransport(async (m) => { sent.push(m); });
    const c = await makeCreator({}, { notifyEmail: `n-${randomUUID()}@example.test`, notifyEmailVerifiedAt: new Date(), notifyOnDm: true });
    const fan = await makeUser();
    await notifyDmReceived({ recipientId: c, actorId: fan, messageId: randomUUID(), siteUrl: 'https://example.test' });
    expect(sent).toHaveLength(1);
  });
});

describe('srv-money-modules#0: a ban cancels only live subscriptions', () => {
  it('EXPIRED rows stay EXPIRED (not flooded into the renewal due set)', async () => {
    const creator = await makeCreator();
    const tier = await prisma.subscriptionTier.create({ data: { creatorId: creator, name: 't', priceCents: 999 } });
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 86_400_000);
    const [f1, f2] = [await makeUser(), await makeUser()];
    await prisma.subscription.create({ data: { fanId: f1, creatorId: creator, tierId: tier.id, priceCents: 999, currentPeriodEnd: past, status: 'EXPIRED' } });
    await prisma.subscription.create({ data: { fanId: f2, creatorId: creator, tierId: tier.id, priceCents: 999, currentPeriodEnd: future, status: 'ACTIVE' } });
    expect(await applyUserStatus(creator, 'BANNED', { rooms: { deleteRoom: async () => {} } as any })).toBe(true);
    const rows = await prisma.subscription.findMany({ where: { creatorId: creator }, select: { fanId: true, status: true, autoRenew: true } });
    expect(rows.find((r) => r.fanId === f1)?.status).toBe('EXPIRED');
    expect(rows.find((r) => r.fanId === f2)).toMatchObject({ status: 'CANCELLED', autoRenew: false });
  });
});

describe('srv-money-modules#1: admin adjust of earnings', () => {
  async function creatorWith(deposited: number, earned: number) {
    const c = await makeCreator();
    await money(prisma, async (tx) => {
      await post(tx, c, deposited, 'ADJUSTMENT');
      await post(tx, c, earned, 'ADJUSTMENT', undefined, undefined, 'CREDITS', { earned: true });
    });
    return c;
  }

  it('an earnings clawback lowers withdrawable by the amount; the default debit keeps spending deposits first', async () => {
    const admin = await makeUser({ role: 'ADMIN' });
    const c = await creatorWith(5000, 5000);
    await adminAdjust(admin, c, { requestId: randomUUID(), amountCents: -5000, reason: 'fraud', earnings: true });
    expect(await acct(c)).toMatchObject({ balanceCents: 5000n, withdrawableCents: 0n });
    const d = await creatorWith(5000, 5000);
    await adminAdjust(admin, d, { requestId: randomUUID(), amountCents: -5000, reason: 'x' });
    expect(await acct(d)).toMatchObject({ balanceCents: 5000n, withdrawableCents: 5000n });
  });

  it('refuses a clawback past withdrawable, posting nothing', async () => {
    const admin = await makeUser({ role: 'ADMIN' });
    const c = await creatorWith(5000, 1000);
    await expect(adminAdjust(admin, c, { requestId: randomUUID(), amountCents: -2000, reason: 'x', earnings: true }))
      .rejects.toMatchObject({ reason: 'insufficient_withdrawable', statusCode: 409 });
    expect(await acct(c)).toMatchObject({ balanceCents: 6000n, withdrawableCents: 1000n });
  });

  it('an earnings credit is payable; a plain credit is not; replay must match the flag', async () => {
    const admin = await makeUser({ role: 'ADMIN' });
    const c = await creatorWith(0, 0);
    const k = randomUUID();
    await adminAdjust(admin, c, { requestId: k, amountCents: 3000, reason: 'restore', earnings: true });
    await adminAdjust(admin, c, { requestId: randomUUID(), amountCents: 1000, reason: 'goodwill' });
    expect(await acct(c)).toMatchObject({ balanceCents: 4000n, withdrawableCents: 3000n });
    expect(await adminAdjust(admin, c, { requestId: k, amountCents: 3000, reason: 'restore', earnings: true })).toEqual({ ok: true, replayed: true });
    await expect(adminAdjust(admin, c, { requestId: k, amountCents: 3000, reason: 'restore' })).rejects.toMatchObject({ reason: 'request_id_reused' });
  });
});

describe('srv-workers-infra#0: sweep reconciler candidate walk is bounded and paged', () => {
  async function seed(chainId: number, n: number) {
    const idxs: number[] = [];
    for (let i = 0; i < n; i++) {
      const u = await makeUser();
      const idx = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
      idxs.push(idx);
      await prisma.depositAddress.create({ data: { userId: u, chainId, address: `0x${randomUUID().replace(/-/g, '').padEnd(40, '0')}`, derivationIndex: idx } });
      await prisma.deposit.create({ data: { userId: u, chainId, logIndex: 0, rawAmount: '1', priceUsed: 1, asset: 'STABLE', txHash: `0x${randomUUID()}`, usdCents: 100n } });
    }
    return idxs;
  }

  it('pages through every candidate', async () => {
    const chainId = 800_000 + Math.floor(Math.random() * 90_000);
    const idxs = await seed(chainId, 5);
    const got: number[] = [];
    for await (const r of sweepCandidates(chainId, 'STABLE', { page: 2 })) got.push(r.derivationIndex);
    expect(got.sort()).toEqual(idxs.sort());
    // ETH candidates need a credited ETH deposit: none here.
    expect(await ethSweepCandidates(chainId)).toEqual([]);
  });

  it('refuses above the cap without walking', async () => {
    const chainId = 800_000 + Math.floor(Math.random() * 90_000);
    await seed(chainId, 3);
    const walk = async () => { for await (const _ of sweepCandidates(chainId, 'STABLE', { max: 2 })) { /* none */ } };
    await expect(walk()).rejects.toBeInstanceOf(TooManyDepositAddresses);
  });
});
