import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto, { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { money, post, PLATFORM_ID } from './ledger';
import { fileReport, listReports } from './reports';
import { applyUserStatus } from './moderation';
import { placeBid, closeAuction } from './auctions';
import { unlockPost } from '../modules/posts';

// Round-12 server regression tests: a BAN stamp alone is not "content
// down" in the report queue; reversing a ban (admin or site) gives
// subscribers back their paid period; a site reinstatement lifts only the
// site's own ban, and says so distinctly when a server admin's ban blocks
// it; a banned bidder loses their lead and can never win at close; a PPV
// post deleted mid-request is not sold; and the workers refuse a
// TREASURY_ADDRESS that is not their signing key's.

process.env.BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'test-bridge-secret-' + randomUUID();
const { syncSiteStanding, resolveBridgedUser } = await import('../lib/bridge');
const { treasuryAddressMismatch } = await import('../lib/chain');

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
const deposit = (userId: string, cents: number) =>
  money(prisma, (tx) => post(tx, userId, cents, 'DEPOSIT', `t-${randomUUID()}`, {}, 'CREDITS'));
const balance = async (userId: string) => (await prisma.account.findUnique({ where: { userId } }))?.balanceCents ?? 0n;
const creatorClaims = (uid: string, creatorStatus: string, standingAt?: number) => ({
  typ: 'bridge', uid, email: `${uid}@site.test`, username: `s_${uid.slice(0, 8)}`, role: 'CREATOR', creatorStatus,
  jti: randomUUID(), exp: Date.now() + 60_000, ...(standingAt !== undefined ? { standingAt } : {}),
}) as any;

async function findReport(id: string, contentRemoved?: boolean) {
  for (let off = 0; ; off += 500) {
    const page = await listReports({ status: 'OPEN', targetType: 'listing', contentRemoved, limit: 500, offset: off });
    const hit = page.reports.find((x) => x.id === id);
    if (hit || off + 500 >= page.total) return hit;
  }
}

async function subscribe(creatorId: string, periodEnd: Date) {
  const fan = await makeUser();
  const tier = await prisma.subscriptionTier.create({ data: { creatorId, name: 't', priceCents: 999 } });
  const sub = await prisma.subscription.create({ data: { fanId: fan, creatorId, tierId: tier.id, priceCents: 999, currentPeriodEnd: periodEnd } });
  return { fan, sub };
}

describe('srv-auth-core#0: a BAN stamp is not "content already down" while the seller is not banned', () => {
  it('a reversed ban leaves the report live; a report takedown and a standing ban still read as down', async () => {
    const creator = await makeCreator();
    const l = await prisma.listing.create({ data: { creatorId: creator, title: 'x', priceCents: 1000, kind: 'PHYSICAL' } });
    expect(await applyUserStatus(creator, 'BANNED', { rooms: noRooms })).toBe(true);
    const rep = await fileReport(await makeUser(), 'listing', l.id, 'r');
    // While the ban stands the listing is down for everyone.
    expect((await findReport(rep.id))?.contentRemoved).toBe(true);

    // Reversed, with no restoreListings: the BAN stamp stays, but past
    // buyers are served the listing again -- the report is on live content.
    expect(await applyUserStatus(creator, 'ACTIVE')).toBe(true);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: l.id } })).moderatedReason).toBe('BAN');
    expect((await findReport(rep.id))?.contentRemoved).toBe(false);
    expect(await findReport(rep.id, false)).toBeTruthy();
    expect(await findReport(rep.id, true)).toBeUndefined();

    // A REPORT takedown (and an unlabelled legacy stamp) is still down.
    const reported = await prisma.listing.create({ data: { creatorId: creator, title: 'y', priceCents: 1000, kind: 'PHYSICAL', status: 'REMOVED', moderatedAt: new Date(), moderatedReason: 'REPORT' } });
    const r2 = await fileReport(await makeUser(), 'listing', reported.id, 'r');
    expect((await findReport(r2.id))?.contentRemoved).toBe(true);
    const legacy = await prisma.listing.create({ data: { creatorId: creator, title: 'z', priceCents: 1000, kind: 'PHYSICAL', status: 'REMOVED', moderatedAt: new Date() } });
    const r3 = await fileReport(await makeUser(), 'listing', legacy.id, 'r');
    expect((await findReport(r3.id))?.contentRemoved).toBe(true);
  });
});

describe('srv-auth-core#1: reversing a ban restores paid-for subscriptions', () => {
  it('an admin reversal re-activates only in-period subscriptions, without auto-renew; a suspension lift touches nothing', async () => {
    const creator = await makeCreator();
    const live = await subscribe(creator, new Date(Date.now() + 20 * 864e5));
    const ended = await subscribe(creator, new Date(Date.now() - 864e5));
    expect(await applyUserStatus(creator, 'BANNED', { rooms: noRooms })).toBe(true);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: live.sub.id } })).status).toBe('CANCELLED');

    expect(await applyUserStatus(creator, 'ACTIVE')).toBe(true);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: live.sub.id } })).toMatchObject({ status: 'ACTIVE', autoRenew: false });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: ended.sub.id } })).status).toBe('CANCELLED');
    // Payouts stay frozen: lifting a ban is not lifting a freeze.
    expect((await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: creator } })).payoutsFrozen).toBe(true);

    // Round 13: a ban eased to a suspension first, then lifted, restores the
    // ban's CANCELLED rows too (only a ban ever writes CANCELLED).
    const other = await makeCreator();
    const s = await subscribe(other, new Date(Date.now() + 20 * 864e5));
    expect(await applyUserStatus(other, 'BANNED', { rooms: noRooms })).toBe(true);
    expect(await applyUserStatus(other, 'SUSPENDED', { rooms: noRooms })).toBe(true);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } })).status).toBe('CANCELLED');
    expect(await applyUserStatus(other, 'ACTIVE')).toBe(true);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } })).toMatchObject({ status: 'ACTIVE', autoRenew: false });

    // Re-activating an already ACTIVE account changes nothing.
    const third = await makeCreator();
    const t = await subscribe(third, new Date(Date.now() + 20 * 864e5));
    expect(await applyUserStatus(third, 'ACTIVE')).toBe(true);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: t.sub.id } })).toMatchObject({ status: 'ACTIVE' });
  });
});

describe('srv-auth-core#2: a site reinstatement lifts only the site\'s own ban', () => {
  it('a site ban is lifted by the site saying active (subscribers restored, listings stay down)', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    const id = r.user.id;
    const { sub } = await subscribe(id, new Date(Date.now() + 10 * 864e5));
    const listing = await prisma.listing.create({ data: { creatorId: id, title: 'x', priceCents: 500 } });
    const u0 = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(await syncSiteStanding(u0, 'banned', { standingAt: t0 + 1_000, fan: false })).toBe('banned');
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).statusBySite).toBe(true);

    const u1 = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(await syncSiteStanding(u1, 'active', { standingAt: t0 + 2_000, fan: false })).toBe('reactivated');
    const after = await prisma.user.findUniqueOrThrow({ where: { id }, include: { creator: true } });
    expect(after.status).toBe('ACTIVE');
    expect(after.creator?.payoutsFrozen).toBe(true);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ status: 'ACTIVE', autoRenew: false });
    expect(await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ status: 'REMOVED', moderatedReason: 'BAN' });
  });

  it('a site ban is not lifted while the site\'s OTHER standing still restricts the account', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    const id = r.user.id;
    await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'banned', { standingAt: t0 + 1_000, fan: false });
    await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'banned', { standingAt: t0 + 1_000, fan: true });
    expect(await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'active', { standingAt: t0 + 2_000, fan: false })).toBe('unchanged');
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe('BANNED');
  });

  it('an admin ban is never lifted by the site, and the answer is distinct (route: 409)', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    const id = r.user.id;
    await applyUserStatus(id, 'BANNED', { rooms: noRooms });
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(await syncSiteStanding(u, 'active', { standingAt: t0 + 1_000, fan: false })).toBe('ban_needs_server_admin');
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe('BANNED');
    // A stale read that still says ACTIVE (the admin banned after it) gets
    // the same answer, decided from the row as it is now.
    expect(await syncSiteStanding({ ...u, status: 'ACTIVE' }, 'active', { standingAt: t0 + 2_000, fan: false })).toBe('ban_needs_server_admin');

    // The route answers 409 for it, so the site's outbox keeps the row.
    const Fastify = (await import('fastify')).default;
    const { auth } = await import('../modules/auth');
    const app = Fastify();
    app.decorate('auth', async () => undefined);
    app.decorate('jwt', { sign: () => 'x' } as any);
    await app.register(auth, { prefix: '/auth' });
    const payload = Buffer.from(JSON.stringify({ typ: 'bridge_status', uid, creatorStatus: 'active', role: 'CREATOR', jti: randomUUID(), exp: Date.now() + 60_000, standingAt: Date.now() })).toString('base64url');
    const sig = crypto.createHmac('sha256', process.env.BRIDGE_SECRET!).update(payload).digest('base64url');
    const res = await app.inject({ method: 'POST', url: '/auth/bridge/status', payload: { token: `${payload}.${sig}` } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ applied: 'ban_needs_server_admin', error: 'ban_needs_server_admin' });
    await app.close();
  });

  it('a site ban over an admin suspension stays the admin\'s: a later site active never lifts it', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    const id = r.user.id;
    await applyUserStatus(id, 'SUSPENDED', { rooms: noRooms });
    expect(await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'banned', { standingAt: t0 + 1_000, fan: false })).toBe('banned');
    expect(await prisma.user.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'BANNED', statusBySite: false });
    expect(await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'active', { standingAt: t0 + 2_000, fan: false })).toBe('ban_needs_server_admin');
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe('BANNED');
    // The exchange-time lift (resolveBridgedUser) is refused the same way.
    const again = await resolveBridgedUser(creatorClaims(uid, 'active', t0 + 3_000));
    expect(again.ok).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe('BANNED');
  });

  it('a site ban over a SITE suspension is still the site\'s to lift', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    const id = r.user.id;
    expect(await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'suspended', { standingAt: t0 + 1_000, fan: false })).toBe('suspended');
    expect(await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'banned', { standingAt: t0 + 2_000, fan: false })).toBe('banned');
    expect(await prisma.user.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'BANNED', statusBySite: true });
    expect(await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'active', { standingAt: t0 + 3_000, fan: false })).toBe('reactivated');
  });

  it('a site active on an admin SUSPENSION gets its own distinct refusal (route: 409)', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    const id = r.user.id;
    await applyUserStatus(id, 'SUSPENDED', { rooms: noRooms });
    expect(await syncSiteStanding(await prisma.user.findUniqueOrThrow({ where: { id } }), 'active', { standingAt: t0 + 1_000, fan: false })).toBe('suspension_needs_server_admin');
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).status).toBe('SUSPENDED');

    const Fastify = (await import('fastify')).default;
    const { auth } = await import('../modules/auth');
    const app = Fastify();
    app.decorate('auth', async () => undefined);
    app.decorate('jwt', { sign: () => 'x' } as any);
    await app.register(auth, { prefix: '/auth' });
    const payload = Buffer.from(JSON.stringify({ typ: 'bridge_status', uid, creatorStatus: 'active', role: 'CREATOR', jti: randomUUID(), exp: Date.now() + 60_000, standingAt: Date.now() })).toString('base64url');
    const sig = crypto.createHmac('sha256', process.env.BRIDGE_SECRET!).update(payload).digest('base64url');
    const res = await app.inject({ method: 'POST', url: '/auth/bridge/status', payload: { token: `${payload}.${sig}` } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ applied: 'suspension_needs_server_admin', error: 'suspension_needs_server_admin' });
    await app.close();
  });
});

describe('srv-money-modules#0: a banned bidder never wins', () => {
  async function auction(creator: string, endsInMs = 3_600_000) {
    return prisma.listing.create({ data: { creatorId: creator, title: 'a', priceCents: 1000, kind: 'PHYSICAL', saleType: 'AUCTION', auctionEndsAt: new Date(Date.now() + endsInMs) } });
  }

  it('a ban releases the banned account\'s leading bids and leaves the auctions open', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 10_000);
    const a = await auction(creator);
    await money(prisma, (tx) => placeBid(tx, a.id, fan, 3_000));
    expect(await balance(fan)).toBe(7_000n);

    expect(await applyUserStatus(fan, 'BANNED', { rooms: noRooms })).toBe(true);
    expect(await balance(fan)).toBe(10_000n);
    expect(await prisma.listing.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: 'ACTIVE', currentBidderId: null, currentBidCents: null, currentHoldCents: null,
    });
    // Anyone else bids again from the starting price.
    const other = await makeUser();
    await deposit(other, 5_000);
    await money(prisma, (tx) => placeBid(tx, a.id, other, 1_000));
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: a.id } })).currentBidderId).toBe(other);
  });

  it('closeAuction releases a non-ACTIVE winner\'s hold and sells nothing', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 10_000);
    const a = await auction(creator);
    await money(prisma, (tx) => placeBid(tx, a.id, fan, 2_000));
    // Banned after the moderation sweep read its list (simulated: status
    // written directly), and the auction then ends.
    await prisma.user.update({ where: { id: fan }, data: { status: 'BANNED' } });
    await prisma.listing.update({ where: { id: a.id }, data: { auctionEndsAt: new Date(Date.now() - 1_000) } });
    const r = await money(prisma, (tx) => closeAuction(tx, a.id));
    expect(r.sold).toBe(false);
    expect(await balance(fan)).toBe(10_000n);
    expect(await balance(creator)).toBe(0n);
    expect(await prisma.listingOrder.count({ where: { listingId: a.id } })).toBe(0);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('REMOVED');

    // A SUSPENDED winner likewise (it could not open the order either).
    const fan2 = await makeUser();
    await deposit(fan2, 10_000);
    const b = await auction(creator);
    await money(prisma, (tx) => placeBid(tx, b.id, fan2, 2_000));
    await prisma.user.update({ where: { id: fan2 }, data: { status: 'SUSPENDED' } });
    await prisma.listing.update({ where: { id: b.id }, data: { auctionEndsAt: new Date(Date.now() - 1_000) } });
    expect((await money(prisma, (tx) => closeAuction(tx, b.id))).sold).toBe(false);
    expect(await balance(fan2)).toBe(10_000n);

    // An ACTIVE winner still wins (harmless neighbour).
    const fan3 = await makeUser();
    await deposit(fan3, 10_000);
    const c = await auction(creator);
    await money(prisma, (tx) => placeBid(tx, c.id, fan3, 2_000));
    await prisma.listing.update({ where: { id: c.id }, data: { auctionEndsAt: new Date(Date.now() - 1_000) } });
    expect((await money(prisma, (tx) => closeAuction(tx, c.id))).sold).toBe(true);
  });
});

describe('srv-money-modules#1: a PPV post removed before the charge is not sold', () => {
  it('removed between the route\'s read and unlockPost: no charge, no unlock', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 5_000);
    const p = await prisma.post.create({ data: { creatorId: creator, text: 'secret text', visibility: 'PPV', priceCents: 2_000 } });
    // The route read `p` (removed=false); the creator's DELETE commits now.
    await prisma.post.update({ where: { id: p.id }, data: { removed: true } });
    await expect(unlockPost(fan, p)).rejects.toMatchObject({ message: 'no_deliverable', statusCode: 409 });
    expect(await balance(fan)).toBe(5_000n);
    expect(await prisma.postUnlock.count({ where: { postId: p.id } })).toBe(0);

    // A post no longer PPV is refused the same way; a live one still sells.
    const turned = await prisma.post.create({ data: { creatorId: creator, text: 't', visibility: 'SUBSCRIBERS', priceCents: 2_000 } });
    await expect(unlockPost(fan, turned)).rejects.toMatchObject({ message: 'no_deliverable' });
    const ok = await prisma.post.create({ data: { creatorId: creator, text: 'real', visibility: 'PPV', priceCents: 1_000 } });
    expect(await unlockPost(fan, ok)).toMatchObject({ ok: true });
    expect(await balance(fan)).toBe(4_000n);
  });
});

describe('srv-workers-infra#2: TREASURY_ADDRESS must be the signing key\'s address', () => {
  const saved = { key: process.env.TREASURY_PRIVATE_KEY, addr: process.env.TREASURY_ADDRESS };
  afterEach(() => {
    if (saved.key === undefined) delete process.env.TREASURY_PRIVATE_KEY; else process.env.TREASURY_PRIVATE_KEY = saved.key;
    if (saved.addr === undefined) delete process.env.TREASURY_ADDRESS; else process.env.TREASURY_ADDRESS = saved.addr;
  });
  it('flags a stale TREASURY_ADDRESS, accepts a matching or unset one', () => {
    const key = (process.env.TREASURY_PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(process.env.TREASURY_PRIVATE_KEY))
      ? process.env.TREASURY_PRIVATE_KEY as `0x${string}` : generatePrivateKey();
    process.env.TREASURY_PRIVATE_KEY = key;
    const me = privateKeyToAccount(key).address;
    delete process.env.TREASURY_ADDRESS;
    expect(treasuryAddressMismatch()).toBeNull();
    process.env.TREASURY_ADDRESS = me.toLowerCase();
    expect(treasuryAddressMismatch()).toBeNull();
    process.env.TREASURY_ADDRESS = '0x' + '12'.repeat(20);
    expect(treasuryAddressMismatch()).toMatch(/not the address of TREASURY_PRIVATE_KEY/);
    process.env.TREASURY_ADDRESS = 'nonsense';
    expect(treasuryAddressMismatch()).toMatch(/not an address/);
    // No key in this process (the API): nothing to compare.
    delete process.env.TREASURY_PRIVATE_KEY;
    process.env.TREASURY_ADDRESS = '0x' + '12'.repeat(20);
    expect(treasuryAddressMismatch()).toBeNull();
  });
});
