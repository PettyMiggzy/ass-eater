import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { fileReport, listReports } from './reports';
import { startLiveStream } from './live-sweep';
import { applyUserStatus } from './moderation';
import { OutflowJournal } from '../lib/outflow-journal';
import { dmSendRole } from '../modules/messages';

// Round-9 server regression tests: the report queue's contentRemoved flag
// (banned owners, single DMs taken down by media rejection), resolve never
// downgrading a ban, one LIVE stream per creator, a creator DMing a creator
// they subscribe to, and the outflow journal's unterminated-line / short-write
// / future-clock handling.

const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });

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
async function convMessage(sender: string, other: string, data: Record<string, unknown>) {
  const [aId, bId] = sender < other ? [sender, other] : [other, sender];
  const conv = await prisma.conversation.upsert({ where: { aId_bId: { aId, bId } }, create: { aId, bId }, update: {} });
  return prisma.message.create({ data: { conversationId: conv.id, senderId: sender, ...data } as any });
}
async function subscribe(fanId: string, creatorId: string) {
  const tier = await prisma.subscriptionTier.create({ data: { creatorId, name: 't', priceCents: 500 } });
  await prisma.subscription.create({ data: { fanId, creatorId, tierId: tier.id, priceCents: 500, currentPeriodEnd: new Date(Date.now() + 86_400_000) } });
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
/** Every OPEN report on the given target type, all pages, keyed by id. */
async function allOpen(targetType: 'post' | 'message' | 'listing' | 'user') {
  const out = new Map<string, any>();
  for (let offset = 0; ; offset += 200) {
    const page = await listReports({ status: 'OPEN', targetType, limit: 200, offset });
    for (const r of page.reports) out.set(r.id as string, r);
    if (offset + 200 >= page.total) return out;
  }
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outflow9-'));

describe('report queue: contentRemoved', () => {
  it('counts a BANNED owner\'s post and listing as down, but not a SUSPENDED owner\'s', async () => {
    const banned = await makeCreator();
    const suspended = await makeCreator();
    const pb = await prisma.post.create({ data: { creatorId: banned, text: 'x' } as any });
    const ps = await prisma.post.create({ data: { creatorId: suspended, text: 'y' } as any });
    const lb = await prisma.listing.create({ data: { creatorId: banned, title: 'L', priceCents: 1000 } });
    const rpb = await fileReport(await makeUser(), 'post', pb.id, 'a');
    const rps = await fileReport(await makeUser(), 'post', ps.id, 'b');
    const rlb = await fileReport(await makeUser(), 'listing', lb.id, 'c');
    await prisma.user.update({ where: { id: banned }, data: { status: 'BANNED' } });
    await prisma.user.update({ where: { id: suspended }, data: { status: 'SUSPENDED' } });
    const posts = await allOpen('post');
    expect(posts.get(rpb.id)?.contentRemoved).toBe(true);
    expect(posts.get(rps.id)?.contentRemoved).toBe(false);
    expect((await allOpen('listing')).get(rlb.id)?.contentRemoved).toBe(true);
  });

  it('counts a single DM whose media was REJECTED (no report) and a banned sender\'s DM as down', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const m1 = await convMessage(creator, fan, { text: 'hi', priceCents: 0 });
    await prisma.media.create({ data: { ownerId: creator, key: `raw/${creator}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY', messageId: m1.id } });
    const r1 = await fileReport(fan, 'message', m1.id, 'ncii');
    expect((await allOpen('message')).get(r1.id)?.contentRemoved).toBe(false);
    await prisma.media.updateMany({ where: { messageId: m1.id }, data: { status: 'REJECTED' } });
    expect((await allOpen('message')).get(r1.id)?.contentRemoved).toBe(true);

    const other = await makeCreator();
    const m2 = await convMessage(other, fan, { text: 'yo', priceCents: 0 });
    const r2 = await fileReport(fan, 'message', m2.id, 'spam');
    expect((await allOpen('message')).get(r2.id)?.contentRemoved).toBe(false);
    await prisma.user.update({ where: { id: other }, data: { status: 'BANNED' } });
    expect((await allOpen('message')).get(r2.id)?.contentRemoved).toBe(true);
  });

  it('still marks every copy of a taken-down mass DM, and the unfiltered total counts every report', async () => {
    const creator = await makeCreator();
    const fans = [await makeUser(), await makeUser()];
    const broadcastId = 'bc-' + randomUUID();
    const ms = [await convMessage(creator, fans[0], { text: 'd', broadcastId }), await convMessage(creator, fans[1], { text: 'd', broadcastId })];
    const a = await fileReport(fans[0], 'message', ms[0].id, 'x');
    const b = await fileReport(fans[1], 'message', ms[1].id, 'y');
    await prisma.report.update({ where: { id: a.id }, data: { status: 'ACTIONED' } });
    expect((await allOpen('message')).get(b.id)?.contentRemoved).toBe(true);
    const all = await listReports({ status: 'OPEN', limit: 1, offset: 0 });
    expect(all.total).toBe(await prisma.report.count({ where: { status: 'OPEN' } }));
  });
});

describe('resolving a report never lowers a ban', () => {
  it('refuses suspend_user on a banned owner (report stays OPEN), and shows the owner in the target view', async () => {
    const creator = await makeCreator();
    const post = await prisma.post.create({ data: { creatorId: creator, text: 'x' } as any });
    const r = await fileReport(await makeUser(), 'post', post.id, 'r');
    await applyUserStatus(creator, 'BANNED', { rooms: { deleteRoom: async () => undefined } });
    const app = await adminApp();
    const t = (await app.inject({ method: 'GET', url: `/admin/reports/${r.id}/target` })).json();
    expect(t.target.owner).toMatchObject({ id: creator, status: 'BANNED' });
    const res = await app.inject({ method: 'POST', url: `/admin/reports/${r.id}/resolve`, payload: { action: 'suspend_user' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'owner_already_banned', ownerStatus: 'BANNED' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: creator } })).status).toBe('BANNED');
    expect((await prisma.report.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('OPEN');
    await app.close();
  });

  it('noDowngrade keeps BANNED even when a suspension races the check', async () => {
    const u = await makeUser();
    await prisma.user.update({ where: { id: u }, data: { status: 'BANNED' } });
    expect(await applyUserStatus(u, 'SUSPENDED', { noDowngrade: true, rooms: { deleteRoom: async () => undefined } })).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u } })).status).toBe('BANNED');
    const v = await makeUser();
    expect(await applyUserStatus(v, 'SUSPENDED', { noDowngrade: true, rooms: { deleteRoom: async () => undefined } })).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: v } })).status).toBe('SUSPENDED');
  });
});

describe('POST /live/start: one LIVE stream per creator', () => {
  it('a double tap makes exactly one stream, and the loser\'s room is deleted', async () => {
    const creator = await makeCreator();
    const created: string[] = [], deleted: string[] = [];
    const fake = {
      listRooms: async (names?: string[]) => created.filter((n) => !deleted.includes(n) && (!names || names.includes(n))).map((name) => ({ name })),
      listParticipants: async () => [], removeParticipant: async () => undefined,
      createRoom: async ({ name }: { name: string }) => { created.push(name); return { name }; },
      deleteRoom: async (name: string) => { deleted.push(name); },
    } as any;
    const data = { title: 't', ticketPriceCents: 0, perMinuteCents: 0 };
    const [a, b] = await Promise.all([
      startLiveStream(fake, creator, data, `live_${randomUUID()}`),
      startLiveStream(fake, creator, data, `live_${randomUUID()}`),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await prisma.liveStream.count({ where: { creatorId: creator, status: 'LIVE' } })).toBe(1);
    expect(deleted).toHaveLength(1);
    const winner = (a.ok ? a : b) as any;
    expect(deleted[0]).not.toBe(winner.stream.roomName);
    // A third start while that one is really live is refused too.
    expect((await startLiveStream(fake, creator, data, `live_${randomUUID()}`)).ok).toBe(false);
  });
});

describe('DM permission', () => {
  it('a creator may DM a creator they subscribe to, as a paid fan DM', async () => {
    const a = await makeCreator();
    const b = await makeCreator();
    expect(await dmSendRole(a, b, true)).toBe(null);
    await subscribe(a, b);
    expect(await dmSendRole(a, b, true)).toBe('fan');
    // b writing to a subscriber of theirs is the creator path.
    expect(await dmSendRole(b, a, true)).toBe('creator');
    // A fan with no subscription either way is refused.
    expect(await dmSendRole(await makeUser(), b, false)).toBe(null);
  });
});

describe('treasury outflow journal, round 9', () => {
  it('re-terminates a complete last entry missing its newline, so the next append cannot glue onto it', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'treasury-outflow.jsonl');
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), kind: 'payout', cents: 5, ref: 'a' }), { mode: 0o600 });
    const j = new OutflowJournal({ kind: 'file', dir });
    expect(j.sumSince('payout')).toBe(5);
    j.record('payout', 7, 'b');
    // "After a restart": must load cleanly, with both entries.
    expect(new OutflowJournal({ kind: 'file', dir }).sumSince('payout')).toBe(12);
    expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('writes the whole entry across short writes, and fails closed on a write that makes no progress', () => {
    const dir = tmpDir();
    const j = new OutflowJournal({ kind: 'file', dir });
    j.assertUsable();
    const real = fs.writeSync;
    let calls = 0;
    (fs as any).writeSync = (fd: number, buf: any, off?: number, len?: number) => {
      calls++;
      // Write at most 7 bytes per call.
      return real(fd, buf, off, Math.min(7, len ?? buf.length));
    };
    try { j.record('payout', 3, 'short'); } finally { (fs as any).writeSync = real; }
    expect(calls).toBeGreaterThan(1);
    expect(new OutflowJournal({ kind: 'file', dir }).sumSince('payout')).toBe(3);

    (fs as any).writeSync = () => 0;
    try { expect(() => j.record('payout', 4, 'stuck')).toThrow(/not writable/); } finally { (fs as any).writeSync = real; }
    expect(new OutflowJournal({ kind: 'file', dir }).sumSince('payout')).toBe(3);
  });

  it('clamps future-dated entries to now: counted for one window, not for the length of the clock jump', () => {
    const dir = tmpDir();
    let now = Date.now();
    const ahead = new OutflowJournal({ kind: 'file', dir }, () => now + 30 * 86_400_000);   // clock 30 days fast
    ahead.record('payout', 2_000_000, 'fast');
    const errs: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a); };
    let j: OutflowJournal;
    try {
      j = new OutflowJournal({ kind: 'file', dir }, () => now);                          // corrected
      expect(j.sumSince('payout')).toBe(2_000_000);
    } finally { console.error = orig; }
    expect(errs.length).toBeGreaterThan(0);
    now += 25 * 3_600_000;
    expect(j!.sumSince('payout')).toBe(0);
    expect(new OutflowJournal({ kind: 'file', dir }, () => now).sumSince('payout')).toBe(0);
  });
});
