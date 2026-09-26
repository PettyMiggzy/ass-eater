import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, creditDeposit, PLATFORM_ID } from './ledger';
import { fileReport, broadcastTakenDown } from './reports';
import { applyUserStatus } from './moderation';
import { subscribeVip, VIP_PERIOD_MS } from './vip';
import { broadcastContentHash, broadcastReuseConflict } from '../modules/messages';
import { outflowLimitReason } from '../workers/payout-worker';

// Regression tests for the round-7 server fixes: a mass-DM takedown costs one
// takedown per ROOT and blanks every copy first; a direct media takedown
// (no Report) is visible to the broadcast machinery; a stale site lift cannot
// erase a newer site suspension; VIP and one-of-a-kind purchases are
// idempotent for the buyer; a reused broadcast requestId with different
// content is refused; and the payout worker's treasury outflow limits hold.

process.env.BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'test-bridge-secret-' + randomUUID();
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
async function convMessage(sender: string, other: string, data: Record<string, unknown>) {
  const [aId, bId] = sender < other ? [sender, other] : [other, sender];
  const conv = await prisma.conversation.upsert({ where: { aId_bId: { aId, bId } }, create: { aId, bId }, update: {} });
  return prisma.message.create({ data: { conversationId: conv.id, senderId: sender, ...data } as any });
}
/** A mass DM as workers/broadcast.ts writes it: one message + one media copy per fan. */
async function massDm(creator: string, fans: string[], text = 'drop', priceCents = 500) {
  const source = await prisma.media.create({ data: { ownerId: creator, key: `raw/${creator}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY' } });
  const broadcastId = 'bc-' + randomUUID();
  const messages = [];
  for (const fan of fans) {
    const m = await convMessage(creator, fan, { text, priceCents, broadcastId });
    await prisma.media.create({ data: { ownerId: creator, key: `${source.key}#${m.id}`, sourceMediaId: source.id, mime: 'image/jpeg', status: 'READY', messageId: m.id } });
    messages.push(m);
  }
  return { source, broadcastId, messages };
}
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
  const hook = async (req: any) => { req.user = { id: as(), role: 'FAN' }; };
  app.decorate('auth', hook);
  app.decorate('creatorOk', hook);
  app.decorate('role', () => hook);
  await app.register(marketplace, { prefix: '/marketplace' });
  return app;
}

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await prisma.account.upsert({ where: { userId: PLATFORM_ID }, create: { userId: PLATFORM_ID }, update: {} });
});
afterAll(async () => { await prisma.$disconnect(); });

describe('taking down a reported mass DM', () => {
  it('blanks every copy and runs ONE takedown for the drop, not one per subscriber', async () => {
    const creator = await makeCreator();
    const fans = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
    const { source, messages } = await massDm(creator, fans, "someone's private details");

    const rep = await fileReport(fans[0], 'message', messages[0].id, 'this is me');
    const app = await adminApp();
    const res = await app.inject({ method: 'POST', url: `/admin/reports/${rep.id}/resolve`, payload: { action: 'remove_content' } });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.takedowns).toHaveLength(1);
    expect(body.takedowns[0].rootMediaId).toBe(source.id);

    for (const m of messages) {
      const row = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
      expect([row.text, row.priceCents]).toEqual(['', 0]);
    }
    const media = await prisma.media.findMany({ where: { OR: [{ id: source.id }, { sourceMediaId: source.id }] } });
    expect(media).toHaveLength(fans.length + 1);
    expect(media.every((x) => x.status === 'REJECTED' && x.hlsKey === null && x.previewKey === null)).toBe(true);
  });
});

describe('DELETE /admin/media/:id (no Report)', () => {
  it('rejects the source and every copy, blanks every message carrying it, and marks the broadcast taken down', async () => {
    const creator = await makeCreator();
    const fans = [await makeUser(), await makeUser()];
    const { source, broadcastId, messages } = await massDm(creator, fans, 'priced drop', 1500);
    expect(await broadcastTakenDown(creator, broadcastId)).toBe(false);

    const copy = await prisma.media.findFirstOrThrow({ where: { sourceMediaId: source.id } });
    const app = await adminApp();
    const res = await app.inject({ method: 'DELETE', url: `/admin/media/${copy.id}` });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ rootMediaId: source.id, rejected: fans.length + 1 });

    for (const m of messages) {
      const row = await prisma.message.findUniqueOrThrow({ where: { id: m.id } });
      expect([row.text, row.priceCents]).toEqual(['', 0]);
    }
    // The durable marker the broadcast worker and the queue route both read.
    expect(await broadcastTakenDown(creator, broadcastId)).toBe(true);
  });
});

describe('a site lift never erases a newer site suspension', () => {
  it('applyUserStatus(ACTIVE, bySite) is refused while either recorded site standing restricts the account', async () => {
    const creatorSuspended = await makeUser({ status: 'SUSPENDED', statusBySite: true, siteCreatorStatus: 'suspended' });
    expect(await applyUserStatus(creatorSuspended, 'ACTIVE', { bySite: true })).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: creatorSuspended } })).status).toBe('SUSPENDED');

    const accountBanned = await makeUser({ status: 'SUSPENDED', statusBySite: true, siteCreatorStatus: 'active', siteAccountStatus: 'banned' });
    expect(await applyUserStatus(accountBanned, 'ACTIVE', { bySite: true })).toBe(false);

    const lapsed = await makeUser({ status: 'SUSPENDED', statusBySite: true, siteCreatorStatus: 'active', siteAccountStatus: null });
    expect(await applyUserStatus(lapsed, 'ACTIVE', { bySite: true })).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: lapsed } })).status).toBe('ACTIVE');

    // An admin's decision is unaffected by the site's standings.
    expect(await applyUserStatus(creatorSuspended, 'ACTIVE')).toBe(true);
  });

  it('the lapse sweep does not reactivate an account the site suspended again after the claim', async () => {
    // Simulates the interleaving: the sweep claimed the row (site standing
    // now 'active'), then a new site suspension landed before its lift.
    const uid = await makeUser({ status: 'SUSPENDED', statusBySite: true, siteCreatorStatus: 'active' });
    await prisma.user.update({ where: { id: uid }, data: { siteCreatorStatus: 'suspended', siteSuspendedUntil: new Date(Date.now() + 30 * 86_400_000) } });
    expect(await applyUserStatus(uid, 'ACTIVE', { bySite: true })).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: uid } })).status).toBe('SUSPENDED');
  });
});

describe('VIP purchase idempotency', () => {
  it('a repeat carrying the pre-purchase expiry is answered already:true and charges nothing', async () => {
    const fan = await makeUser();
    await deposit(fan, 10_000);
    const start = await balance(fan);
    const first = await money(prisma, (tx) => subscribeVip(tx, fan, undefined, null));
    expect(first.already).toBe(false);
    const after = await balance(fan);
    expect(after).toBe(start - 2_000n);

    // Double-tap / retry: same body as the first request.
    const again = await money(prisma, (tx) => subscribeVip(tx, fan, undefined, null));
    expect(again.already).toBe(true);
    expect(await balance(fan)).toBe(after);
    expect(again.vipUntil?.getTime()).toBe(first.vipUntil.getTime());

    // A deliberate extension, confirmed against the current expiry, charges.
    const ext = await money(prisma, (tx) => subscribeVip(tx, fan, undefined, first.vipUntil));
    expect(ext.already).toBe(false);
    expect(ext.vipUntil.getTime()).toBe(first.vipUntil.getTime() + VIP_PERIOD_MS);
    expect(await balance(fan)).toBe(start - 4_000n);
  });

  it('concurrent double-tap charges once', async () => {
    const fan = await makeUser();
    await deposit(fan, 10_000);
    const start = await balance(fan);
    const rs = await Promise.all([0, 1].map(() => money(prisma, (tx) => subscribeVip(tx, fan, undefined, null))));
    expect(rs.filter((r) => !r.already)).toHaveLength(1);
    expect(await balance(fan)).toBe(start - 2_000n);
  });
});

describe('one-of-a-kind buy is idempotent for its buyer', () => {
  it("the winning buyer's retry returns their order instead of not_available, and charges nothing", async () => {
    const creator = await makeCreator();
    const listing = await prisma.listing.create({ data: { creatorId: creator, title: 'one', priceCents: 3000, status: 'ACTIVE', unlimited: false } as any });
    await prisma.media.create({ data: { ownerId: creator, key: `raw/${creator}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY', listingId: listing.id } });
    const buyer = await makeUser();
    await deposit(buyer, 5_000);
    const start = await balance(buyer);
    let who = buyer;
    const app = await marketplaceApp(() => who);
    const buy = () => app.inject({ method: 'POST', url: `/marketplace/listings/${listing.id}/buy`, payload: { ageConfirmed: true, tosAccepted: true, expectedTotalCents: 3000 } });

    const first = await buy();
    expect(first.statusCode).toBe(200);
    expect(first.json().already).toBeFalsy();
    const retry = await buy();
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ ok: true, already: true, order: { id: first.json().order.id } });
    expect(await balance(buyer)).toBe(start - 3_000n);

    // Anyone else still gets not_available.
    who = await makeUser();
    await deposit(who, 5_000);
    expect((await buy()).statusCode).toBe(400);
    await app.close();
  });
});

describe('broadcast requestId reuse', () => {
  const content = { text: 'drop', priceCents: 1500, mediaIds: ['b', 'a'] };
  const hash = broadcastContentHash(content);

  it('hashes order-free and distinguishes edits', () => {
    expect(broadcastContentHash({ ...content, mediaIds: ['a', 'b'] })).toBe(hash);
    expect(broadcastContentHash({ ...content, priceCents: 1000 })).not.toBe(hash);
    expect(broadcastContentHash({ ...content, text: 'drop!' })).not.toBe(hash);
  });

  it('conflicts with a live job carrying different content, not with the same content', async () => {
    const creator = randomUUID();
    const q = (data: any) => ({ getJob: async () => ({ data }) });
    expect(await broadcastReuseConflict(q({ contentHash: hash }), creator, 'bc-' + randomUUID(), hash)).toBe(false);
    expect(await broadcastReuseConflict(q({ contentHash: broadcastContentHash({ ...content, priceCents: 1000 }) }), creator, 'bc-' + randomUUID(), hash)).toBe(true);
    // A job queued before contentHash existed is compared on its fields.
    expect(await broadcastReuseConflict(q({ ...content }), creator, 'bc-' + randomUUID(), hash)).toBe(false);
  });

  it('conflicts with copies already delivered under that id with different content', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const { source, broadcastId } = await massDm(creator, [fan], 'the $15 version', 1500);
    const none = { getJob: async () => null };
    const same = broadcastContentHash({ text: 'the $15 version', priceCents: 1500, mediaIds: [source.id] });
    expect(await broadcastReuseConflict(none, creator, broadcastId, same)).toBe(false);
    const edited = broadcastContentHash({ text: 'the $10 version', priceCents: 1000, mediaIds: [source.id] });
    expect(await broadcastReuseConflict(none, creator, broadcastId, edited)).toBe(true);
  });
});

describe('payout worker treasury outflow limits (env, not DB)', () => {
  it('holds a payout over the per-payout cap', async () => {
    expect(await outflowLimitReason(randomUUID(), 500_001)).toMatch(/per-payout limit/);
    expect(await outflowLimitReason(randomUUID(), 0)).toMatch(/invalid/);
  });

  it('holds a payout that would push the rolling 24h outflow past the daily cap', async () => {
    const creator = await makeCreator();
    // Clear any signed outflow other tests left in this window.
    await prisma.payout.updateMany({ where: { signedAt: { gte: new Date(Date.now() - 86_400_000) } }, data: { signedAt: new Date(Date.now() - 2 * 86_400_000) } });
    for (let i = 0; i < 4; i++) {
      await prisma.payout.create({ data: { creatorId: creator, asset: 'STABLE', address: '0x' + '1'.repeat(40), amountCents: 450_000n, feeCents: 0n, status: 'SENT', signedAt: new Date() } });
    }
    // 1,800,000 signed in the last 24h: 200,000 more fits, 200,001 does not.
    expect(await outflowLimitReason(randomUUID(), 200_000)).toBeNull();
    expect(await outflowLimitReason(randomUUID(), 200_001)).toMatch(/daily payout limit/);
    // Older than the window: does not count.
    await prisma.payout.updateMany({ where: { creatorId: creator }, data: { signedAt: new Date(Date.now() - 2 * 86_400_000) } });
    expect(await outflowLimitReason(randomUUID(), 450_000)).toBeNull();
  });
});
