import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

// Round-18 server regression tests: live viewer tokens publish nothing and
// carry an opaque per-stream identity; referral cuts reach the referrer only
// as one total per ended UTC day (balance, withdrawable, earnings); the admin
// report target says when a self-deleted PPV post is still served to buyers;
// a price-pending deposit that prices to dust still re-queues the address's
// sweep; a run of single-word tags is judged as a label.

vi.mock('../lib/redis', async (orig) => ({
  ...(await orig<typeof import('../lib/redis')>()),
  publish: async () => 0,
}));

process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'test-lk-key';
process.env.LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'test-lk-secret-' + randomUUID();

const { charge, money, post, PLATFORM_ID } = await import('./ledger');
const { settleReferrals, utcDayStart } = await import('./referrals');
const { viewerIdentity, resolveLiveIdentity } = await import('./live-identity');
const { checkViewerOnJoin, sweepLive } = await import('./live-sweep');
const { postStillServedToBuyers } = await import('./reports');
const { settleRepriced } = await import('../workers/reprice-scan');
const { assertCleanTags } = await import('../lib/text-screen');

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
async function makeCreator(extra: Record<string, unknown> = {}) {
  const userId = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED', ...extra });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'C' } });
  return userId;
}
const fund = (userId: string, cents: number) => money(prisma, (tx) => post(tx, userId, cents, 'ADJUSTMENT'));
const acct = async (userId: string) => {
  const a = await prisma.account.findUnique({ where: { userId } });
  return { balance: a?.balanceCents ?? 0n, withdrawable: a?.withdrawableCents ?? 0n };
};

async function appWith(plugin: any, prefix: string, as: string) {
  const Fastify = (await import('fastify')).default;
  const { serializeReply } = await import('../lib/json-reply');
  const app = Fastify();
  app.setReplySerializer(serializeReply);
  const hook = async (req: any) => { req.user = { id: as, role: 'CREATOR' }; };
  app.decorate('auth', hook);
  app.decorate('creatorOk', hook);
  app.decorate('role', () => hook);
  app.decorateRequest('jwtVerify', async function (this: any) { this.user = { id: as, role: 'CREATOR' }; } as any);
  await app.register(plugin, { prefix });
  return app;
}

const jwtPayload = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));

describe('srv-money-modules#1: live viewer tokens', () => {
  it('opaque identities are per stream, reversible only for their own stream, and unforgeable', () => {
    const [s1, s2, u] = [randomUUID(), randomUUID(), randomUUID()];
    const id = viewerIdentity(s1, u);
    expect(id.startsWith('v.')).toBe(true);
    expect(id).not.toContain(u);
    expect(viewerIdentity(s1, u)).toBe(id); // deterministic: a reconnect replaces the stale session
    expect(viewerIdentity(s2, u)).not.toBe(id); // not linkable across streams
    expect(resolveLiveIdentity(s1, id)).toBe(u);
    expect(resolveLiveIdentity(s2, id)).toBeNull();
    const raw = Buffer.from(id.slice(2), 'base64url');
    raw[raw.length - 1] ^= 1;
    expect(resolveLiveIdentity(s1, 'v.' + raw.toString('base64url'))).toBeNull();
    expect(resolveLiveIdentity(s1, 'v.')).toBeNull();
    expect(resolveLiveIdentity(s1, 'v.!!!')).toBeNull();
    // The creator's publish token still carries their plain id.
    expect(resolveLiveIdentity(s1, u)).toBe(u);
  });

  it('POST /live/:id/join and /minute hand viewers a token that cannot publish data and hides their user id', async () => {
    const { live } = await import('../modules/live');
    const creator = await makeCreator();
    const fan = await makeUser();
    await fund(fan, 1000);
    const s = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't', perMinuteCents: 100 } });
    const app = await appWith(live, '/live', fan);
    for (const url of [`/live/${s.id}/join`, `/live/${s.id}/minute`]) {
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode).toBe(200);
      const p = jwtPayload(res.json().token);
      expect(p.video.canPublishData).toBe(false);
      expect(p.video.canPublish).toBe(false);
      expect(p.sub).not.toBe(fan);
      expect(JSON.stringify(p)).not.toContain(fan);
      expect(resolveLiveIdentity(s.id, p.sub)).toBe(fan);
    }
    await app.close();
    // The creator's own viewer token (via /join) is opaque too and never
    // shares the publisher's identity, which LiveKit would treat as a
    // duplicate and disconnect the publisher.
    const capp = await appWith(live, '/live', creator);
    const own = jwtPayload((await capp.inject({ method: 'POST', url: `/live/${s.id}/join` })).json().token);
    expect(own.sub).not.toBe(creator);
    expect(own.video.canPublishData).toBe(false);
    await capp.close();
  });

  it('the join webhook and the sweep decode opaque identities and remove only the unentitled', async () => {
    const creator = await makeCreator();
    const payer = await makeUser();
    const lapsed = await makeUser();
    await fund(payer, 1000);
    const s = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't', perMinuteCents: 100 } });
    const { ensureMinutePaid } = await import('./live-billing');
    await ensureMinutePaid(payer, s);
    const removed: string[] = [];
    const rooms = {
      listRooms: async () => [{ name: s.roomName }],
      listParticipants: async () => [
        { identity: creator }, { identity: viewerIdentity(s.id, creator) },
        { identity: viewerIdentity(s.id, payer) }, { identity: viewerIdentity(s.id, lapsed) },
        { identity: viewerIdentity(randomUUID(), payer) }, // minted for another stream
      ],
      removeParticipant: async (_room: string, identity: string) => { removed.push(identity); },
    } as any;
    expect(await checkViewerOnJoin(rooms, s.roomName, viewerIdentity(s.id, payer))).toBe(false);
    expect(await checkViewerOnJoin(rooms, s.roomName, viewerIdentity(s.id, creator))).toBe(false);
    expect(await checkViewerOnJoin(rooms, s.roomName, viewerIdentity(s.id, lapsed))).toBe(true);
    removed.length = 0;
    await sweepLive(rooms);
    const mine = removed.filter((i) => [viewerIdentity(s.id, lapsed)].includes(i) || i.startsWith('v.'));
    expect(mine).toContain(viewerIdentity(s.id, lapsed));
    expect(removed).not.toContain(viewerIdentity(s.id, payer));
    expect(removed).not.toContain(creator);
    expect(removed).not.toContain(viewerIdentity(s.id, creator));
    expect(removed.some((i) => resolveLiveIdentity(s.id, i) === null && i.startsWith('v.'))).toBe(true);
  });
});

describe('srv-money-modules#0: referral cuts reach the referrer once per ended UTC day', () => {
  it('a charge moves nothing the referrer can see; settlement posts one dated total per side per day', async () => {
    const referrer = await makeUser();
    const fan = await makeUser({ referredById: referrer });
    const creatorReferrer = await makeUser();
    const creator = await makeCreator({ referredById: creatorReferrer });
    await fund(fan, 10_000);
    const before = await acct(referrer);
    const platformBefore = (await acct(PLATFORM_ID)).balance;

    const { wallet } = await import('../modules/wallet');
    const { payouts } = await import('../modules/payouts');
    const wApp = await appWith(wallet, '/wallet', referrer);
    const pApp = await appWith(payouts, '/payouts', creatorReferrer);
    const bal0 = (await wApp.inject({ method: 'GET', url: '/wallet/balance' })).json();
    const earn0 = (await pApp.inject({ method: 'GET', url: '/payouts/earnings' })).json();

    for (let i = 0; i < 3; i++) {
      await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'DM_SEND', refId: `dm:${fan}:${randomUUID()}` }));
    }
    // Nothing moved for either referrer, through any endpoint.
    expect(await acct(referrer)).toEqual(before);
    expect((await wApp.inject({ method: 'GET', url: '/wallet/balance' })).json()).toEqual(bal0);
    expect((await pApp.inject({ method: 'GET', url: '/payouts/earnings' })).json()).toEqual(earn0);
    expect(await prisma.ledgerEntry.count({ where: { userId: { in: [referrer, creatorReferrer] }, type: 'REFERRAL' } })).toBe(0);
    // The platform holds both sides' cuts (fee 300 in total, nothing burned from the hold).
    expect((await acct(PLATFORM_ID)).balance - platformBefore).toBe(300n);

    // Today has not ended: settling now does nothing.
    expect((await settleReferrals({ referrerIds: [referrer, creatorReferrer] })).groups).toBe(0);

    // Two of the fan-side cuts belong to yesterday.
    const yesterday = new Date(Date.now() - 864e5);
    const ids = (await prisma.pendingReferral.findMany({ where: { referrerId: referrer }, orderBy: { createdAt: 'asc' }, select: { id: true } })).map((r) => r.id);
    expect(ids.length).toBe(3);
    await prisma.pendingReferral.updateMany({ where: { id: { in: ids.slice(0, 2) } }, data: { createdAt: yesterday } });
    const r = await settleReferrals({ referrerIds: [referrer, creatorReferrer] });
    expect(r.groups).toBe(1);
    expect(await acct(referrer)).toEqual({ balance: before.balance + 100n, withdrawable: before.withdrawable + 100n });
    const rows = await prisma.ledgerEntry.findMany({ where: { userId: referrer, type: 'REFERRAL' } });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ amountCents: 100n, refId: null, meta: { for: 'fan' } });
    expect(rows[0].createdAt.getTime()).toBe(utcDayStart(yesterday).getTime());
    // Idempotent: a second run pays nothing twice.
    expect((await settleReferrals({ referrerIds: [referrer] })).groups).toBe(0);
    expect((await acct(referrer)).balance).toBe(before.balance + 100n);

    // Everything else settles once its day has ended.
    await settleReferrals({ now: new Date(Date.now() + 864e5), referrerIds: [referrer, creatorReferrer] });
    expect((await acct(referrer)).balance).toBe(before.balance + 150n);
    expect((await acct(creatorReferrer)).balance).toBe(150n);
    expect(await prisma.pendingReferral.count({ where: { referrerId: { in: [referrer, creatorReferrer] }, settledAt: null } })).toBe(0);
    // Conservation: what the platform held went out exactly.
    expect((await acct(PLATFORM_ID)).balance - platformBefore).toBe(0n);
    await wApp.close(); await pApp.close();
  });

  it('GET /payouts/earnings never counts a same-day REFERRAL row', async () => {
    const c = await makeCreator();
    await money(prisma, (tx) => post(tx, c, 77, 'REFERRAL', undefined, { for: 'fan' }, 'CREDITS', { earned: true }));
    const { payouts } = await import('../modules/payouts');
    const app = await appWith(payouts, '/payouts', c);
    expect((await app.inject({ method: 'GET', url: '/payouts/earnings' })).json().REFERRAL).toBeUndefined();
    await prisma.ledgerEntry.updateMany({ where: { userId: c, type: 'REFERRAL' }, data: { createdAt: new Date(Date.now() - 864e5) } });
    expect((await app.inject({ method: 'GET', url: '/payouts/earnings' })).json().REFERRAL).toBe(77);
    await app.close();
  });
});

describe('srv-auth-core#2: a self-deleted PPV post still served to buyers', () => {
  it('postStillServedToBuyers matches the queue predicate', async () => {
    const c = await makeCreator();
    const buyer = await makeUser();
    const mk = (data: Record<string, unknown>) => prisma.post.create({ data: { creatorId: c, text: 't', visibility: 'PPV', priceCents: 500, ...data } as any });
    const selfDeleted = await mk({ removed: true, removedByCreator: true });
    await prisma.postUnlock.create({ data: { fanId: buyer, postId: selfDeleted.id } });
    const noBuyers = await mk({ removed: true, removedByCreator: true });
    const takenDown = await mk({ removed: true, removedByCreator: false });
    await prisma.postUnlock.create({ data: { fanId: buyer, postId: takenDown.id } });
    const live = await mk({ removed: false });
    await prisma.postUnlock.create({ data: { fanId: buyer, postId: live.id } });
    expect(await postStillServedToBuyers(selfDeleted)).toBe(true);
    expect(await postStillServedToBuyers(noBuyers)).toBe(false);
    expect(await postStillServedToBuyers(takenDown)).toBe(false);
    expect(await postStillServedToBuyers(live)).toBe(false);

    const { listReports } = await import('./reports');
    const reporter = await makeUser();
    const rep = await prisma.report.create({ data: { reporterId: reporter, targetType: 'post', targetId: selfDeleted.id, reason: 'other' } });
    const { admin } = await import('../modules/admin');
    const app = await appWith(admin, '/admin', await makeUser({ role: 'ADMIN' }));
    const res = await app.inject({ method: 'GET', url: `/admin/reports/${rep.id}/target` });
    expect(res.statusCode).toBe(200);
    expect(res.json().target).toMatchObject({ removed: true, removedByCreator: true, stillServedToBuyers: true });
    await app.close();
    // The queue says the same thing: live content, not removed.
    let found = false;
    for (let offset = 0; !found; offset += 100) {
      const q = await listReports({ status: 'OPEN', targetType: 'post', contentRemoved: false, limit: 100, offset });
      found = q.reports.some((x: any) => x.id === rep.id);
      if (!q.reports.length) break;
    }
    expect(found).toBe(true);
  });
});

describe('srv-workers-infra#0: a price-pending deposit that prices to dust still re-queues the sweep', () => {
  it('settleRepriced reports claimed (sweep) separately from credited (notify)', async () => {
    const u = await makeUser();
    const chainId = 900_000 + Math.floor(Math.random() * 90_000);
    const base = { userId: u, chainId, rawAmount: '1', usdCents: 0n, priceUsed: 0, pricePending: true, asset: 'ETH' as const, hedgedAt: new Date() };
    const dust = await prisma.deposit.create({ data: { ...base, txHash: `0x${randomUUID()}`, logIndex: 0 } });
    let posted = 0;
    const r1 = await settleRepriced(dust, 0n, 3000, async () => { posted++; });
    expect(r1).toEqual({ claimed: true, credited: false });
    expect(posted).toBe(0);
    expect((await prisma.deposit.findUniqueOrThrow({ where: { id: dust.id } })).pricePending).toBe(false);
    expect(await settleRepriced(dust, 0n, 3000, async () => { posted++; })).toEqual({ claimed: false, credited: false });

    const real = await prisma.deposit.create({ data: { ...base, txHash: `0x${randomUUID()}`, logIndex: 1, rawAmount: '1000000000000000' } });
    const r2 = await settleRepriced(real, 300n, 3000, async (tx) => { posted++; await post(tx, u, 300, 'DEPOSIT', real.id); });
    expect(r2).toEqual({ claimed: true, credited: true });
    expect(posted).toBe(1);
    expect((await acct(u)).balance).toBe(300n);
  });
});

describe('srv-auth-core#0/#1: tags are labels, glued or split', () => {
  const cases: Array<[string[], boolean]> = [
    // split across single-word tags (#1)
    [['16', 'girl'], true], [['16', 'hot', 'girl'], true], [['sixteen', 'and', 'ready'], true],
    [['fifteen', 'years', 'old'], true], [['16', 'and', 'petite'], true],
    // controls
    [['1080p', 'girl'], false], [['y2k', 'girl'], false], [['16', 'girls'], false],
    [['fitness', 'yoga'], false], [['blonde', 'curvy', 'gym'], false],
    // glued (#0) -- screened by the site-screens copy of lib/prohibited-terms.js
    [['16girl'], true], [['16virgin'], true], [['16tightpussy'], true], [['16hotgirl'], true],
    [['1080p'], false], [['y2kgirl'], false], [['2016girl'], false],
  ];
  for (const [tags, flagged] of cases) {
    it(`${JSON.stringify(tags)} -> ${flagged ? 'refused' : 'clean'}`, () => {
      if (flagged) expect(() => assertCleanTags(tags)).toThrow('prohibited_terms');
      else expect(() => assertCleanTags(tags)).not.toThrow();
    });
  }
});
