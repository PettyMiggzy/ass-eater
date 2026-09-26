import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

// Round-8 regression tests for the mass-DM worker:
//  - it gates on creator APPROVAL (KYC + site standing), not just status, at
//    job start and on every copy;
//  - a source that becomes a listing's product or a public image after the
//    job started stops the drop;
//  - the listing / public-image checks are serialized against a copy being
//    written (lock-then-count), under read-committed AND money()'s
//    serializable isolation.

const prisma = new PrismaClient();
let onPublish: (() => Promise<void>) | null = null;
vi.mock('../lib/redis.js', () => ({
  connection: { connection: {} },
  publish: vi.fn(async () => { if (onPublish) { const f = onPublish; onPublish = null; await f(); } }),
}));
const { processBroadcast, claimSourcesForCopy } = await import('./broadcast.js');
const { assertNotDistributed } = await import('../modules/marketplace.js');
const { assertOwnPublicImages, lockMedia } = await import('../core/public-images.js');
const { money } = await import('../core/ledger.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeUser(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01'), ...extra } });
  return id;
}
async function setup(fanCount = 3, extra: Record<string, unknown> = {}) {
  const creator = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED', ...extra });
  await prisma.creatorProfile.create({ data: { userId: creator, displayName: 'C' } });
  const tier = await prisma.subscriptionTier.create({ data: { creatorId: creator, name: 'T', priceCents: 500 } });
  const fans: string[] = [];
  for (let i = 0; i < fanCount; i++) {
    const fanId = await makeUser();
    fans.push(fanId);
    await prisma.subscription.create({ data: { fanId, creatorId: creator, tierId: tier.id, status: 'ACTIVE', priceCents: 500, currentPeriodEnd: new Date(Date.now() + 86_400_000) } });
  }
  const source = await prisma.media.create({ data: { ownerId: creator, key: `raw/${creator}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY' } });
  return { creator, fans, source, broadcastId: 'bc-' + randomUUID() };
}

afterAll(async () => { await prisma.$disconnect(); });

describe('broadcast worker: creator approval', () => {
  it('sends nothing when the creator is no longer approved on the site at job start', async () => {
    const { creator, source, broadcastId } = await setup(2, { siteUid: 'site-' + randomUUID(), siteCreatorStatus: 'pending' });
    const r = await processBroadcast({ creatorId: creator, text: 'drop', mediaIds: [source.id], priceCents: 0, broadcastId }, 'j');
    expect(r).toMatchObject({ skipped: 'creator_not_approved' });
    expect(await prisma.message.count({ where: { senderId: creator, broadcastId } })).toBe(0);
  });

  it('stops mid-drop once approval is withdrawn, keeping (not blanking) what was already delivered', async () => {
    const { creator, source, broadcastId } = await setup(3, { siteUid: 'site-' + randomUUID(), siteCreatorStatus: 'active' });
    onPublish = async () => { await prisma.user.update({ where: { id: creator }, data: { siteCreatorStatus: 'pending' } }); };
    const r = await processBroadcast({ creatorId: creator, text: 'free drop', mediaIds: [source.id], priceCents: 0, broadcastId }, 'j');
    expect(r).toMatchObject({ stopped: 'creator_not_approved' });
    const sent = await prisma.message.findMany({ where: { senderId: creator, broadcastId }, include: { media: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe('free drop');
    expect(sent[0].media.every((m) => m.status === 'READY')).toBe(true);
  });
});

describe('broadcast worker: source attached or made public after the job started', () => {
  it('stops before copying media that became a listing product', async () => {
    const { creator, source, broadcastId } = await setup(3);
    onPublish = async () => {
      const l = await prisma.listing.create({ data: { creatorId: creator, title: 'x', priceCents: 50_000 } });
      await prisma.media.update({ where: { id: source.id }, data: { listingId: l.id } });
    };
    const r = await processBroadcast({ creatorId: creator, text: 'd', mediaIds: [source.id], priceCents: 0, broadcastId }, 'j');
    expect(r).toMatchObject({ stopped: 'source_attached' });
    expect(await prisma.message.count({ where: { senderId: creator, broadcastId } })).toBe(1);
  });

  it('stops before copying media that became the creator avatar', async () => {
    const { creator, source, broadcastId } = await setup(3);
    onPublish = async () => { await prisma.creatorProfile.update({ where: { userId: creator }, data: { avatarKey: source.key } }); };
    const r = await processBroadcast({ creatorId: creator, text: 'd', mediaIds: [source.id], priceCents: 900, broadcastId }, 'j');
    expect(r).toMatchObject({ stopped: 'media_is_public_image' });
    expect(await prisma.message.count({ where: { senderId: creator, broadcastId } })).toBe(1);
  });
});

/**
 * Holds a copy transaction open (sources claimed, copy written, not yet
 * committed) until release() is called.
 */
async function openCopyTx(creator: string, source: { id: string; key: string }) {
  let locked!: () => void; const lockedP = new Promise<void>((r) => { locked = r; });
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const done = prisma.$transaction(async (tx) => {
    await claimSourcesForCopy(tx, [source.id]);
    await tx.media.create({ data: { ownerId: creator, key: `${source.key}#${randomUUID()}`, sourceMediaId: source.id, mime: 'image/jpeg', status: 'READY' } });
    locked();
    await gate;
  }, { timeout: 20_000 });
  await lockedP;
  return { release, done };
}

describe('listing / public-image checks vs a copy in flight', () => {
  it('a one-of-a-kind check (read committed) waits for the copy and then refuses', async () => {
    const { creator, source } = await setup(0);
    const copy = await openCopyTx(creator, source);
    let settled = false;
    const check = prisma.$transaction((tx) => assertNotDistributed(tx as any, creator, [source.id]));
    check.then(() => { settled = true; }, () => { settled = true; });
    await sleep(300);
    expect(settled).toBe(false);   // blocked on the copy's lock, not counting 0
    copy.release(); await copy.done;
    await expect(check).rejects.toThrow('media_already_distributed');
  });

  it('a public-image check under money() (serializable) retries after the copy and then refuses', async () => {
    const { creator, source } = await setup(0);
    const copy = await openCopyTx(creator, source);
    const check = money(prisma, (tx) => assertOwnPublicImages(tx, creator, [source.key]));
    check.catch(() => {});
    await sleep(300);
    copy.release(); await copy.done;
    await expect(check).rejects.toThrow('bad_images');
  });

  it('a copy that waited on a listing lock sees the listing and stops', async () => {
    const { creator, source } = await setup(0);
    const l = await prisma.listing.create({ data: { creatorId: creator, title: 'x', priceCents: 50_000 } });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void; const lockedP = new Promise<void>((r) => { locked = r; });
    const listingTx = prisma.$transaction(async (tx) => {
      await assertNotDistributed(tx as any, creator, [source.id]);
      await tx.media.update({ where: { id: source.id }, data: { listingId: l.id } });
      locked(); await gate;
    }, { timeout: 20_000 });
    await lockedP;
    const copyTx = prisma.$transaction((tx) => claimSourcesForCopy(tx, [source.id]));
    copyTx.catch(() => {});
    await sleep(200);
    release(); await listingTx;
    await expect(copyTx).rejects.toBeTruthy();
    expect((await copyTx.catch((e) => e)).constructor.name).toBe('SourceAttached');
  });
});

describe('lockMedia takes only the caller\'s own rows', () => {
  it('another creator naming a live drop\'s source ids or key does not wait on (or stall) its copy', async () => {
    const { creator, source } = await setup(0);
    const other = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED' });
    const copy = await openCopyTx(creator, source);
    let settled = false;
    const probe = prisma.$transaction((tx) => lockMedia(tx as any, other, [source.id], [source.key]));
    probe.then(() => { settled = true; }, () => { settled = true; });
    await sleep(300);
    expect(settled).toBe(true);   // not blocked: the rows are not other's to lock
    await probe;
    // The owner still serializes against the copy.
    let ownerSettled = false;
    const own = prisma.$transaction((tx) => lockMedia(tx as any, creator, [source.id]));
    own.then(() => { ownerSettled = true; }, () => { ownerSettled = true; });
    await sleep(300);
    expect(ownerSettled).toBe(false);
    copy.release(); await copy.done; await own;
  });
});
