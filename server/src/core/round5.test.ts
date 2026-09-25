import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto, { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, creditDeposit, PLATFORM_ID } from './ledger';
import { hasDeliverable } from './auctions';
import { unlockMessage, messageHasDeliverable, sendDirectMessage, broadcastIdFor } from '../modules/messages';
import { validListingImages, assertNotDistributed } from '../modules/marketplace';
import { lockPerk } from '../modules/stake';
import { chargeTip } from '../modules/tips';
import { initialCursorBlock, parseStartBlock } from '../workers/deposit-cursor';

// Regression tests for the round-5 server fixes: priced DMs need a
// deliverable, paid-DM idempotency survives a concurrent duplicate, broadcast
// ids are deterministic, digital listings need EVERY item READY and cannot
// sell already-broadcast media as one-of-a-kind, listing images are
// allowlisted, a re-lock renews at the confirmed price, a reused tip key is
// refused, lapsed site suspensions are lifted, and the deposit indexer never
// starts its first cursor at the head once addresses exist.

process.env.BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'test-bridge-secret-' + randomUUID();
const { verifyBridgeStatusToken, verifyBridgeToken, syncSiteStanding, resolveBridgedUser, liftLapsedSiteSuspensions } = await import('../lib/bridge');

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
const media = (ownerId: string, status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'REJECTED', extra: Record<string, unknown> = {}) =>
  prisma.media.create({ data: { ownerId, key: `raw/${ownerId}/${randomUUID()}`, mime: 'image/jpeg', status, ...extra } });
const sign = (payload: object) => {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${crypto.createHmac('sha256', process.env.BRIDGE_SECRET!).update(b64).digest('base64url')}`;
};
async function conversationMessage(creator: string, fan: string, data: { text: string; priceCents: number }) {
  const [aId, bId] = creator < fan ? [creator, fan] : [fan, creator];
  const conv = await prisma.conversation.upsert({ where: { aId_bId: { aId, bId } }, create: { aId, bId }, update: {} });
  return prisma.message.create({ data: { conversationId: conv.id, senderId: creator, ...data } });
}

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

describe('priced DMs must have something behind the paywall', () => {
  it('refuses to sell a message whose media was taken down, or that is empty, and charges nothing', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 10_000);
    const before = await balance(fan);

    const takenDown = await conversationMessage(creator, fan, { text: '', priceCents: 5000 });
    await media(creator, 'REJECTED', { messageId: takenDown.id });
    expect(await messageHasDeliverable(prisma as any, takenDown.id)).toBe(false);
    await expect(unlockMessage(fan, takenDown)).rejects.toMatchObject({ message: 'no_deliverable', statusCode: 409 });

    const partial = await conversationMessage(creator, fan, { text: 'caption', priceCents: 5000 });
    await media(creator, 'READY', { messageId: partial.id });
    await media(creator, 'REJECTED', { messageId: partial.id });
    await expect(unlockMessage(fan, partial)).rejects.toMatchObject({ message: 'no_deliverable' });

    const empty = await conversationMessage(creator, fan, { text: '  ', priceCents: 5000 });
    await expect(unlockMessage(fan, empty)).rejects.toMatchObject({ message: 'no_deliverable' });

    expect(await balance(fan)).toBe(before);
    expect(await prisma.messageUnlock.count({ where: { fanId: fan } })).toBe(0);
  });

  it('sells a priced message with READY media, or with text alone', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 10_000);
    const withMedia = await conversationMessage(creator, fan, { text: '', priceCents: 500 });
    await media(creator, 'READY', { messageId: withMedia.id });
    expect((await unlockMessage(fan, withMedia)).ok).toBe(true);
    const textOnly = await conversationMessage(creator, fan, { text: 'a secret', priceCents: 500 });
    expect((await unlockMessage(fan, textOnly)).ok).toBe(true);
  });
});

describe('paid-DM idempotency holds under a concurrent duplicate', () => {
  it('a double-tap with a balance for only one send is one charge and two successes, not a 402', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 150);
    const before = await balance(fan);   // enough for one 99 send, not two
    expect(before < 198n).toBe(true);
    const b = { text: 'hi', mediaIds: [] as string[], priceCents: 0, expectedPriceCents: 99, requestId: randomUUID() };
    const [x, y] = await Promise.all([sendDirectMessage(fan, creator, false, b), sendDirectMessage(fan, creator, false, b)]);
    expect(x.msg.id).toBe(y.msg.id);
    expect([x.already, y.already].sort()).toEqual([false, true]);
    expect(await balance(fan)).toBe(before - 99n);
    expect(await prisma.message.count({ where: { senderId: fan } })).toBe(1);
  });

  it('a double-tap with a photo attached replays instead of answering bad_media', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 10_000);
    const photo = await media(fan, 'READY');
    const b = { text: '', mediaIds: [photo.id], priceCents: 0, expectedPriceCents: 99, requestId: randomUUID() };
    const [x, y] = await Promise.all([sendDirectMessage(fan, creator, false, b), sendDirectMessage(fan, creator, false, b)]);
    expect(x.msg.id).toBe(y.msg.id);
    expect(await prisma.message.count({ where: { senderId: fan } })).toBe(1);
    expect((await prisma.media.findUniqueOrThrow({ where: { id: photo.id } })).messageId).toBe(x.msg.id);
    expect(await prisma.ledgerEntry.count({ where: { userId: fan, type: 'DM_SEND' } })).toBe(1);
  });
});

describe('mass-DM broadcast ids are derived from the request', () => {
  it('the same (creator, requestId) always maps to the same id; anything else does not', () => {
    const c = randomUUID(); const r = randomUUID();
    expect(broadcastIdFor(c, r)).toBe(broadcastIdFor(c, r));
    expect(broadcastIdFor(c, r)).not.toBe(broadcastIdFor(c, randomUUID()));
    expect(broadcastIdFor(c, r)).not.toBe(broadcastIdFor(randomUUID(), r));
    expect(broadcastIdFor(c, r)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('digital listings', () => {
  it('sell only when every attached item is READY', async () => {
    const creator = await makeCreator();
    const l = await prisma.listing.create({ data: { creatorId: creator, title: 'bundle', priceCents: 10_000, kind: 'DIGITAL' } });
    expect(await hasDeliverable(prisma as any, l)).toBe(false);          // nothing attached
    await media(creator, 'READY', { listingId: l.id });
    const pending = await media(creator, 'UPLOADING', { listingId: l.id });
    expect(await hasDeliverable(prisma as any, l)).toBe(false);          // one still uploading
    await prisma.media.update({ where: { id: pending.id }, data: { status: 'REJECTED' } });
    expect(await hasDeliverable(prisma as any, l)).toBe(false);          // one rejected
    await prisma.media.update({ where: { id: pending.id }, data: { status: 'READY' } });
    expect(await hasDeliverable(prisma as any, l)).toBe(true);
    expect(await hasDeliverable(prisma as any, { id: l.id, kind: 'PHYSICAL' })).toBe(true);
  });

  it('refuse already-broadcast media as a one-of-a-kind product', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const src = await media(creator, 'READY');
    const clean = await media(creator, 'READY');
    const m = await conversationMessage(creator, fan, { text: '', priceCents: 0 });
    await prisma.media.create({ data: { ownerId: creator, key: `${src.key}#${m.id}`, sourceMediaId: src.id, mime: 'image/jpeg', status: 'READY', messageId: m.id } });
    await expect(assertNotDistributed(prisma as any, [src.id])).rejects.toMatchObject({ message: 'media_already_distributed', statusCode: 400 });
    await expect(assertNotDistributed(prisma as any, [clean.id])).resolves.toBeUndefined();
  });
});

describe('listing preview images', () => {
  // Round 6 changed the contract: images are the storage keys of the
  // creator's own READY, unattached images, signed per response -- the old
  // allowlisted media/<creator>/ URLs were a blurred teaser the token-auth
  // CDN refused unsigned (core/public-images.ts, round6.test.ts).
  it("accept only the creator's own READY, unattached images -- never a URL", async () => {
    const creator = await makeCreator();
    const other = await makeCreator();
    await expect(validListingImages(prisma as any, [], creator)).resolves.toBeUndefined();
    const own = await media(creator, 'READY');
    await expect(validListingImages(prisma as any, [own.key], creator)).resolves.toBeUndefined();
    const theirs = await media(other, 'READY');
    const pending = await media(creator, 'PROCESSING');
    const video = await media(creator, 'READY', { mime: 'video/mp4' });
    const post = await prisma.post.create({ data: { creatorId: creator } });
    const onPost = await media(creator, 'READY', { postId: post.id });
    for (const bad of [
      'https://tracker.example/p.gif?u=1', 'javascript:alert(1)', 'data:image/png;base64,AAAA',
      `https://cdn.example.com/media/${creator}/m/preview.jpg`,
      theirs.key, pending.key, video.key, onPost.key, `raw/${creator}/${'a'.repeat(600)}`,
    ]) await expect(validListingImages(prisma as any, [bad], creator)).rejects.toMatchObject({ message: 'bad_images', statusCode: 400 });
    await expect(validListingImages(prisma as any, [own.key, own.key], creator)).rejects.toMatchObject({ message: 'bad_images' });
  });
});

describe('re-locking an active perk', () => {
  it('renews at the price the fan just confirmed, not the old one', async () => {
    const creator = await makeCreator({ stakePerkEnabled: true, stakePerkDescription: 'perk', stakeUsdCents: 5000 });
    const fan = await makeUser();
    await deposit(fan, 20_000);
    await lockPerk(fan, creator, 5000, '0');
    await prisma.tokenLock.updateMany({ where: { fanId: fan }, data: { autoRenew: false } });
    await prisma.creatorProfile.update({ where: { userId: creator }, data: { stakeUsdCents: 2000 } });
    const before = await balance(fan);
    const l = await lockPerk(fan, creator, 2000, '0');
    expect(l).toMatchObject({ autoRenew: true, usdCents: 2000 });
    expect(await balance(fan)).toBe(before);   // already paid for this period
  });
});

describe('tip idempotency keys', () => {
  it('a key reused for a different creator or amount is refused, a true retry replays', async () => {
    const a = await makeCreator();
    const b = await makeCreator();
    const fan = await makeUser();
    await deposit(fan, 100_000);
    const key = randomUUID();
    const first = await chargeTip(fan, { creatorId: a, amountCents: 2000, idempotencyKey: key, type: 'TIP' });
    expect(first.already).toBe(false);
    expect(await chargeTip(fan, { creatorId: a, amountCents: 2000, idempotencyKey: key, type: 'TIP' })).toMatchObject({ already: true, tipId: first.tipId });
    await expect(chargeTip(fan, { creatorId: b, amountCents: 5000, idempotencyKey: key, type: 'TIP' })).rejects.toMatchObject({ message: 'idempotency_key_reused', statusCode: 409 });
    await expect(chargeTip(fan, { creatorId: a, amountCents: 5000, idempotencyKey: key, type: 'TIP' })).rejects.toMatchObject({ message: 'idempotency_key_reused' });
    expect(await prisma.ledgerEntry.count({ where: { userId: fan, type: 'TIP' } })).toBe(1);
  });
});

describe('site suspensions lapse here too', () => {
  const creatorClaims = (uid: string, creatorStatus: 'active' | 'suspended', standingAt?: number) => ({
    typ: 'bridge' as const, uid, email: `${uid}@site.test`, username: `u_${uid.replace(/-/g, '').slice(0, 12)}`,
    role: 'CREATOR' as const, creatorStatus, jti: randomUUID(), exp: Date.now() + 60_000, ...(standingAt ? { standingAt } : {}),
  });
  const push = (uid: string, extra: Record<string, unknown>) =>
    verifyBridgeStatusToken(sign({ typ: 'bridge_status', uid, jti: randomUUID(), exp: Date.now() + 60_000, ...extra }));

  it('keeps suspendedUntil only on a suspended push with a sane value', () => {
    const uid = randomUUID();
    expect(push(uid, { creatorStatus: 'suspended', suspendedUntil: 1_900_000_000_000 })?.suspendedUntil).toBe(1_900_000_000_000);
    expect(push(uid, { creatorStatus: 'banned', suspendedUntil: 1_900_000_000_000 })?.suspendedUntil).toBeUndefined();
    expect(push(uid, { creatorStatus: 'suspended', suspendedUntil: 'soon' })?.suspendedUntil).toBeUndefined();
    expect(push(uid, { creatorStatus: 'suspended', suspendedUntil: 'soon' })?.creatorStatus).toBe('suspended');
    const exch = verifyBridgeToken(sign({ ...creatorClaims(uid, 'suspended'), suspendedUntil: 1_900_000_000_000 }));
    expect(exch?.suspendedUntil).toBe(1_900_000_000_000);
  });

  it("lifts a lapsed site suspension of a creator, and a delayed copy of it can't reinstate it", async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    const until = Date.now() - 1_000;   // already lapsed
    expect(await syncSiteStanding(r.user, 'suspended', { standingAt: t0 + 1_000, fan: false, suspendedUntil: until })).toBe('suspended');
    let u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.siteSuspendedUntil?.getTime()).toBe(until);
    expect(u.status).toBe('SUSPENDED');

    await liftLapsedSiteSuspensions();
    u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.status).toBe('ACTIVE');
    expect(u.siteCreatorStatus).toBe('active');
    expect(u.siteSuspendedUntil).toBeNull();
    // The same suspension delivered late is older than the lapse: stale.
    expect(await syncSiteStanding(u, 'suspended', { standingAt: t0 + 1_000, fan: false, suspendedUntil: until })).toBe('stale');
  });

  it('lifts a lapsed fan (account) suspension, but not while the other dimension restricts', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    await syncSiteStanding(r.user, 'suspended', { standingAt: t0 + 1_000, fan: true, suspendedUntil: Date.now() - 1_000 });
    let u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    // The creator ladder ALSO suspends, with no end yet.
    await syncSiteStanding(u, 'suspended', { standingAt: t0 + 2_000, fan: false });
    await liftLapsedSiteSuspensions();
    u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.siteAccountStatus).toBe('active');   // that dimension lapsed...
    expect(u.status).toBe('SUSPENDED');           // ...but the creator one still holds
  });

  it('a suspended login/push with no lapse time keeps the recorded one, and it still lifts', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    const until = Date.now() - 1_000;
    await syncSiteStanding(r.user, 'suspended', { standingAt: t0 + 1_000, fan: false, suspendedUntil: until });
    let u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    // The suspended creator logs in: the exchange says 'suspended', stamped now, no until.
    expect(await syncSiteStanding(u, 'suspended', { standingAt: t0 + 2_000, fan: false })).toBe('unchanged');
    u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.siteSuspendedUntil?.getTime()).toBe(until);
    await liftLapsedSiteSuspensions();
    u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.status).toBe('ACTIVE');
    // A fresh suspension with no end named starts with no lapse time.
    await syncSiteStanding(u, 'suspended', { standingAt: t0 + 3_000, fan: false });
    u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.siteSuspendedUntil).toBeNull();
    expect(u.status).toBe('SUSPENDED');
  });

  it('a ban decided mid-suspension but delivered after the lift still applies', async () => {
    const uid = randomUUID();
    const t0 = Date.now() - 60_000;
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', t0));
    if (!r.ok) throw new Error('setup');
    await syncSiteStanding(r.user, 'suspended', { standingAt: t0 + 1_000, fan: false, suspendedUntil: Date.now() - 1_000 });
    await liftLapsedSiteSuspensions();
    let u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.status).toBe('ACTIVE');
    expect(await syncSiteStanding(u, 'banned', { standingAt: t0 + 5_000, fan: false })).toBe('banned');
    u = await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } });
    expect(u.status).toBe('BANNED');
  });

  it("never lifts an admin's suspension, nor one still running", async () => {
    const uid = randomUUID();
    const r = await resolveBridgedUser(creatorClaims(uid, 'active', Date.now() - 60_000));
    if (!r.ok) throw new Error('setup');
    await syncSiteStanding(r.user, 'suspended', { standingAt: Date.now() - 50_000, fan: false, suspendedUntil: Date.now() + 864e5 });
    await liftLapsedSiteSuspensions();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r.user.id } })).status).toBe('SUSPENDED');

    const uid2 = randomUUID();
    const r2 = await resolveBridgedUser(creatorClaims(uid2, 'active', Date.now() - 60_000));
    if (!r2.ok) throw new Error('setup');
    await prisma.user.update({ where: { id: r2.user.id }, data: { status: 'SUSPENDED', statusBySite: false, siteCreatorStatus: 'suspended', siteSuspendedUntil: new Date(Date.now() - 1_000) } });
    await liftLapsedSiteSuspensions();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: r2.user.id } })).status).toBe('SUSPENDED');
  });
});

describe('deposit indexer first-run cursor', () => {
  it('starts at the head only while no address exists', () => {
    expect(initialCursorBlock({ safe: 1000n, addressCount: 0, minIssuedBlock: null, unstampedAddresses: 0, envStartBlock: null })).toBe(999n);
  });
  it('starts no later than the earliest issuance, or DEPOSIT_START_BLOCK', () => {
    expect(initialCursorBlock({ safe: 1_200_000n, addressCount: 3, minIssuedBlock: 1_000_000n, unstampedAddresses: 0, envStartBlock: null })).toBe(999_999n);
    expect(initialCursorBlock({ safe: 1_200_000n, addressCount: 3, minIssuedBlock: 1_000_000n, unstampedAddresses: 0, envStartBlock: 900_000n })).toBe(899_999n);
    expect(initialCursorBlock({ safe: 1_200_000n, addressCount: 3, minIssuedBlock: 1_000_000n, unstampedAddresses: 1, envStartBlock: 950_000n })).toBe(949_999n);
  });
  it('refuses (null) when an address has no recorded block and no start block is set', () => {
    expect(initialCursorBlock({ safe: 1_200_000n, addressCount: 3, minIssuedBlock: 1_000_000n, unstampedAddresses: 1, envStartBlock: null })).toBeNull();
    expect(initialCursorBlock({ safe: 1_200_000n, addressCount: 1, minIssuedBlock: null, unstampedAddresses: 1, envStartBlock: null })).toBeNull();
  });
  it('parses DEPOSIT_START_BLOCK strictly', () => {
    expect(parseStartBlock(undefined)).toBeNull();
    expect(parseStartBlock(' 123 ')).toBe(123n);
    expect(() => parseStartBlock('12abc')).toThrow(/DEPOSIT_START_BLOCK/);
  });
});
