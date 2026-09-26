import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import crypto, { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, creditDeposit, PLATFORM_ID } from './ledger';
import { notifyDmReceived, NOTIFY_MAIL_COOLDOWN_MS } from './notify';
import { fileReport } from './reports';
import { clearMailTransport, registerMailTransport, sendNotificationMail } from '../lib/mailer';
import { unlockPost, postHasDeliverable } from '../modules/posts';
import { sendDirectMessage } from '../modules/messages';
import { chunk } from '../workers/indexer-chunks';

// Regression tests for the round-4 server fixes: PPV posts need a
// deliverable, paid DMs are idempotent, site standing messages are ordered
// (and carry fan standing), notification email goes only to a confirmed
// address, reports de-duplicate, and the deposit indexer chunks its filter.

process.env.BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'test-bridge-secret-' + randomUUID();
const { resolveBridgedUser, verifyBridgeToken, verifyBridgeStatusToken, syncSiteStanding } = await import('../lib/bridge');

const prisma = new PrismaClient();

async function makeUser(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01'), ...extra } });
  return id;
}
async function makeCreator(profile: Record<string, unknown> = {}) {
  const userId = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED' });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'C', ...profile } });
  return userId;
}
const deposit = (userId: string, cents: number) => money(prisma, (tx) => creditDeposit(tx, userId, BigInt(cents), `dep-${randomUUID()}`));
const balance = async (userId: string) => (await prisma.account.findUniqueOrThrow({ where: { userId } })).balanceCents;
const sign = (payload: object) => {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${crypto.createHmac('sha256', process.env.BRIDGE_SECRET!).update(b64).digest('base64url')}`;
};

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await prisma.account.upsert({ where: { userId: PLATFORM_ID }, create: { userId: PLATFORM_ID }, update: {} });
  await prisma.platformConfig.upsert({ where: { id: 1 }, create: { id: 1, minDmPriceCents: 99 }, update: { minDmPriceCents: 99 } });
});
afterAll(async () => { await prisma.$disconnect(); });

describe('PPV posts must have something behind the paywall', () => {
  const media = (ownerId: string, status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'REJECTED', postId: string) =>
    prisma.media.create({ data: { ownerId, key: `raw/${ownerId}/${randomUUID()}`, mime: 'image/jpeg', status, postId } });

  it('refuses to sell a PPV post whose media is not READY, or that is empty, and charges nothing', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 10_000);
    const before = await balance(fan);

    const uploading = await prisma.post.create({ data: { creatorId: creator, text: '', visibility: 'PPV', priceCents: 500 } });
    await media(creator, 'UPLOADING', uploading.id);
    expect(await postHasDeliverable(prisma as any, uploading.id)).toBe(false);
    await expect(unlockPost(fan, uploading)).rejects.toMatchObject({ message: 'no_deliverable', statusCode: 409 });

    const rejected = await prisma.post.create({ data: { creatorId: creator, text: 'caption', visibility: 'PPV', priceCents: 500 } });
    await media(creator, 'READY', rejected.id);
    await media(creator, 'REJECTED', rejected.id);
    await expect(unlockPost(fan, rejected)).rejects.toMatchObject({ message: 'no_deliverable' });

    const empty = await prisma.post.create({ data: { creatorId: creator, text: '   ', visibility: 'PPV', priceCents: 500 } });
    await expect(unlockPost(fan, empty)).rejects.toMatchObject({ message: 'no_deliverable' });

    expect(await balance(fan)).toBe(before);
    expect(await prisma.postUnlock.count({ where: { fanId: fan } })).toBe(0);
  });

  it('sells a PPV post with READY media, or with text alone', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 10_000);
    const withMedia = await prisma.post.create({ data: { creatorId: creator, text: '', visibility: 'PPV', priceCents: 500 } });
    await media(creator, 'READY', withMedia.id);
    expect((await unlockPost(fan, withMedia)).ok).toBe(true);
    const textOnly = await prisma.post.create({ data: { creatorId: creator, text: 'the goods', visibility: 'PPV', priceCents: 500 } });
    expect((await unlockPost(fan, textOnly)).ok).toBe(true);
  });
});

describe('paid DMs are idempotent per (sender, requestId)', () => {
  it('a retried or double-clicked send charges once and writes one message', async () => {
    const creator = await makeCreator({ inboundDmPriceCents: 500 });
    const fan = await makeUser();
    await deposit(fan, 10_000);
    const before = await balance(fan);
    const b = { text: 'hi', mediaIds: [], priceCents: 0, expectedPriceCents: 500, requestId: randomUUID() };

    const [x, y] = await Promise.all([
      sendDirectMessage(fan, creator, false, b),
      sendDirectMessage(fan, creator, false, b),
    ]);
    expect(x.msg.id).toBe(y.msg.id);
    expect([x.already, y.already].sort()).toEqual([false, true]);
    // A later retry (even after a price change) returns the same message.
    await prisma.creatorProfile.update({ where: { userId: creator }, data: { inboundDmPriceCents: 900 } });
    const z = await sendDirectMessage(fan, creator, false, b);
    expect(z).toMatchObject({ already: true });
    expect(z.msg.id).toBe(x.msg.id);

    expect(await balance(fan)).toBe(before - 500n);
    expect(await prisma.message.count({ where: { senderId: fan } })).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { userId: fan, type: 'DM_SEND' } })).toBe(1);
  });

  it('a new requestId is a new message and a new charge', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 10_000);
    const before = await balance(fan);
    await sendDirectMessage(fan, creator, false, { text: 'a', mediaIds: [], priceCents: 0, expectedPriceCents: 99, requestId: randomUUID() });
    await sendDirectMessage(fan, creator, false, { text: 'b', mediaIds: [], priceCents: 0, expectedPriceCents: 99, requestId: randomUUID() });
    expect(await balance(fan)).toBe(before - 198n);
  });
});

describe('site standing messages are ordered, and fans carry standing too', () => {
  const creatorClaims = (uid: string, creatorStatus: 'active' | 'pending' | 'suspended' | 'banned', standingAt?: number) => ({
    typ: 'bridge' as const, uid, email: `${uid}@site.test`, username: `u_${uid.replace(/-/g, '').slice(0, 12)}`,
    role: 'CREATOR' as const, creatorStatus, jti: randomUUID(), exp: Date.now() + 60_000, ...(standingAt ? { standingAt } : {}),
  });

  it("a stale 'active' exchange does not lift a newer site suspension", async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 10_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    // Suspension pushed at t0+5s.
    expect(await syncSiteStanding(r.user, 'suspended', { standingAt: t0 + 5_000 })).toBe('suspended');
    // A token minted 'active' at t0+2s, exchanged after the push.
    expect(await resolveBridgedUser(creatorClaims(uid, 'active', t0 + 2_000))).toMatchObject({ ok: false, error: 'account_suspended' });
    // So is an unstamped one, once stamped standing exists.
    expect(await resolveBridgedUser(creatorClaims(uid, 'active'))).toMatchObject({ ok: false, error: 'account_suspended' });
    // A NEWER 'active' does lift it.
    expect((await resolveBridgedUser(creatorClaims(uid, 'active', t0 + 8_000))).ok).toBe(true);
  });

  it("an out-of-order push is ignored ('stale'), and a stale 'active' cannot re-approve a creator moved back to pending", async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 10_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    let u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(await syncSiteStanding(u, 'pending', { standingAt: t0 + 5_000 })).toBe('unchanged');
    u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.siteCreatorStatus).toBe('pending');
    expect(await syncSiteStanding(u, 'active', { standingAt: t0 + 1_000 })).toBe('stale');
    await resolveBridgedUser(creatorClaims(uid, 'active', t0 + 2_000));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } })).siteCreatorStatus).toBe('pending');
  });

  it('refuses a standingAt far in the future or after the token expiry', () => {
    const uid = randomUUID();
    expect(verifyBridgeToken(sign(creatorClaims(uid, 'active', Date.now() + 3600_000)))).toBeNull();
    const push = { typ: 'bridge_status', uid, creatorStatus: 'banned', jti: randomUUID(), exp: Date.now() + 60_000 };
    expect(verifyBridgeStatusToken(sign({ ...push, standingAt: Date.now() + 3600_000 }))).toBeNull();
    expect(verifyBridgeStatusToken(sign({ ...push, standingAt: Date.now() - 1000 }))?.standingAt).toBeGreaterThan(0);
  });

  it('a site-banned FAN is banned here: auto-renew off, exchange refused', async () => {
    const uid = randomUUID();
    const fanClaims = (standing: string | null, standingAt?: number) => verifyBridgeToken(sign({
      typ: 'bridge', uid, email: `${uid}@site.test`, username: `u_${uid.replace(/-/g, '').slice(0, 12)}`,
      role: 'FAN', standing, jti: randomUUID(), exp: Date.now() + 60_000, ...(standingAt ? { standingAt } : {}),
    }));
    const c0 = fanClaims(null);
    expect(c0?.creatorStatus).toBeNull();
    const r = await resolveBridgedUser(c0!);
    if (!r.ok) throw new Error('setup');
    const creator = await makeCreator();
    const tier = await prisma.subscriptionTier.create({ data: { creatorId: creator, name: 't', priceCents: 500 } });
    await prisma.subscription.create({ data: { fanId: r.user.id, creatorId: creator, tierId: tier.id, priceCents: 500, currentPeriodEnd: new Date(Date.now() + 864e5) } });

    const banned = fanClaims('banned', Date.now());
    expect(banned?.fanStatus).toBe('banned');
    expect(banned?.creatorStatus).toBeNull();
    expect(await resolveBridgedUser(banned!)).toMatchObject({ ok: false, status: 403, error: 'banned' });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.status).toBe('BANNED');
    expect(u.siteCreatorStatus).toBeNull();   // a fan's standing is not creator approval
    expect((await prisma.subscription.findFirstOrThrow({ where: { fanId: r.user.id } })).autoRenew).toBe(false);
    // A fan is never 'pending'.
    expect(fanClaims('pending')).toBeNull();
  });

  it('a site suspension of a fan, pushed, lifts only on a newer active', async () => {
    const uid = randomUUID();
    const r = await resolveBridgedUser({ typ: 'bridge', uid, email: `${uid}@site.test`, username: `u_${uid.replace(/-/g, '').slice(0, 12)}`, role: 'FAN', creatorStatus: null, jti: randomUUID(), exp: Date.now() + 60_000 });
    if (!r.ok) throw new Error('setup');
    const t0 = Date.now() - 5_000;
    const push = verifyBridgeStatusToken(sign({ typ: 'bridge_status', uid, standing: 'suspended', role: 'FAN', standingAt: t0, jti: randomUUID(), exp: Date.now() + 60_000 }));
    expect(push?.creatorStatus).toBe('suspended');
    let u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(await syncSiteStanding(u, push!.creatorStatus, { standingAt: push!.standingAt, fan: true })).toBe('suspended');
    u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(await syncSiteStanding(u, 'active', { standingAt: t0 - 1, fan: true })).toBe('stale');
    expect(await syncSiteStanding(u, 'active', { standingAt: t0 + 1, fan: true })).toBe('reactivated');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } })).siteCreatorStatus).toBeNull();
  });

  // The creator standing and the account standing are two dimensions: each
  // is ordered on its own clock, and 'active' in one never lifts a
  // suspension the other still holds.
  const fanPushFor = (uid: string, standing: string, standingAt: number) =>
    verifyBridgeStatusToken(sign({ typ: 'bridge_status', uid, standing, role: 'FAN', standingAt, jti: randomUUID(), exp: Date.now() + 60_000 }))!;
  const fanTokenFor = (uid: string, standing: string, standingAt: number) => verifyBridgeToken(sign({
    typ: 'bridge', uid, email: `${uid}@site.test`, username: `u_${uid.replace(/-/g, '').slice(0, 12)}`,
    role: 'FAN', standing, jti: randomUUID(), exp: Date.now() + 60_000, standingAt,
  }))!;

  it("an account-standing 'active' (push or FAN token) does not lift a creator-ladder suspension", async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 20_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    expect(await syncSiteStanding(r.user, 'suspended', { standingAt: t0 + 1_000, fan: false })).toBe('suspended');
    let u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    const p = fanPushFor(uid, 'active', t0 + 5_000);
    expect(await syncSiteStanding(u, p.creatorStatus, { standingAt: p.standingAt, fan: true })).toBe('unchanged');
    expect(await resolveBridgedUser(fanTokenFor(uid, 'active', t0 + 6_000))).toMatchObject({ ok: false, error: 'account_suspended' });
    u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.status).toBe('SUSPENDED');
    expect(u.siteCreatorStatus).toBe('suspended');   // a fan token never erases a creator restriction
    // The creator dimension saying 'active' still lifts it.
    expect(await syncSiteStanding(u, 'active', { standingAt: t0 + 7_000, fan: false })).toBe('reactivated');
  });

  it('a late account suspension is not made stale by a newer creator message', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 20_000;
    // A pending creator bridges at t0+10s (advancing the CREATOR clock)...
    const r = await resolveBridgedUser(creatorClaims(uid, 'pending', t0 + 10_000));
    if (!r.ok) throw new Error('setup');
    // ...then an account suspension decided at t0+5s arrives late.
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    const p = fanPushFor(uid, 'suspended', t0 + 5_000);
    expect(await syncSiteStanding(u, p.creatorStatus, { standingAt: p.standingAt, fan: true })).toBe('suspended');
    const after = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(after.status).toBe('SUSPENDED');
    expect(after.siteAccountStatus).toBe('suspended');
    expect(after.siteCreatorStatus).toBe('pending');
  });

  it('with both dimensions suspended, the account stays suspended until both say active', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 20_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    expect(await syncSiteStanding(r.user, 'suspended', { standingAt: t0 + 1_000, fan: false })).toBe('suspended');
    let u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(await syncSiteStanding(u, 'suspended', { standingAt: t0 + 2_000, fan: true })).toBe('unchanged');
    u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(await syncSiteStanding(u, 'active', { standingAt: t0 + 3_000, fan: false })).toBe('unchanged');
    u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.status).toBe('SUSPENDED');
    expect(await syncSiteStanding(u, 'active', { standingAt: t0 + 4_000, fan: true })).toBe('reactivated');
  });
});

describe('notification email goes only to a confirmed address', () => {
  let sent: { to: string }[] = [];
  beforeEach(() => { sent = []; registerMailTransport(async (m) => { sent.push(m); }); });

  it('never mails the account email or an unconfirmed address', async () => {
    const creator = await makeCreator({ notifyEmail: 'typed@example.test' });   // not verified
    await notifyDmReceived({ recipientId: creator, actorId: await makeUser(), messageId: randomUUID(), siteUrl: 'https://x.test' });
    expect(sent).toHaveLength(0);
    expect(await prisma.notification.count({ where: { userId: creator } })).toBe(1);
  });

  it('mails a confirmed address, at most once per cooldown window', async () => {
    const creator = await makeCreator({ notifyEmail: 'ok@example.test', notifyEmailVerifiedAt: new Date() });
    const fan = await makeUser();
    await notifyDmReceived({ recipientId: creator, actorId: fan, messageId: randomUUID(), siteUrl: 'https://x.test' });
    await notifyDmReceived({ recipientId: creator, actorId: fan, messageId: randomUUID(), siteUrl: 'https://x.test' });
    expect(sent.map((m) => m.to)).toEqual(['ok@example.test']);
    expect(await prisma.notification.count({ where: { userId: creator } })).toBe(2);
    await prisma.creatorProfile.update({ where: { userId: creator }, data: { notifyMailedAt: new Date(Date.now() - NOTIFY_MAIL_COOLDOWN_MS - 1000) } });
    await notifyDmReceived({ recipientId: creator, actorId: fan, messageId: randomUUID(), siteUrl: 'https://x.test' });
    expect(sent).toHaveLength(2);
  });

  it('never sends to a .invalid address', async () => {
    const r = await sendNotificationMail({ to: 'site-abc@bridge.invalid', kind: 'DM_RECEIVED', siteUrl: 'https://x.test' });
    expect(r).toMatchObject({ sent: false, reason: 'no_address' });
    expect(sent).toHaveLength(0);
  });

  it('the confirmation email carries only the link', async () => {
    await sendNotificationMail({ to: 'new@example.test', kind: 'CONFIRM_NOTIFY_EMAIL', confirmUrl: 'https://api.test/notifications/confirm-email?token=abc' });
    expect(sent).toHaveLength(1);
    clearMailTransport();
  });
});

describe('reports', () => {
  it("a reporter's repeat report on the same open target is not a second row", async () => {
    const a = await makeUser();
    const target = randomUUID();
    const r1 = await fileReport(a, 'message', target, 'x');
    const r2 = await fileReport(a, 'message', target, 'again');
    expect(r2.id).toBe(r1.id);
    expect(r2.already).toBe(true);
    await prisma.report.update({ where: { id: r1.id }, data: { status: 'DISMISSED' } });
    expect((await fileReport(a, 'message', target, 'new')).id).not.toBe(r1.id);
  });
});

describe('notification email confirmation is a two-step GET page + POST', () => {
  it('a GET (e.g. a mail scanner prefetching the link) confirms nothing; the POST does, once', async () => {
    const Fastify = (await import('fastify')).default;
    const { notifications } = await import('../modules/notifications');
    const app = Fastify();
    app.decorate('auth', async () => {});
    app.decorate('creatorOk', async () => {});
    app.decorate('role', () => async () => {}); // settings routes gate on the creator role since round 20
    await app.register(notifications, { prefix: '/notifications' });
    const token = crypto.randomBytes(32).toString('base64url');
    const creator = await makeCreator({
      notifyEmailPending: 'new@example.test',
      notifyEmailTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      notifyEmailTokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    const get = await app.inject({ method: 'GET', url: `/notifications/confirm-email?token=${token}` });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain('method="post"');
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: creator } })).notifyEmail).toBeNull();

    const post = await app.inject({
      method: 'POST', url: '/notifications/confirm-email',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `token=${token}`,
    });
    expect(post.statusCode).toBe(200);
    const row = await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: creator } });
    expect(row.notifyEmail).toBe('new@example.test');
    expect(row.notifyEmailPending).toBeNull();
    const again = await app.inject({ method: 'POST', url: '/notifications/confirm-email', payload: { token } });
    expect(again.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/notifications/confirm-email?token=%3Cscript%3E' })).statusCode).toBe(400);
    await app.close();
  });
});

describe('admin report resolution claims the report first', () => {
  it('two concurrent resolves: exactly one acts, the other is already_resolved', async () => {
    const Fastify = (await import('fastify')).default;
    const { admin } = await import('../modules/admin');
    const app = Fastify();
    const adminId = await makeUser({ role: 'ADMIN' });
    app.decorate('role', () => async (req: any) => { req.user = { id: adminId, role: 'ADMIN' }; });
    await app.register(admin, { prefix: '/admin' });
    const creator = await makeCreator();
    const reporter = await makeUser();
    const p = await prisma.post.create({ data: { creatorId: creator, text: 'x', visibility: 'PUBLIC', priceCents: 0 } });
    const rep = await fileReport(reporter, 'post', p.id, 'bad');
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/admin/reports/${rep.id}/resolve`, payload: { action: 'remove_content' } }),
      app.inject({ method: 'POST', url: `/admin/reports/${rep.id}/resolve`, payload: { action: 'dismiss' } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const final = await prisma.report.findUniqueOrThrow({ where: { id: rep.id } });
    const winner = a.statusCode === 200 ? 'ACTIONED' : 'DISMISSED';
    expect(final.status).toBe(winner);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: p.id } })).removed).toBe(winner === 'ACTIONED');
    await app.close();
  });
});

describe('deposit indexer address chunking', () => {
  it('splits into chunks no larger than the cap', () => {
    const xs = Array.from({ length: 1001 }, (_, i) => i);
    const parts = chunk(xs, 500);
    expect(parts.map((p) => p.length)).toEqual([500, 500, 1]);
    expect(parts.flat()).toEqual(xs);
    expect(chunk([], 500)).toEqual([]);
  });
});
