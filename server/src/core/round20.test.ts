import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

// Round-20 server regression tests: a renewal-pending auto-renewing
// subscriber is not ejected from a subscriber-only live stream at the period
// boundary (and the sweep decides a whole stream in batched queries); a
// creator whose approval lapsed can still opt out of notification mail and is
// no longer mailed; admin manual adjustments are idempotent and refuse
// unknown/system targets.

vi.mock('../lib/redis', async (orig) => ({
  ...(await orig<typeof import('../lib/redis')>()),
  publish: async () => 0,
}));

process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'test-lk-key';
process.env.LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'test-lk-secret-' + randomUUID();
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-' + randomUUID();

const { money, post, PLATFORM_ID, BURNED_ID } = await import('./ledger');
const { viewerIdentity } = await import('./live-identity');
const { checkViewerOnJoin, sweepLive, entitledViewers } = await import('./live-sweep');
const { LIVE_RENEWAL_GRACE_MS, isSubscribedForLive, isSubscribed } = await import('./access');
const { notifyDmReceived } = await import('./notify');
const { registerMailTransport } = await import('../lib/mailer');
const { adminAdjust, AdjustRefused } = await import('./admin-adjust');

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
async function subscribe(fanId: string, creatorId: string, periodEnd: Date, extra: Record<string, unknown> = {}) {
  const tier = await prisma.subscriptionTier.create({ data: { creatorId, name: 't', priceCents: 999 } });
  await prisma.subscription.create({ data: { fanId, creatorId, tierId: tier.id, priceCents: 999, currentPeriodEnd: periodEnd, ...extra } });
}
const fund = (userId: string, cents: number) => money(prisma, (tx) => post(tx, userId, cents, 'ADJUSTMENT'));
const bal = async (userId: string) => (await prisma.account.findUnique({ where: { userId } }))?.balanceCents ?? 0n;

function fakeRooms(roomName: string, identities: string[]) {
  const removed: string[] = [];
  const rooms = {
    listRooms: async (names?: string[]) => (names ?? []).filter((n) => n === roomName).map((name) => ({ name })),
    listParticipants: async () => identities.map((identity) => ({ identity })),
    removeParticipant: async (_room: string, identity: string) => { removed.push(identity); },
  } as any;
  return { rooms, removed };
}

describe('srv-money-modules#0: renewal grace on subscriber-only live streams', () => {
  it('keeps a due-but-not-yet-renewed auto-renewing subscriber; removes one past the grace, one not renewing, and a CANCELLED one', async () => {
    const creator = await makeCreator();
    const due = await makeUser();
    const pastGrace = await makeUser();
    const noRenew = await makeUser();
    const cancelled = await makeUser();
    const justEnded = new Date(Date.now() - 60_000);
    await subscribe(due, creator, justEnded);
    await subscribe(pastGrace, creator, new Date(Date.now() - LIVE_RENEWAL_GRACE_MS - 60_000));
    await subscribe(noRenew, creator, justEnded, { autoRenew: false });
    await subscribe(cancelled, creator, justEnded, { status: 'CANCELLED' });
    await fund(due, 5000);

    // Strict rule unchanged for everything that is not a live room.
    expect(await isSubscribed(due, creator)).toBe(false);
    expect(await isSubscribedForLive(due, creator)).toBe(true);

    const s = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't' } });
    const id = (u: string) => viewerIdentity(s.id, u);
    const { rooms, removed } = fakeRooms(s.roomName, [creator, ...[due, pastGrace, noRenew, cancelled].map(id)]);

    expect(await checkViewerOnJoin(rooms, s.roomName, id(due))).toBe(false);
    expect(await checkViewerOnJoin(rooms, s.roomName, id(pastGrace))).toBe(true);
    removed.length = 0;

    await sweepLive(rooms);
    expect(removed.sort()).toEqual([pastGrace, noRenew, cancelled].map(id).sort());
  });
});

describe('srv-money-modules#1: batched per-stream entitlement', () => {
  it('decides a ticketed + per-minute stream for many viewers in one call', async () => {
    const creator = await makeCreator();
    const s = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't', ticketPriceCents: 500, perMinuteCents: 100 } });
    const paid = await makeUser();
    const lapsed = await makeUser();
    const noTicket = await makeUser();
    const banned = await makeUser();
    for (const u of [paid, lapsed, banned]) await prisma.liveTicket.create({ data: { fanId: u, streamId: s.id } });
    await prisma.liveMinute.create({ data: { fanId: paid, streamId: s.id, minuteIndex: 0, paidCents: 100, paidThrough: new Date(Date.now() - 120_000) } });
    await prisma.liveMinute.create({ data: { fanId: paid, streamId: s.id, minuteIndex: 1, paidCents: 100, paidThrough: new Date(Date.now() + 60_000) } });
    await prisma.liveMinute.create({ data: { fanId: lapsed, streamId: s.id, minuteIndex: 0, paidCents: 100, paidThrough: new Date(Date.now() - 120_000) } });
    await prisma.liveMinute.create({ data: { fanId: noTicket, streamId: s.id, minuteIndex: 0, paidCents: 100, paidThrough: new Date(Date.now() + 60_000) } });
    await prisma.liveMinute.create({ data: { fanId: banned, streamId: s.id, minuteIndex: 0, paidCents: 100, paidThrough: new Date(Date.now() + 60_000) } });
    await prisma.user.update({ where: { id: banned }, data: { status: 'BANNED' } });

    const ok = await entitledViewers(s, [paid, lapsed, noTicket, banned, randomUUID()], new Date());
    expect([...ok]).toEqual([paid]);

    const { rooms, removed } = fakeRooms(s.roomName, [paid, lapsed, noTicket, banned].map((u) => viewerIdentity(s.id, u)).concat(['garbage']));
    await sweepLive(rooms);
    expect(removed.sort()).toEqual([...[lapsed, noTicket, banned].map((u) => viewerIdentity(s.id, u)), 'garbage'].sort());
  });

  it('a failing stream is logged and skipped; the rest of the pass still runs', async () => {
    const creator = await makeCreator();
    const other = await makeCreator();
    const bad = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't' } });
    const good = await prisma.liveStream.create({ data: { creatorId: other, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't' } });
    const intruder = await makeUser();
    const removed: string[] = [];
    const logs: unknown[] = [];
    const rooms = {
      listRooms: async (names?: string[]) => (names ?? []).filter((n) => n === bad.roomName || n === good.roomName).map((name) => ({ name })),
      listParticipants: async (room: string) => room === bad.roomName ? [{ identity: viewerIdentity(bad.id, intruder) }] : [{ identity: viewerIdentity(good.id, intruder) }],
      removeParticipant: async (room: string, identity: string) => { if (room === bad.roomName) throw new Error('lk down'); removed.push(identity); },
    } as any;
    await sweepLive(rooms, new Date(), (...a) => logs.push(a));
    expect(removed).toContain(viewerIdentity(good.id, intruder));
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe('srv-auth-core#0: notification opt-out for a creator whose approval lapsed', () => {
  async function settingsApp(as: string, role: 'CREATOR' | 'ADMIN' | 'FAN') {
    const Fastify = (await import('fastify')).default;
    const { authPlugin } = await import('../plugins/auth');
    const { notifications } = await import('../modules/notifications');
    const app = Fastify();
    await app.register(authPlugin);
    await app.register(notifications, { prefix: '/notifications' });
    await app.ready();
    const token = app.jwt.sign({ id: as, role });
    return { app, headers: { authorization: `Bearer ${token}` } };
  }

  it('can load settings and opt out, but cannot opt back in or name a new address', async () => {
    const c = await makeCreator({ kycStatus: 'PENDING' }, { notifyEmail: 'n@example.test', notifyEmailVerifiedAt: new Date(), notifyOnDm: true });
    const { app, headers } = await settingsApp(c, 'CREATOR');
    expect((await app.inject({ method: 'GET', url: '/notifications/settings', headers })).statusCode).toBe(200);
    const off = await app.inject({ method: 'PATCH', url: '/notifications/settings', headers, payload: { notifyOnDm: false, notifyEmail: '' } });
    expect(off.statusCode).toBe(200);
    const row = await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: c } });
    expect(row.notifyOnDm).toBe(false);
    expect(row.notifyEmail).toBeNull();
    expect((await app.inject({ method: 'PATCH', url: '/notifications/settings', headers, payload: { notifyOnDm: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/notifications/settings', headers, payload: { notifyEmail: 'x@example.test' } })).statusCode).toBe(403);
    await app.close();
  });

  it('a site-pending bridged creator can opt out too; a fan cannot reach settings', async () => {
    const c = await makeCreator({ siteUid: 'site-' + randomUUID(), siteCreatorStatus: 'pending' });
    const { app, headers } = await settingsApp(c, 'CREATOR');
    expect((await app.inject({ method: 'PATCH', url: '/notifications/settings', headers, payload: { notifyOnDm: false } })).statusCode).toBe(200);
    await app.close();
    const f = await makeUser();
    const fa = await settingsApp(f, 'FAN');
    expect((await fa.app.inject({ method: 'GET', url: '/notifications/settings', headers: fa.headers })).statusCode).toBe(403);
    await fa.app.close();
  });

  it('notifyDmReceived records the row but does not mail a creator who may not operate', async () => {
    const sent: unknown[] = [];
    registerMailTransport(async (m) => { sent.push(m); });
    const c = await makeCreator({ kycStatus: 'PENDING' }, { notifyEmail: `n-${randomUUID()}@example.test`, notifyEmailVerifiedAt: new Date(), notifyOnDm: true });
    const fan = await makeUser();
    await notifyDmReceived({ recipientId: c, actorId: fan, messageId: randomUUID(), siteUrl: 'https://example.test' });
    expect(await prisma.notification.count({ where: { userId: c } })).toBe(1);
    expect(sent).toHaveLength(0);
  });
});

describe('srv-auth-core#1: admin adjust is idempotent and refuses bad targets', () => {
  it('a replayed requestId posts once; a reused one for a different amount is refused', async () => {
    const admin = await makeUser({ role: 'ADMIN' });
    const fan = await makeUser();
    const requestId = randomUUID();
    const t0 = await bal(PLATFORM_ID);
    expect(await adminAdjust(admin, fan, { requestId, amountCents: 5000, reason: 'goodwill' })).toEqual({ ok: true, replayed: false });
    expect(await adminAdjust(admin, fan, { requestId, amountCents: 5000, reason: 'goodwill' })).toEqual({ ok: true, replayed: true });
    expect(await bal(fan)).toBe(5000n);
    expect(await bal(PLATFORM_ID)).toBe(t0 - 5000n);
    await expect(adminAdjust(admin, fan, { requestId, amountCents: 7000, reason: 'goodwill' })).rejects.toMatchObject({ reason: 'request_id_reused' });
    // Concurrent duplicates: exactly one posts.
    const k = randomUUID();
    const rs = await Promise.all([1, 2, 3].map(() => adminAdjust(admin, fan, { requestId: k, amountCents: 100, reason: 'x' })));
    expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await bal(fan)).toBe(5100n);
  });

  it('404s an unknown user, refuses system accounts, and a debit past zero unless allowNegative', async () => {
    const admin = await makeUser({ role: 'ADMIN' });
    await expect(adminAdjust(admin, randomUUID(), { requestId: randomUUID(), amountCents: 1, reason: 'x' })).rejects.toMatchObject({ reason: 'user_not_found', statusCode: 404 });
    await expect(adminAdjust(admin, PLATFORM_ID, { requestId: randomUUID(), amountCents: 1, reason: 'x' })).rejects.toBeInstanceOf(AdjustRefused);
    await expect(adminAdjust(admin, BURNED_ID, { requestId: randomUUID(), amountCents: 1, reason: 'x' })).rejects.toMatchObject({ reason: 'system_account' });
    const fan = await makeUser();
    await fund(fan, 300);
    const k = randomUUID();
    await expect(adminAdjust(admin, fan, { requestId: k, amountCents: -500, reason: 'x' })).rejects.toMatchObject({ reason: 'insufficient_balance' });
    // The refused attempt claimed nothing: the same key can be used for a valid debit.
    expect(await adminAdjust(admin, fan, { requestId: k, amountCents: -300, reason: 'x' })).toEqual({ ok: true, replayed: false });
    expect(await bal(fan)).toBe(0n);
    expect((await adminAdjust(admin, fan, { requestId: randomUUID(), amountCents: -50, reason: 'x', allowNegative: true })).ok).toBe(true);
    expect(await bal(fan)).toBe(-50n);
  });
});
