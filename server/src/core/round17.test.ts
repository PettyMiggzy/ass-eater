import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { charge, money, post, PLATFORM_ID } from './ledger';
import { settleReferrals } from './referrals';
import { canViewPost } from './access';
import { assertCleanTags, sanitizeTags } from '../lib/text-screen';
import { ethSweepCandidates, depositPricePendingFor } from '../workers/sweep-gas';
import { forEachPricedPending } from '../workers/reprice-scan';

// Round-17 server regression tests: tier names and tip notes run the site's
// screens; the tag screen is the site's findCircumventionInTags step for
// step; an unstamped creator 'pending' never lifts a newer stamped ban; a
// creator's own delete keeps a PPV post for fans who bought it; referral
// history is per UTC day; the overlay names a tipper only on opt-in; a
// backlog of unpriceable deposits never starves the rest; an ETH/$ONLYONE
// sweep waits while any deposit of that asset is price-pending.

const published = vi.hoisted(() => [] as Array<{ channel: string; evt: any }>);
vi.mock('../lib/redis', async (orig) => ({
  ...(await orig<typeof import('../lib/redis')>()),
  publish: async (channel: string, evt: object) => { published.push({ channel, evt }); return 0; },
}));

process.env.BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'test-bridge-secret-' + randomUUID();
const { syncSiteStanding, resolveBridgedUser } = await import('../lib/bridge');

const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  published.length = 0;
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
const creatorClaims = (uid: string, creatorStatus: string, standingAt?: number) => ({
  typ: 'bridge', uid, email: `${uid}@site.test`, username: `s_${uid.slice(0, 8)}`, role: 'CREATOR', creatorStatus,
  jti: randomUUID(), exp: Date.now() + 60_000, ...(standingAt !== undefined ? { standingAt } : {}),
}) as any;

async function appWith(plugin: any, prefix: string, as: string) {
  const Fastify = (await import('fastify')).default;
  const { serializeReply } = await import('../lib/json-reply');
  const app = Fastify();
  app.setReplySerializer(serializeReply);
  const hook = async (req: any) => { req.user = { id: as, role: 'CREATOR' }; };
  app.decorate('auth', hook);
  app.decorate('creatorOk', hook);
  app.decorate('role', () => hook);
  // Optional-auth routes (GET /posts/creator/:id) call req.jwtVerify().
  app.decorateRequest('jwtVerify', async function (this: any) { this.user = { id: as, role: 'CREATOR' }; } as any);
  await app.register(plugin, { prefix });
  return app;
}

describe('srv-auth-core#0 / srv-money-modules#0: tier names are screened', () => {
  it('POST and PATCH /creators/me/tiers refuse a payment handle or a prohibited phrase', async () => {
    const { creators } = await import('../modules/creators');
    const c = await makeCreator();
    const app = await appWith(creators, '/creators', c);
    for (const name of ['cashapp $janedoe', 'barely legal teen']) {
      const res = await app.inject({ method: 'POST', url: '/creators/me/tiers', payload: { name, priceCents: 299 } });
      expect(res.statusCode).toBe(400);
    }
    expect(await prisma.subscriptionTier.count({ where: { creatorId: c } })).toBe(0);
    const ok = await app.inject({ method: 'POST', url: '/creators/me/tiers', payload: { name: 'Gold', priceCents: 299 } });
    expect(ok.statusCode).toBe(200);
    const id = ok.json().id;
    for (const name of ['cashapp $janedoe', 'barely legal teen']) {
      const res = await app.inject({ method: 'PATCH', url: `/creators/me/tiers/${id}`, payload: { name } });
      expect(res.statusCode).toBe(400);
    }
    expect((await prisma.subscriptionTier.findUniqueOrThrow({ where: { id } })).name).toBe('Gold');
    // A PATCH without a name is not screened (price only).
    expect((await app.inject({ method: 'PATCH', url: `/creators/me/tiers/${id}`, payload: { priceCents: 499 } })).statusCode).toBe(200);
    await app.close();
  });
});

describe('srv-auth-core#1 / srv-workers-infra#2: tags are screened as the site screens them', () => {
  // Expected values computed with the site's own lib/listings-store.js
  // findCircumventionInTags on the same inputs.
  const cases: Array<[string[], 'payment' | 'prohibited' | null]> = [
    [['pay me on', 'snapchat'], 'payment'], [['pay via', 'telegram'], 'payment'], [['payment', 'whatsapp'], 'payment'],
    [['Pay Me On!', 'Snapchat'], 'payment'],
    [['pay pig', 'instagram'], null], [['pay per view', 'instagram'], null], [['findom', 'pay pig', 'instagram'], null],
    [['cash', 'app'], 'payment'], [['telegram', 'janedoe99'], 'payment'], [['text me', '555 123 4567'], 'payment'],
    [['tg', 'y2k'], null], [['snap', 'y2k aesthetic'], null], [['snapchat', 'jane_doe'], null], [['snap', 'cheaper'], null],
    [['fitness', 'travel', 'gym', 'instagram'], null], [['old school', 'girl next door'], null], [['y2k_aesthetic', 'x_rated'], null],
    [['venmo', '@janedoe'], 'payment'], [['barely', 'legal'], 'prohibited'],
  ];
  for (const [tags, want] of cases) {
    it(`${JSON.stringify(tags)} -> ${want ?? 'clean'}`, () => {
      if (want) expect(() => assertCleanTags(tags)).toThrow(want === 'payment' ? 'payment_circumvention' : 'prohibited_terms');
      else expect(() => assertCleanTags(tags)).not.toThrow();
    });
  }

  it('PATCH /creators/me refuses the cross-tag cue and stores tags in the screened form', async () => {
    const { creators } = await import('../modules/creators');
    const c = await makeCreator();
    const app = await appWith(creators, '/creators', c);
    expect((await app.inject({ method: 'PATCH', url: '/creators/me', payload: { tags: ['pay me on', 'snapchat'] } })).statusCode).toBe(400);
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: c } })).tags).toEqual([]);
    const ok = await app.inject({ method: 'PATCH', url: '/creators/me', payload: { tags: ['Fitness', 'Y2K_Aesthetic', 'fitness'] } });
    expect(ok.statusCode).toBe(200);
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: c } })).tags).toEqual(['fitness', 'y2kaesthetic']);
    expect(sanitizeTags(['  Hot  Yoga!! ', '', 7])).toEqual(['hot yoga']);
    await app.close();
  });
});

describe("srv-auth-core#2: an unstamped creator 'pending' never lifts a newer stamped ban", () => {
  it('stamped ban, then unstamped pending: stale, still BANNED', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    const id = r.user.id;
    expect(await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'banned', { standingAt: t0 + 1_000, fan: false })).toBe('banned');
    expect(await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'pending', { fan: false })).toBe('stale');
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe('BANNED');
    // The exchange of an unstamped pending token does not lift it either.
    expect(await resolveBridgedUser(creatorClaims(uid, 'pending'))).toMatchObject({ ok: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe('BANNED');
  });

  it('an unstamped pending still withdraws approval from an ACTIVE creator (fail safe)', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } }), 'pending', { fan: false });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } })).toMatchObject({ status: 'ACTIVE', siteCreatorStatus: 'pending' });
  });
});

describe('srv-money-modules#0/#3: tip notes are screened; the overlay names a tipper only on opt-in', () => {
  it('a flagged note is refused before any money moves', async () => {
    const { tips } = await import('../modules/tips');
    const creator = await makeCreator();
    const fan = await makeUser();
    await fund(fan, 5_000);
    const app = await appWith(tips, '/tips', fan);
    for (const note of ['cashapp $janedoe99 for private shows, text 617 555 1234', 'barely legal teen']) {
      const res = await app.inject({ method: 'POST', url: '/tips', payload: { creatorId: creator, amountCents: 500, note, idempotencyKey: randomUUID() } });
      expect(res.statusCode).toBe(400);
    }
    expect((await prisma.account.findUniqueOrThrow({ where: { userId: fan } })).balanceCents).toBe(5_000n);
    expect(await prisma.tipRequest.count({ where: { fanId: fan } })).toBe(0);
    await app.close();
  });

  it('live overlay: anonymous by default, named with showName; the creator always sees the name', async () => {
    const { tips } = await import('../modules/tips');
    const creator = await makeCreator();
    const fan = await makeUser();
    await fund(fan, 5_000);
    const stream = await prisma.liveStream.create({ data: { creatorId: creator, title: 't', roomName: `r-${randomUUID()}`, status: 'LIVE' } as any });
    const app = await appWith(tips, '/tips', fan);
    const username = (await prisma.user.findUniqueOrThrow({ where: { id: fan } })).username;
    const send = (extra: object) => app.inject({ method: 'POST', url: '/tips', payload: { creatorId: creator, amountCents: 500, note: 'great show', idempotencyKey: randomUUID(), ...extra } });
    expect((await send({})).statusCode).toBe(200);
    expect((await send({ showName: true })).statusCode).toBe(200);
    const overlay = published.filter((p) => p.channel === `stream:${stream.id}`).map((p) => p.evt);
    const own = published.filter((p) => p.channel === creator).map((p) => p.evt);
    expect(overlay.map((e) => e.from)).toEqual([null, username]);
    expect(overlay[0].anonymous).toBe(true);
    expect(own.map((e) => e.from)).toEqual([username, username]);
    await app.close();
  });
});

describe("srv-money-modules#1: a creator's own delete keeps a PPV post for its buyers", () => {
  it('buyers keep it; non-buyers and a moderation takedown do not', async () => {
    const creator = await makeCreator();
    const buyer = await makeUser();
    const other = await makeUser();
    await fund(buyer, 10_000);
    const p = await prisma.post.create({ data: { creatorId: creator, text: 'ppv body', visibility: 'PPV', priceCents: 500 } });
    const { unlockPost, posts } = await import('../modules/posts');
    await unlockPost(buyer, p);

    const creatorApp = await appWith(posts, '/posts', creator);
    expect((await creatorApp.inject({ method: 'DELETE', url: `/posts/${p.id}` })).statusCode).toBe(200);
    const row = await prisma.post.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ removed: true, removedByCreator: true });
    expect(await canViewPost(buyer, row)).toBe(true);
    expect(await canViewPost(other, row)).toBe(false);
    expect(await canViewPost(null, row)).toBe(false);

    // Listed for the buyer (unlocked), for nobody else; no new unlocks.
    const buyerApp = await appWith(posts, '/posts', buyer);
    const list = (await buyerApp.inject({ method: 'GET', url: `/posts/creator/${creator}` })).json();
    expect(list.map((x: any) => [x.id, x.locked, x.text])).toEqual([[p.id, false, 'ppv body']]);
    const otherApp = await appWith(posts, '/posts', other);
    expect((await otherApp.inject({ method: 'GET', url: `/posts/creator/${creator}` })).json()).toEqual([]);
    await fund(other, 10_000);
    expect((await otherApp.inject({ method: 'POST', url: `/posts/${p.id}/unlock` })).statusCode).toBe(400);

    // A moderation takedown hides it from the buyer too, and a later creator
    // DELETE cannot turn the takedown back into a self-delete.
    const taken = await prisma.post.create({ data: { creatorId: creator, text: 'x', visibility: 'PPV', priceCents: 500 } });
    await unlockPost(buyer, taken);
    await prisma.post.update({ where: { id: taken.id }, data: { removed: true, removedByCreator: false } });
    await creatorApp.inject({ method: 'DELETE', url: `/posts/${taken.id}` });
    const t = await prisma.post.findUniqueOrThrow({ where: { id: taken.id } });
    expect(t.removedByCreator).toBe(false);
    expect(await canViewPost(buyer, t)).toBe(false);
    for (const a of [creatorApp, buyerApp, otherApp]) await a.close();
  });
});

describe('srv-money-modules#2: referral history is one row per ended UTC day per side', () => {
  it('sums a day, hides today, never returns a refId or charge detail', async () => {
    const referrer = await makeUser();
    const fan = await makeUser({ referredById: referrer });
    const creator = await makeCreator();
    await fund(fan, 10_000);
    for (let i = 0; i < 3; i++) {
      await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'DM_SEND', refId: `dm:${fan}:${randomUUID()}` }));
    }
    const yesterday = new Date(Date.now() - 864e5);
    // Round 18: cuts are held as PendingReferral rows and credited once their
    // UTC day has ended (core/referrals.ts). Two are moved to yesterday and
    // settled; today's stays pending and is nowhere in the referrer's view.
    const ids = (await prisma.pendingReferral.findMany({ where: { referrerId: referrer }, select: { id: true } })).map((r) => r.id);
    expect(ids.length).toBe(3);
    expect(await prisma.ledgerEntry.count({ where: { userId: referrer, type: 'REFERRAL' } })).toBe(0);
    await prisma.pendingReferral.updateMany({ where: { id: { in: ids.slice(0, 2) } }, data: { createdAt: yesterday } });
    await settleReferrals({ referrerIds: [referrer] });
    expect(await prisma.pendingReferral.count({ where: { referrerId: referrer, settledAt: null } })).toBe(1);

    const { wallet } = await import('../modules/wallet');
    const app = await appWith(wallet, '/wallet', referrer);
    const refs = (await app.inject({ method: 'GET', url: '/wallet/history' })).json().filter((r: any) => r.type === 'REFERRAL');
    expect(refs.length).toBe(1);
    const dayStart = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate()));
    expect(refs[0]).toMatchObject({ refId: null, meta: { for: 'fan' }, amountCents: 2 * 50 });
    expect(new Date(refs[0].createdAt).getTime()).toBe(dayStart.getTime());
    await app.close();

    const { auth } = await import('../modules/auth');
    const a2 = await appWith(auth, '/auth', referrer);
    const ref = await a2.inject({ method: 'GET', url: '/auth/referral' });
    expect(ref.json().earningsCents).toBe(100);
    await a2.close();
  });
});

describe('srv-workers-infra#0: unpriceable deposits never starve the rest', () => {
  it('only priced assets are read, past any backlog', async () => {
    const chainId = 800_000 + Math.floor(Math.random() * 90_000);
    const u = await makeUser();
    const base = { userId: u, chainId, rawAmount: '1', usdCents: 0n, priceUsed: 0, pricePending: true };
    const old = new Date(Date.now() - 3600_000);
    await prisma.deposit.createMany({ data: Array.from({ length: 150 }, (_, i) => ({ ...base, txHash: `0x${randomUUID()}`, logIndex: i, asset: 'ETH' as const, createdAt: old })) });
    const tok = await prisma.deposit.create({ data: { ...base, txHash: `0x${randomUUID()}`, logIndex: 0, asset: 'ONLYONE' } });
    const seen: string[] = [];
    await forEachPricedPending(chainId, ['ONLYONE'], async (d) => { seen.push(d.id); });
    expect(seen).toEqual([tok.id]);
    // With both priced, every row is visited once, in pages, up to the cap.
    const all: string[] = [];
    expect(await forEachPricedPending(chainId, ['ETH', 'ONLYONE'], async (d) => { all.push(d.id); }, { pageSize: 40, maxPerPass: 1000 })).toBe(151);
    expect(new Set(all).size).toBe(151);
    expect(await forEachPricedPending(chainId, ['ETH'], async () => {}, { pageSize: 40, maxPerPass: 100 })).toBe(100);
    expect(await forEachPricedPending(chainId, [], async () => {})).toBe(0);
  });
});

describe('srv-workers-infra#1: no ETH/$ONLYONE sweep while a deposit of it is price-pending', () => {
  it('a credited deposit alone is a candidate; one pending deposit blocks the address', async () => {
    for (const asset of ['ETH', 'ONLYONE'] as const) {
      const u = await makeUser();
      const chainId = 700_000 + Math.floor(Math.random() * 90_000);
      const idx = Math.floor(Math.random() * 1_000_000);
      await prisma.depositAddress.create({ data: { userId: u, chainId, address: `0x${randomUUID().replace(/-/g, '').padEnd(40, '0')}`, derivationIndex: idx } });
      const base = { userId: u, chainId, logIndex: 0, rawAmount: '1', asset };
      await prisma.deposit.create({ data: { ...base, txHash: `0x${randomUUID()}`, usdCents: 2500n, priceUsed: 2500 } });
      expect((await ethSweepCandidates(chainId, asset)).map((r) => r.derivationIndex)).toEqual([idx]);
      expect(await depositPricePendingFor(chainId, idx, asset)).toBe(false);
      await prisma.deposit.create({ data: { ...base, txHash: `0x${randomUUID()}`, usdCents: 0n, priceUsed: 0, pricePending: true } });
      expect(await ethSweepCandidates(chainId, asset)).toEqual([]);
      expect(await depositPricePendingFor(chainId, idx, asset)).toBe(true);
    }
  });
});
