import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto, { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, creditDeposit, PLATFORM_ID } from './ledger';
import { fileReport, messageAndBroadcastSiblings, broadcastTakenDown, blankBroadcast } from './reports';
import { applyUserStatus } from './moderation';
import { unlockMessage } from '../modules/messages';
import { publicImageUrl, publicImageUrls, withProfileImageUrls, assertOwnPublicImages, assertNotPublicImages } from './public-images';

// Regression tests for the round-6 server fixes: removing a reported mass-DM
// copy removes every copy, admins can see what was reported, a site-driven
// status change never overrides an admin's newer one, frozen creators are
// listable, an unlimited listing that has sold cannot become one-of-a-kind,
// an ended auction cannot be cancelled by its seller, and public images are
// stored as own-media keys and signed on the way out.

process.env.BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'test-bridge-secret-' + randomUUID();
const { syncSiteStanding, resolveBridgedUser, liftLapsedSiteSuspensions } = await import('../lib/bridge');

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
const media = (ownerId: string, status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'REJECTED', extra: Record<string, unknown> = {}) =>
  prisma.media.create({ data: { ownerId, key: `raw/${ownerId}/${randomUUID()}`, mime: 'image/jpeg', status, ...extra } });
async function convMessage(sender: string, other: string, data: Record<string, unknown>) {
  const [aId, bId] = sender < other ? [sender, other] : [other, sender];
  const conv = await prisma.conversation.upsert({ where: { aId_bId: { aId, bId } }, create: { aId, bId }, update: {} });
  return prisma.message.create({ data: { conversationId: conv.id, senderId: sender, ...data } as any });
}
const creatorClaims = (uid: string, creatorStatus: string, standingAt?: number) => ({
  typ: 'bridge', uid, email: `${uid}@site.test`, username: `s_${uid.slice(0, 8)}`, role: 'CREATOR', creatorStatus,
  jti: randomUUID(), exp: Date.now() + 60_000, ...(standingAt !== undefined ? { standingAt } : {}),
}) as any;

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

describe('removing a reported mass-DM copy', () => {
  it('blanks every copy of the broadcast, so none stays readable or on sale', async () => {
    const creator = await makeCreator();
    const [fanA, fanB, bystander] = [await makeUser(), await makeUser(), await makeUser()];
    const broadcastId = 'bc-' + randomUUID();
    const a = await convMessage(creator, fanA, { text: "someone's private details", priceCents: 500, broadcastId });
    const b = await convMessage(creator, fanB, { text: "someone's private details", priceCents: 500, broadcastId });
    // A different broadcast from the same creator is not touched.
    const other = await convMessage(creator, bystander, { text: 'unrelated drop', priceCents: 500, broadcastId: 'bc-' + randomUUID() });
    expect((await messageAndBroadcastSiblings(a.id)).sort()).toEqual([a.id, b.id].sort());

    const rep = await fileReport(fanA, 'message', a.id, 'this is me, I never agreed');
    const app = await adminApp();
    const res = await app.inject({ method: 'POST', url: `/admin/reports/${rep.id}/resolve`, payload: { action: 'remove_content' } });
    expect(res.statusCode).toBe(200);
    await app.close();

    for (const id of [a.id, b.id]) {
      const m = await prisma.message.findUniqueOrThrow({ where: { id } });
      expect([m.text, m.priceCents]).toEqual(['', 0]);
    }
    expect((await prisma.message.findUniqueOrThrow({ where: { id: other.id } })).text).toBe('unrelated drop');

    // The other subscriber can no longer buy it (and is not charged).
    await deposit(fanB, 10_000);
    const before = (await prisma.account.findUniqueOrThrow({ where: { userId: fanB } })).balanceCents;
    const bNow = await prisma.message.findUniqueOrThrow({ where: { id: b.id } });
    await expect(unlockMessage(fanB, bNow)).rejects.toBeTruthy();
    expect((await prisma.account.findUniqueOrThrow({ where: { userId: fanB } })).balanceCents).toBe(before);
  });
});

describe('admins can see what was reported', () => {
  it('returns the reported message (with its broadcast copy count), post, listing and user, and logs the view', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const broadcastId = 'bc-' + randomUUID();
    const m = await convMessage(creator, fan, { text: 'paywalled words', priceCents: 700, broadcastId });
    await convMessage(creator, await makeUser(), { text: 'paywalled words', priceCents: 700, broadcastId });
    await media(creator, 'READY', { messageId: m.id });
    const p = await prisma.post.create({ data: { creatorId: creator, text: 'subscribers only', visibility: 'SUBSCRIBERS' } });
    const l = await prisma.listing.create({ data: { creatorId: creator, title: 'set', priceCents: 1000, unlimited: true } });

    const app = await adminApp();
    const view = async (type: 'message' | 'post' | 'listing' | 'user', id: string) => {
      const rep = await fileReport(fan, type, id, 'bad');
      const res = await app.inject({ method: 'GET', url: `/admin/reports/${rep.id}/target` });
      expect(res.statusCode).toBe(200);
      return res.json();
    };
    const mv = await view('message', m.id);
    expect(mv.target).toMatchObject({ text: 'paywalled words', priceCents: 700, broadcastId, broadcastCopies: 2 });
    expect(mv.target.sender.id).toBe(creator);
    expect(mv.target.media).toHaveLength(1);
    expect(mv.target.media[0]).toMatchObject({ status: 'READY', url: null });   // no CDN configured in tests: no URL, no 500
    expect((await view('post', p.id)).target).toMatchObject({ text: 'subscribers only', visibility: 'SUBSCRIBERS' });
    expect((await view('listing', l.id)).target).toMatchObject({ title: 'set', priceCents: 1000 });
    expect((await view('user', creator)).target).toMatchObject({ id: creator, role: 'CREATOR' });
    expect((await app.inject({ method: 'GET', url: `/admin/reports/${randomUUID()}/target` })).statusCode).toBe(404);
    await app.close();
  });
});

describe('a site-driven status change never overrides a newer admin decision', () => {
  it('applyUserStatus(bySite) lifts only a site suspension, suspends only an ACTIVE row', async () => {
    const banned = await makeUser({ status: 'BANNED', statusBySite: false });
    expect(await applyUserStatus(banned, 'ACTIVE', { bySite: true })).toBe(false);
    expect(await applyUserStatus(banned, 'SUSPENDED', { bySite: true })).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: banned } })).status).toBe('BANNED');

    const adminSuspended = await makeUser({ status: 'SUSPENDED', statusBySite: false });
    expect(await applyUserStatus(adminSuspended, 'ACTIVE', { bySite: true })).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: adminSuspended } })).status).toBe('SUSPENDED');

    const siteSuspended = await makeUser({ status: 'SUSPENDED', statusBySite: true });
    expect(await applyUserStatus(siteSuspended, 'ACTIVE', { bySite: true })).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: siteSuspended } })).status).toBe('ACTIVE');

    // An admin's decision always applies.
    expect(await applyUserStatus(banned, 'ACTIVE')).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: banned } })).status).toBe('ACTIVE');
  });

  it('a stale site message (read before an admin ban) neither lifts nor downgrades the ban', async () => {
    const uid = randomUUID();
    const r = await resolveBridgedUser(creatorClaims(uid, 'active'));
    if (!r.ok) throw new Error('setup');
    const stale = await prisma.user.update({ where: { id: r.user.id }, data: { status: 'SUSPENDED', statusBySite: true } });
    await applyUserStatus(r.user.id, 'BANNED', { rooms: { deleteRoom: async () => undefined } });   // the admin, meanwhile
    expect(await syncSiteStanding(stale, 'active', { fan: false })).toBe('unchanged');
    expect(await syncSiteStanding({ ...stale, status: 'ACTIVE' }, 'suspended', { fan: false })).toBe('unchanged');
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect([u.status, u.statusBySite]).toEqual(['BANNED', false]);
  });

  it('the lapse sweep does not reactivate a creator an admin banned after the sweep read its rows', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    await syncSiteStanding(r.user, 'suspended', { standingAt: t0 + 1_000, fan: false, suspendedUntil: Date.now() - 1_000 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } })).status).toBe('SUSPENDED');

    // The admin's ban lands between the sweep's read and its turn at this row.
    const { prisma: appPrisma } = await import('../lib/prisma');
    const real = appPrisma.user.findMany.bind(appPrisma.user);
    const spy = vi.spyOn(appPrisma.user, 'findMany').mockImplementationOnce((async (args: any) => {
      const rows = await real(args);
      await applyUserStatus(r.user.id, 'BANNED', { rooms: { deleteRoom: async () => undefined } });
      return rows;
    }) as any);
    try {
      await liftLapsedSiteSuspensions();
    } finally {
      spy.mockRestore();
    }
    const u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.status).toBe('BANNED');
    expect(u.statusBySite).toBe(false);
  });
});

describe('frozen creators are listable', () => {
  it('GET /admin/creators/frozen lists a reactivated-but-frozen creator with their withdrawable balance', async () => {
    const creator = await makeCreator();
    await applyUserStatus(creator, 'SUSPENDED', { rooms: { deleteRoom: async () => undefined } });
    await applyUserStatus(creator, 'ACTIVE');   // reactivation never unfreezes
    await prisma.account.upsert({ where: { userId: creator }, create: { userId: creator, balanceCents: 5000n, withdrawableCents: 3000n }, update: { balanceCents: 5000n, withdrawableCents: 3000n } });
    const notFrozen = await makeCreator();
    const app = await adminApp();
    const res = await app.inject({ method: 'GET', url: '/admin/creators/frozen?limit=200' });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as any[];
    const row = rows.find((x) => x.userId === creator);
    expect(row).toMatchObject({ activeButFrozen: true, balanceCents: 5000, withdrawableCents: 3000 });
    expect(row.user.status).toBe('ACTIVE');
    expect(rows.some((x) => x.userId === notFrozen)).toBe(false);
    await app.close();
  });
});

describe('marketplace listing edits', () => {
  let as = '';
  it('an unlimited digital listing that has sold cannot be switched to one-of-a-kind', async () => {
    const creator = await makeCreator();
    as = creator;
    const buyer = await makeUser();
    const l = await prisma.listing.create({ data: { creatorId: creator, title: 'photo set', priceCents: 500, unlimited: true, kind: 'DIGITAL' } });
    await media(creator, 'READY', { listingId: l.id });
    const unsold = await prisma.listing.create({ data: { creatorId: creator, title: 'other set', priceCents: 500, unlimited: true, kind: 'DIGITAL' } });
    await media(creator, 'READY', { listingId: unsold.id });
    await prisma.listingOrder.create({ data: { listingId: l.id, buyerId: buyer, priceCents: 500, platformFeeCents: 50, listingFeeCents: 25 } });

    const app = await marketplaceApp(() => as);
    const res = await app.inject({ method: 'PATCH', url: `/marketplace/listings/${l.id}`, payload: { unlimited: false, priceCents: 50_000 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('listing_has_orders');   // (the real app's error handler maps message -> error)
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: l.id } }))).toMatchObject({ unlimited: true, priceCents: 500 });
    // Without orders it is still allowed.
    expect((await app.inject({ method: 'PATCH', url: `/marketplace/listings/${unsold.id}`, payload: { unlimited: false } })).statusCode).toBe(200);
    await app.close();
  });

  it('an auction past its deadline cannot be removed by its seller; a live one can', async () => {
    const creator = await makeCreator();
    as = creator;
    const bidder = await makeUser();
    await deposit(bidder, 10_000);
    const ended = await prisma.listing.create({ data: {
      creatorId: creator, title: 'ended', priceCents: 500, saleType: 'AUCTION', auctionEndsAt: new Date(Date.now() - 20_000),
      currentBidCents: 500, currentBidderId: bidder, currentHoldCents: 500,
    } });
    const live = await prisma.listing.create({ data: { creatorId: creator, title: 'live', priceCents: 500, saleType: 'AUCTION', auctionEndsAt: new Date(Date.now() + 3_600_000) } });
    const app = await marketplaceApp(() => as);
    const res = await app.inject({ method: 'PATCH', url: `/marketplace/listings/${ended.id}`, payload: { status: 'REMOVED' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('auction_ended');
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: ended.id } })).status).toBe('ACTIVE');
    expect((await app.inject({ method: 'PATCH', url: `/marketplace/listings/${live.id}`, payload: { status: 'REMOVED' } })).statusCode).toBe(200);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('REMOVED');
    await app.close();
  });
});

describe('a taken-down mass DM stays down while its job is still delivering', () => {
  it('the actioned report is a durable marker: later copies are blanked and the drop cannot be re-queued', async () => {
    const creator = await makeCreator();
    const [fanA, fanB] = [await makeUser(), await makeUser()];
    const broadcastId = 'bc-' + randomUUID();
    const a = await convMessage(creator, fanA, { text: 'removed content', priceCents: 500, broadcastId });
    expect(await broadcastTakenDown(creator, broadcastId)).toBe(false);
    // A dismissed report is not a takedown.
    const dismissed = await fileReport(fanA, 'message', a.id, 'meh');
    await prisma.report.update({ where: { id: dismissed.id }, data: { status: 'DISMISSED' } });
    expect(await broadcastTakenDown(creator, broadcastId)).toBe(false);

    const rep = await fileReport(fanA, 'message', a.id, 'this is me, I never agreed');
    const app = await adminApp();
    expect((await app.inject({ method: 'POST', url: `/admin/reports/${rep.id}/resolve`, payload: { action: 'remove_content' } })).statusCode).toBe(200);
    await app.close();
    expect(await broadcastTakenDown(creator, broadcastId)).toBe(true);

    // The worker, still running from its job data, writes fan B's copy AFTER
    // the resolve blanked the copies that existed -- with media, READY.
    const b = await convMessage(creator, fanB, { text: 'removed content', priceCents: 500, broadcastId });
    const bm = await media(creator, 'READY', { key: `raw/${creator}/${randomUUID()}#${randomUUID()}`, messageId: b.id });
    // What the worker does after that commit: sees the marker, blanks all.
    await blankBroadcast(creator, broadcastId);
    const bNow = await prisma.message.findUniqueOrThrow({ where: { id: b.id } });
    expect([bNow.text, bNow.priceCents]).toEqual(['', 0]);
    expect((await prisma.media.findUniqueOrThrow({ where: { id: bm.id } })).status).toBe('REJECTED');
    // Another creator's broadcast under the same id string is not affected.
    expect(await broadcastTakenDown(await makeCreator(), broadcastId)).toBe(false);
  });
});

describe('public images and paid content never share an upload', () => {
  it('a new listing\'s preview photo cannot be one of its own product media', async () => {
    const creator = await makeCreator();
    const product = await media(creator, 'READY');
    await expect(assertOwnPublicImages(prisma as any, creator, [product.key], [product.id])).rejects.toMatchObject({ message: 'bad_images', statusCode: 400 });
    const app = await marketplaceApp(() => creator);
    const res = await app.inject({ method: 'POST', url: '/marketplace/listings', payload: { title: 't', priceCents: 500, unlimited: true, mediaIds: [product.id], images: [product.key] } });
    expect(res.statusCode).toBe(400);
    expect(await prisma.listing.count({ where: { creatorId: creator } })).toBe(0);
    await app.close();
  });

  it('a mass DM\'s source cannot become a public image', async () => {
    const creator = await makeCreator();
    const src = await media(creator, 'READY');
    await media(creator, 'READY', { key: `${src.key}#${randomUUID()}`, sourceMediaId: src.id });
    await expect(assertOwnPublicImages(prisma as any, creator, [src.key])).rejects.toMatchObject({ message: 'bad_images' });
  });

  it('an avatar, banner or listing preview photo cannot be attached as paid content', async () => {
    const creator = await makeCreator();
    const [avatar, banner, preview, plain] = [await media(creator, 'READY'), await media(creator, 'READY'), await media(creator, 'READY'), await media(creator, 'READY')];
    await prisma.creatorProfile.update({ where: { userId: creator }, data: { avatarKey: avatar.key, bannerKey: banner.key } });
    await prisma.listing.create({ data: { creatorId: creator, title: 'x', priceCents: 500, images: [preview.key], status: 'REMOVED' } as any });
    for (const m of [avatar, banner, preview]) {
      await expect(assertNotPublicImages(prisma as any, [m.id])).rejects.toMatchObject({ message: 'media_is_public_image', statusCode: 400 });
    }
    await expect(assertNotPublicImages(prisma as any, [plain.id])).resolves.toBeUndefined();
    // Through a route: a new listing whose product is the creator's avatar.
    const app = await marketplaceApp(() => creator);
    const res = await app.inject({ method: 'POST', url: '/marketplace/listings', payload: { title: 't', priceCents: 500, unlimited: true, mediaIds: [avatar.id] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message ?? res.json().error).toBe('media_is_public_image');
    await app.close();
  });
});

describe('public images are own-media keys, signed at read time', () => {
  afterEach(() => { delete process.env.BUNNY_CDN_HOST; delete process.env.BUNNY_TOKEN_KEY; });
  it('signs a stored key per response, and drops anything that is not a key', () => {
    const key = `raw/${randomUUID()}/AbC_12-x`;
    expect(publicImageUrl(key)).toBeNull();   // no CDN configured: nothing to point at, no throw
    process.env.BUNNY_CDN_HOST = 'cdn.example.com';
    process.env.BUNNY_TOKEN_KEY = 'k-' + crypto.randomBytes(8).toString('hex');
    const url = publicImageUrl(key)!;
    expect(url.startsWith(`https://cdn.example.com/${key}?token=`)).toBe(true);
    expect(url).toMatch(/&expires=\d+$/);
    expect(publicImageUrls([key, 'https://cdn.example.com/media/x/preview.jpg', 'javascript:alert(1)'])).toHaveLength(1);
    const p = withProfileImageUrls({ avatarKey: key, bannerKey: null });
    expect(p.avatarUrl).toContain(`/${key}?token=`);
    expect(p.bannerUrl).toBeNull();
  });

  it('a listing only accepts the creator\'s own READY unattached image, and GET returns it signed', async () => {
    const creator = await makeCreator();
    const img = await media(creator, 'READY');
    const product = await media(creator, 'READY');
    const other = await media(await makeCreator(), 'READY');
    const app = await marketplaceApp(() => creator);
    const bad = await app.inject({ method: 'POST', url: '/marketplace/listings', payload: { title: 't', priceCents: 500, unlimited: true, mediaIds: [product.id], images: [other.key] } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/marketplace/listings', payload: { title: 't', priceCents: 500, unlimited: true, mediaIds: [product.id], images: [img.key] } });
    expect(ok.statusCode).toBe(200);
    const created = ok.json();
    expect(created.images).toEqual([img.key]);
    process.env.BUNNY_CDN_HOST = 'cdn.example.com';
    process.env.BUNNY_TOKEN_KEY = 'k-' + crypto.randomBytes(8).toString('hex');
    const got = await app.inject({ method: 'GET', url: `/marketplace/listings/${created.id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().images[0]).toMatch(new RegExp(`^https://cdn\\.example\\.com/${img.key}\\?token=`));
    await app.close();
  });
});

describe('workers signing-secret shape check', () => {
  const saved = { k: process.env.TREASURY_PRIVATE_KEY, m: process.env.DEPOSIT_MNEMONIC };
  afterEach(() => {
    if (saved.k === undefined) delete process.env.TREASURY_PRIVATE_KEY; else process.env.TREASURY_PRIVATE_KEY = saved.k;
    if (saved.m === undefined) delete process.env.DEPOSIT_MNEMONIC; else process.env.DEPOSIT_MNEMONIC = saved.m;
  });
  it("flags a value with an inline '# comment' (systemd keeps it), naming the variable and never the value", async () => {
    const { warnSecretShape } = await import('../lib/chain');
    const key = '0x' + 'ab'.repeat(32);
    process.env.TREASURY_PRIVATE_KEY = `${key}   # the wallet that pays out`;
    process.env.DEPOSIT_MNEMONIC = 'abandon '.repeat(11) + 'about       # derives every address';
    const logs: string[] = [];
    expect(warnSecretShape((m) => logs.push(m))).toBe(false);
    expect(logs.join()).toMatch(/TREASURY_PRIVATE_KEY/);
    expect(logs.join()).toMatch(/DEPOSIT_MNEMONIC/);
    expect(logs.join()).not.toContain(key);
    expect(logs.join()).not.toContain('abandon');
    process.env.TREASURY_PRIVATE_KEY = key;
    process.env.DEPOSIT_MNEMONIC = 'abandon '.repeat(11) + 'about';
    expect(warnSecretShape(() => {})).toBe(true);
  });
});
