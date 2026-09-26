import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

// Round-19 server regression tests: live viewers are re-checked on every
// stream (a lapsed subscriber or a non-ACTIVE fan is removed, tickets and
// paid minutes included) and a moderation action removes the account from
// rooms it is watching; the report target view agrees with the queue about a
// BANNED creator's self-deleted PPV post; a reprice's sweep re-queue is
// recorded with the settle and survives an enqueue failure.

vi.mock('../lib/redis', async (orig) => ({
  ...(await orig<typeof import('../lib/redis')>()),
  publish: async () => 0,
}));

process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'test-lk-key';
process.env.LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'test-lk-secret-' + randomUUID();

const { money, post, PLATFORM_ID } = await import('./ledger');
const { viewerIdentity } = await import('./live-identity');
const { checkViewerOnJoin, sweepLive } = await import('./live-sweep');
const { applyUserStatus } = await import('./moderation');
const { postStillServedToBuyers } = await import('./reports');
const { settleRepriced, drainSweepRequeues } = await import('../workers/reprice-scan');

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
async function subscribe(fanId: string, creatorId: string, periodEnd: Date) {
  const tier = await prisma.subscriptionTier.create({ data: { creatorId, name: 't', priceCents: 999 } });
  await prisma.subscription.create({ data: { fanId, creatorId, tierId: tier.id, priceCents: 999, currentPeriodEnd: periodEnd } });
}
const fund = (userId: string, cents: number) => money(prisma, (tx) => post(tx, userId, cents, 'ADJUSTMENT'));

function fakeRooms(roomName: string, identities: string[]) {
  const removed: string[] = [];
  const rooms = {
    // Only this test's room exists: other LIVE streams left in a shared test
    // DB are young (start grace) or ended, and never listed here.
    listRooms: async (names?: string[]) => (names ?? []).filter((n) => n === roomName).map((name) => ({ name })),
    listParticipants: async () => identities.map((identity) => ({ identity })),
    removeParticipant: async (_room: string, identity: string) => { removed.push(identity); },
  } as any;
  return { rooms, removed };
}

describe('srv-money-modules#0: live viewers are re-checked on every stream', () => {
  it('a subscriber-only stream removes a lapsed subscriber and a banned or suspended one, and keeps a current one', async () => {
    const creator = await makeCreator();
    const current = await makeUser();
    const lapsed = await makeUser();
    const banned = await makeUser();
    const suspended = await makeUser();
    const future = new Date(Date.now() + 864e5);
    await subscribe(current, creator, future);
    await subscribe(lapsed, creator, new Date(Date.now() - 60_000));
    await subscribe(banned, creator, future);
    await subscribe(suspended, creator, future);
    await prisma.user.update({ where: { id: banned }, data: { status: 'BANNED' } });
    await prisma.user.update({ where: { id: suspended }, data: { status: 'SUSPENDED' } });
    const s = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't' } });
    const ids = [current, lapsed, banned, suspended].map((u) => viewerIdentity(s.id, u));
    const { rooms, removed } = fakeRooms(s.roomName, [creator, ...ids]);

    expect(await checkViewerOnJoin(rooms, s.roomName, viewerIdentity(s.id, current))).toBe(false);
    expect(await checkViewerOnJoin(rooms, s.roomName, viewerIdentity(s.id, lapsed))).toBe(true);
    expect(await checkViewerOnJoin(rooms, s.roomName, viewerIdentity(s.id, banned))).toBe(true);
    removed.length = 0;

    await sweepLive(rooms);
    const mine = removed.filter((i) => ids.includes(i) || i === creator);
    expect(mine.sort()).toEqual([lapsed, banned, suspended].map((u) => viewerIdentity(s.id, u)).sort());
  });

  it('a ticket or paid minutes do not keep a banned fan in the room', async () => {
    const creator = await makeCreator();
    const holder = await makeUser();
    const bannedHolder = await makeUser();
    const ticketed = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't', ticketPriceCents: 5000 } });
    await prisma.liveTicket.create({ data: { fanId: holder, streamId: ticketed.id } });
    await prisma.liveTicket.create({ data: { fanId: bannedHolder, streamId: ticketed.id } });
    await prisma.user.update({ where: { id: bannedHolder }, data: { status: 'BANNED' } });
    const t = fakeRooms(ticketed.roomName, [holder, bannedHolder].map((u) => viewerIdentity(ticketed.id, u)));
    await sweepLive(t.rooms);
    expect(t.removed).toContain(viewerIdentity(ticketed.id, bannedHolder));
    expect(t.removed).not.toContain(viewerIdentity(ticketed.id, holder));

    const creator2 = await makeCreator();
    const payer = await makeUser();
    await fund(payer, 1000);
    const perMinute = await prisma.liveStream.create({ data: { creatorId: creator2, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't', perMinuteCents: 100 } });
    const { ensureMinutePaid } = await import('./live-billing');
    await ensureMinutePaid(payer, perMinute);
    expect(await checkViewerOnJoin(t.rooms, perMinute.roomName, viewerIdentity(perMinute.id, payer))).toBe(false);
    await prisma.user.update({ where: { id: payer }, data: { status: 'SUSPENDED' } });
    expect(await checkViewerOnJoin(t.rooms, perMinute.roomName, viewerIdentity(perMinute.id, payer))).toBe(true);
  });

  it('a ban removes the account from every LIVE room it is watching', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const s = await prisma.liveStream.create({ data: { creatorId: creator, roomName: `live_${randomUUID().slice(0, 10)}`, title: 't' } });
    const removed: Array<[string, string]> = [];
    const rooms = {
      deleteRoom: async () => {},
      removeParticipant: async (room: string, identity: string) => {
        removed.push([room, identity]);
        if (room !== s.roomName) throw new Error('not in this room');   // not watching the others: never fatal
      },
    };
    expect(await applyUserStatus(fan, 'BANNED', { rooms })).toBe(true);
    expect(removed).toContainEqual([s.roomName, viewerIdentity(s.id, fan)]);
  });
});

describe('srv-auth-core#1: the report target view agrees with the queue on a banned creator', () => {
  it('a BANNED creator\'s self-deleted PPV post is not "still served"; a SUSPENDED one\'s still is', async () => {
    const c = await makeCreator();
    const buyer = await makeUser();
    const p = await prisma.post.create({ data: { creatorId: c, text: 't', visibility: 'PPV', priceCents: 500, removed: true, removedByCreator: true } as any });
    await prisma.postUnlock.create({ data: { fanId: buyer, postId: p.id } });
    expect(await postStillServedToBuyers(p)).toBe(true);
    await prisma.user.update({ where: { id: c }, data: { status: 'SUSPENDED' } });
    expect(await postStillServedToBuyers(p)).toBe(true);
    await prisma.user.update({ where: { id: c }, data: { status: 'BANNED' } });
    expect(await postStillServedToBuyers(p)).toBe(false);

    const { listReports } = await import('./reports');
    const reporter = await makeUser();
    const rep = await prisma.report.create({ data: { reporterId: reporter, targetType: 'post', targetId: p.id, reason: 'other' } });
    let found: boolean | undefined;
    for (let offset = 0; found === undefined; offset += 200) {
      const q = await listReports({ status: 'OPEN', targetType: 'post', limit: 200, offset } as any);
      const row = q.reports.find((r: any) => r.id === rep.id);
      if (row) found = !!row.contentRemoved;
      if (!q.reports.length) break;
    }
    expect(found).toBe(true);   // contentRemoved in the queue == not still served
  });
});

describe('srv-workers-infra#0: a reprice\'s sweep re-queue is durable', () => {
  it('the settle records it; a failed enqueue keeps it; a successful one clears it; a switched-off asset is left alone', async () => {
    const u = await makeUser();
    const chainId = 900_000 + Math.floor(Math.random() * 90_000);
    const base = { userId: u, chainId, rawAmount: '1000', usdCents: 0n, priceUsed: 0, pricePending: true, hedgedAt: new Date() };
    const eth = await prisma.deposit.create({ data: { ...base, asset: 'ETH', txHash: `0x${randomUUID()}`, logIndex: 0 } });
    const tok = await prisma.deposit.create({ data: { ...base, asset: 'ONLYONE', txHash: `0x${randomUUID()}`, logIndex: 1 } });

    expect((await settleRepriced(eth, 0n, 3000, async () => {})).claimed).toBe(true);
    expect((await settleRepriced(tok, 0n, 1, async () => {})).claimed).toBe(true);
    for (const d of [eth, tok]) {
      const row = await prisma.deposit.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.pricePending).toBe(false);
      expect(row.sweepRequeue).toBe(true);
    }

    // Redis down: nothing is cleared, the next pass tries again.
    const down = await drainSweepRequeues(chainId, async () => { throw new Error('redis down'); }, { log: () => {} });
    expect(down).toEqual({ queued: 0, failed: 2 });
    expect((await prisma.deposit.findUniqueOrThrow({ where: { id: eth.id } })).sweepRequeue).toBe(true);

    // $ONLYONE indexing off: its row is skipped, not cleared.
    const seen: string[] = [];
    const up = await drainSweepRequeues(chainId, async (d) => { seen.push(d.id); }, { skipAssets: ['ONLYONE'] });
    expect(up).toEqual({ queued: 1, failed: 0 });
    expect(seen).toEqual([eth.id]);
    expect((await prisma.deposit.findUniqueOrThrow({ where: { id: eth.id } })).sweepRequeue).toBe(false);
    expect((await prisma.deposit.findUniqueOrThrow({ where: { id: tok.id } })).sweepRequeue).toBe(true);

    // Nothing left to do for ETH on the next pass.
    const again = await drainSweepRequeues(chainId, async (d) => { seen.push(d.id); }, { skipAssets: ['ONLYONE'] });
    expect(again).toEqual({ queued: 0, failed: 0 });
  });
});
