import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { charge, grossFanSpendCents, money, post, PLATFORM_ID } from './ledger';
import { settleReferrals } from './referrals';
import { applyUserStatus } from './moderation';
import { creatorMayOperate } from './creator-standing';
import { createUploadWithinQuota, UPLOAD_LIMITS } from './upload-limits';
import { assertCleanTags, assertCleanText } from '../lib/text-screen';
import { fanSafeMeta } from '../modules/wallet';
import { ethSweepCandidates } from '../workers/sweep-gas';

// Round-16 server regression tests: a site 'pending' lifts the site's own
// ban (and only that); server/ free text runs the site's screens; admin GMV
// counts every fan charge type once; Media.bytes holds a 4 GiB video; a
// referrer's history never says what the referred fan bought; a paid DM's
// price_changed carries the new price; the ETH sweep reconciler ignores
// price-pending deposits.

process.env.BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'test-bridge-secret-' + randomUUID();
const { syncSiteStanding, resolveBridgedUser } = await import('../lib/bridge');

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
const fund = (userId: string, cents: number) => money(prisma, (tx) => post(tx, userId, cents, 'ADJUSTMENT'));
const noRooms = { deleteRoom: async () => undefined };
const creatorClaims = (uid: string, creatorStatus: string, standingAt?: number) => ({
  typ: 'bridge', uid, email: `${uid}@site.test`, username: `s_${uid.slice(0, 8)}`, role: 'CREATOR', creatorStatus,
  jti: randomUUID(), exp: Date.now() + 60_000, ...(standingAt !== undefined ? { standingAt } : {}),
}) as any;

/** A bare Fastify app with `as` as the authenticated user (as round15.test.ts). */
async function appWith(plugin: any, prefix: string, as: string) {
  const Fastify = (await import('fastify')).default;
  const { serializeReply } = await import('../lib/json-reply');
  const app = Fastify();
  app.setReplySerializer(serializeReply);
  const hook = async (req: any) => { req.user = { id: as, role: 'CREATOR' }; };
  app.decorate('auth', hook);
  app.decorate('creatorOk', hook);
  app.decorate('role', () => hook);
  await app.register(plugin, { prefix });
  return app;
}

describe("srv-auth-core#0: a site 'pending' lifts the site's own ban", () => {
  it('site ban then pending: ACTIVE here, still not an operating creator', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    const id = r.user.id;
    expect(await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'banned', { standingAt: t0 + 1_000, fan: false })).toBe('banned');
    expect(await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'pending', { standingAt: t0 + 2_000, fan: false })).toBe('reactivated');
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(u).toMatchObject({ status: 'ACTIVE', siteCreatorStatus: 'pending' });
    expect(creatorMayOperate(u)).toBe(false);
    // And the exchange of a 'pending' token now bridges (it was account_banned).
    expect((await resolveBridgedUser(creatorClaims(uid, 'pending', t0 + 3_000))).ok).toBe(true);
  });

  it('an exchange of a pending token after a site ban lifts it too', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } }), 'banned', { standingAt: t0 + 1_000, fan: false });
    const again = await resolveBridgedUser(creatorClaims(uid, 'pending', t0 + 2_000));
    expect(again.ok).toBe(true);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } })).toMatchObject({ status: 'ACTIVE', siteCreatorStatus: 'pending' });
  });

  it("an admin ban answers ban_needs_server_admin to a 'pending' (route: 409), not unchanged", async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    await applyUserStatus(r.user.id, 'BANNED', { rooms: noRooms });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(await syncSiteStanding(u, 'pending', { standingAt: t0 + 1_000, fan: false })).toBe('ban_needs_server_admin');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } })).status).toBe('BANNED');
  });

  it("a fan 'pending' still changes nothing", async () => {
    const id = await makeUser({ siteUid: randomUUID() });
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(await syncSiteStanding(u, 'pending', { fan: true })).toBe('unchanged');
  });
});

describe('srv-auth-core#1: server/ free text runs the site screens', () => {
  it('the copies are byte-identical to the site modules', () => {
    for (const f of ['prohibited-terms.js', 'payment-circumvention-filter.js']) {
      const here = readFileSync(fileURLToPath(new URL(`../lib/site-screens/${f}`, import.meta.url)), 'utf8');
      const site = readFileSync(fileURLToPath(new URL(`../../../lib/${f}`, import.meta.url)), 'utf8');
      expect(here, `${f} drifted from the site's lib/${f}: copy it again`).toBe(site);
    }
  });

  it('assertCleanText refuses circumvention and prohibited terms, passes clean text', () => {
    expect(() => assertCleanText([['bio', 'cashapp $jess99 for customs, text 617 555 1234']])).toThrow('payment_circumvention');
    expect(() => assertCleanText([['tag', ['fitness', 'teen']]])).toThrow('prohibited_terms');
    expect(() => assertCleanText([['bio', 'Gym, travel and behind-the-scenes sets.'], ['tag', ['fitness', 'travel']], ['displayName', undefined]])).not.toThrow();
  });

  it('assertCleanTags also screens the tags together, as the site does', () => {
    expect(() => assertCleanTags(['barely', 'legal'])).toThrow('prohibited_terms');
    expect(() => assertCleanTags(['venmo', '@janedoe'])).toThrow('payment_circumvention');
    expect(() => assertCleanTags(['fitness', 'teen'])).toThrow('prohibited_terms');
    expect(() => assertCleanTags(['fitness', 'travel', 'gym', 'instagram'])).not.toThrow();
    expect(() => assertCleanTags(undefined)).not.toThrow();
  });

  it('PATCH /creators/me refuses a flagged bio or tag and saves nothing', async () => {
    const { creators } = await import('../modules/creators');
    const c = await makeCreator({}, { bio: 'before' });
    const app = await appWith(creators, '/creators', c);
    for (const body of [{ bio: 'cashapp $jess99, text 617 555 1234' }, { tags: ['teen'] }, { tags: ['barely', 'legal'] }, { tags: ['venmo', '@janedoe'] }, { displayName: 'jailbait' }]) {
      const res = await app.inject({ method: 'PATCH', url: '/creators/me', payload: body });
      expect(res.statusCode).toBe(400);
    }
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: c } })).bio).toBe('before');
    const ok = await app.inject({ method: 'PATCH', url: '/creators/me', payload: { bio: 'Gym and travel.', tags: ['fitness'] } });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });
});

describe('srv-auth-core#2: admin GMV counts every fan charge once', () => {
  it('includes DM, live minute/tip, token lock, VIP and marketplace (fixed and auction); excludes holds and payouts', async () => {
    const since = new Date(Date.now() - 1_000);
    const before = await grossFanSpendCents(prisma, since);
    const fan = await makeUser();
    const creator = await makeCreator();
    const rows: Array<[string, number]> = [
      ['DM_SEND', -199], ['LIVE_MINUTE', -300], ['LIVE_TIP', -500], ['TOKEN_LOCK', -1000], ['SUBSCRIPTION', -2000 /* VIP */],
      ['AUCTION_BID_HOLD', -7000], ['PAYOUT', -400], ['ADJUSTMENT', -50],
      ['MARKETPLACE_SALE', -1200], // the fixed-price fan debit: counted from its order instead
    ];
    for (const [type, cents] of rows) await prisma.ledgerEntry.create({ data: { userId: fan, amountCents: BigInt(cents), type: type as any } });
    const l = await prisma.listing.create({ data: { creatorId: creator, title: 'x', priceCents: 1000 } });
    await prisma.listingOrder.create({ data: { listingId: l.id, buyerId: fan, priceCents: 1000, shippingCents: 200, platformFeeCents: 100, listingFeeCents: 50 } });
    const a = await prisma.listing.create({ data: { creatorId: creator, title: 'y', priceCents: 1000, saleType: 'AUCTION' } });
    await prisma.listingOrder.create({ data: { listingId: a.id, buyerId: fan, priceCents: 3000, shippingCents: 0, platformFeeCents: 300, listingFeeCents: 150 } });
    const after = await grossFanSpendCents(prisma, since);
    expect(after - before).toBe(199 + 300 + 500 + 1000 + 2000 + 1200 + 3000);
  });
});

describe('srv-money-modules#0: Media.bytes holds a creator video over 2 GiB', () => {
  it('a 3 GiB upload is recorded and counted toward the daily quota', async () => {
    const c = await makeCreator();
    const bytes = 3 * 1024 ** 3;
    expect(bytes).toBeLessThanOrEqual(UPLOAD_LIMITS.CREATOR_VIDEO_MAX_BYTES);
    const r = await createUploadWithinQuota(c, true, { key: `t/${randomUUID()}`, mime: 'video/mp4', bytes });
    if (!('media' in r)) throw new Error(`refused: ${r.error}`);
    expect((await prisma.media.findUniqueOrThrow({ where: { id: r.media.id } })).bytes).toBe(BigInt(bytes));
    // 3 GiB + 18 GiB still fits the 20 GiB/day cap only up to it: the sum is read correctly.
    const over = await createUploadWithinQuota(c, true, { key: `t/${randomUUID()}`, mime: 'video/mp4', bytes: UPLOAD_LIMITS.CREATOR_DAILY_BYTES - bytes + 1 });
    expect(over).toEqual({ error: 'upload_quota_exceeded' });
  });
});

describe("srv-money-modules#1: a referrer never sees what the referred fan bought", () => {
  it('REFERRAL rows carry no refId, and history shows only which side was referred', async () => {
    const referrer = await makeUser();
    const fan = await makeUser({ referredById: referrer });
    const creator = await makeCreator();
    await fund(fan, 10_000);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'DM_SEND', refId: `dm:${fan}:${randomUUID()}` }));
    // Round 18: the cut is held and credited per ended UTC day
    // (core/referrals.ts); the charge ref stays on the pending row only.
    const pending = await prisma.pendingReferral.findFirstOrThrow({ where: { referrerId: referrer } });
    expect(pending.chargeRefId).toMatch(/^dm:/);
    await settleReferrals({ now: new Date(Date.now() + 864e5), referrerIds: [referrer] });
    const row = await prisma.ledgerEntry.findFirstOrThrow({ where: { userId: referrer, type: 'REFERRAL' } });
    expect(row.refId).toBeNull();
    expect((row.meta as any).chargeRefId).toBeUndefined();

    // An older row that still carries the purchase ref (and a stray fanId).
    await prisma.ledgerEntry.create({ data: { userId: referrer, amountCents: 5n, type: 'REFERRAL', refId: 'post-123', meta: { for: 'fan', fanId: fan } } });
    // Round 17: referral rows are shown only for ENDED UTC days, one row per
    // day per side (round17.test.ts) -- so both are moved to yesterday here.
    await prisma.ledgerEntry.updateMany({ where: { userId: referrer, type: 'REFERRAL' }, data: { createdAt: new Date(Date.now() - 864e5) } });
    const { wallet } = await import('../modules/wallet');
    const app = await appWith(wallet, '/wallet', referrer);
    const res = await app.inject({ method: 'GET', url: '/wallet/history' });
    expect(res.statusCode).toBe(200);
    const refs = res.json().filter((r: any) => r.type === 'REFERRAL');
    expect(refs.length).toBe(1);
    for (const r of refs) {
      expect(r.refId).toBeNull();
      expect(r.meta).toEqual({ for: 'fan' });
    }
    expect(JSON.stringify(res.json())).not.toContain(fan);
    await app.close();
    expect(fanSafeMeta('REFERRAL', null)).toEqual({});
  });
});

describe('srv-money-modules#2: price_changed carries the new price', () => {
  it('POST /messages/to answers 409 { error, priceCents } and charges nothing', async () => {
    const { messages } = await import('../modules/messages');
    const creator = await makeCreator({}, { inboundDmPriceCents: 250 });
    const fan = await makeUser();
    const tier = await prisma.subscriptionTier.create({ data: { creatorId: creator, name: 't', priceCents: 999 } });
    await prisma.subscription.create({ data: { fanId: fan, creatorId: creator, tierId: tier.id, priceCents: 999, currentPeriodEnd: new Date(Date.now() + 864e5) } });
    await fund(fan, 5_000);
    const app = await appWith(messages, '/messages', fan);
    const res = await app.inject({ method: 'POST', url: `/messages/to/${creator}`, payload: { text: 'hi', expectedPriceCents: 99, requestId: randomUUID() } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'price_changed', priceCents: 250 });
    expect((await prisma.account.findUniqueOrThrow({ where: { userId: fan } })).balanceCents).toBe(5_000n);
    await app.close();
  });
});

describe('srv-workers-infra#0: the ETH sweep reconciler skips uncredited deposits', () => {
  it('only an address with a credited ETH deposit is a candidate', async () => {
    const u = await makeUser();
    const chainId = 900_000 + Math.floor(Math.random() * 90_000);
    const idx = Math.floor(Math.random() * 1_000_000);
    await prisma.depositAddress.create({ data: { userId: u, chainId, address: `0x${randomUUID().replace(/-/g, '').padEnd(40, '0')}`, derivationIndex: idx } });
    const base = { userId: u, chainId, logIndex: 0, rawAmount: '1', priceUsed: 0, asset: 'ETH' as const };
    await prisma.deposit.create({ data: { ...base, txHash: `0x${randomUUID()}`, usdCents: 0n, pricePending: true } });
    expect(await ethSweepCandidates(chainId)).toEqual([]);
    await prisma.deposit.create({ data: { ...base, txHash: `0x${randomUUID()}`, usdCents: 2500n, priceUsed: 2500 } });
    // Round 17: still none while the earlier deposit is price-pending (the
    // sweep moves the whole balance); a candidate once it is priced.
    expect(await ethSweepCandidates(chainId)).toEqual([]);
    await prisma.deposit.updateMany({ where: { userId: u, chainId, pricePending: true }, data: { pricePending: false, usdCents: 100n, priceUsed: 2500 } });
    expect((await ethSweepCandidates(chainId)).map((r) => r.derivationIndex)).toEqual([idx]);
  });
});
