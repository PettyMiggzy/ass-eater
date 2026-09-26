import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { fileReport, broadcastTakenDown } from './reports';
import { OutflowJournal, OutflowJournalUnavailable, journalModeFromEnv } from '../lib/outflow-journal';
import { outflowLimitReason } from '../workers/payout-worker';
import { selectBurnBatch, burnRoomCents } from '../workers/token-burn';
import { hedgeTokenRoomRaw, wholeTokensUp } from '../workers/treasury-hedge';

// Round-8 server regression tests: the treasury outflow journal (restart-
// and DB-proof caps for payouts, burns and hedges), and the moderation queue
// no longer being buried by one widely reported mass DM.

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
async function massDm(creator: string, fans: string[]) {
  const source = await prisma.media.create({ data: { ownerId: creator, key: `raw/${creator}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY' } });
  const broadcastId = 'bc-' + randomUUID();
  const messages = [];
  for (const fan of fans) {
    const m = await convMessage(creator, fan, { text: 'drop', priceCents: 500, broadcastId });
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
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outflow-'));

describe('treasury outflow journal', () => {
  it('survives a restart: a new process reads what the old one signed', () => {
    const dir = tmpDir();
    const a = new OutflowJournal({ kind: 'file', dir });
    a.record('payout', 450_000, 'p1');
    a.record('burn', 10_000, 'b1');
    const b = new OutflowJournal({ kind: 'file', dir });   // "after a restart"
    expect(b.sumSince('payout')).toBe(450_000);
    expect(b.sumSince('burn')).toBe(10_000);
    expect(b.sumSince('hedge')).toBe(0);
    expect(fs.statSync(path.join(dir, 'treasury-outflow.jsonl')).mode & 0o077).toBe(0);
  });

  it('only counts the rolling 24h window and compacts older entries away', () => {
    const dir = tmpDir();
    let now = Date.now();
    const a = new OutflowJournal({ kind: 'file', dir }, () => now);
    a.record('payout', 100, 'old');
    now += 25 * 3_600_000;
    a.record('payout', 7, 'new');
    expect(a.sumSince('payout')).toBe(7);
    now += 49 * 3_600_000;
    const b = new OutflowJournal({ kind: 'file', dir }, () => now);
    expect(b.sumSince('payout')).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'treasury-outflow.jsonl'), 'utf8')).toBe('');
  });

  it('tolerates a torn final line (crash mid-append) and appends cleanly after it', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'treasury-outflow.jsonl');
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), kind: 'payout', cents: 5, ref: 'a' }) + '\n{"at":12', { mode: 0o600 });
    const j = new OutflowJournal({ kind: 'file', dir });
    expect(j.sumSince('payout')).toBe(5);
    j.record('payout', 6, 'b');
    expect(new OutflowJournal({ kind: 'file', dir }).sumSince('payout')).toBe(11);
  });

  it('fails closed on damage anywhere else, and when not configured', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'treasury-outflow.jsonl'), 'garbage\n' + JSON.stringify({ at: Date.now(), kind: 'payout', cents: 5, ref: 'a' }) + '\n');
    expect(() => new OutflowJournal({ kind: 'file', dir }).sumSince('payout')).toThrow(OutflowJournalUnavailable);
    expect(() => new OutflowJournal({ kind: 'missing' }).sumSince('payout')).toThrow(OutflowJournalUnavailable);
    expect(journalModeFromEnv({ NODE_ENV: 'production' } as any)).toEqual({ kind: 'missing' });
    expect(journalModeFromEnv({ STATE_DIRECTORY: '/var/lib/onlyone-workers' } as any)).toEqual({ kind: 'file', dir: '/var/lib/onlyone-workers' });
  });

  it('holds a payout on what the journal says even when the Payout table has been scrubbed', async () => {
    await prisma.payout.updateMany({ where: { signedAt: { gte: new Date(Date.now() - 86_400_000) } }, data: { signedAt: new Date(Date.now() - 2 * 86_400_000) } });
    const j = new OutflowJournal({ kind: 'file', dir: tmpDir() });
    for (let i = 0; i < 4; i++) j.record('payout', 450_000, `p${i}`);
    // The DB shows nothing signed (an attacker nulled signedAt / marked REFUNDED).
    expect(await outflowLimitReason(randomUUID(), 200_000, j)).toBeNull();
    expect(await outflowLimitReason(randomUUID(), 200_001, j)).toMatch(/daily payout limit/);
    expect(await outflowLimitReason(randomUUID(), 100, new OutflowJournal({ kind: 'missing' }))).toMatch(/journal unavailable/);
  });

  it('caps the automatic burn per batch and per day, skipping an oversized obligation', () => {
    const j = new OutflowJournal({ kind: 'memory' });
    expect(burnRoomCents(j, 200_000, 500_000)).toBe(200_000n);
    j.record('burn', 450_000, 'x');
    expect(burnRoomCents(j, 200_000, 500_000)).toBe(50_000n);
    j.record('burn', 50_000, 'y');
    expect(burnRoomCents(j, 200_000, 500_000)).toBe(0n);
    expect(burnRoomCents(new OutflowJournal({ kind: 'missing' }))).toBe(0n);
    const rows = [{ usdCents: 10_000n }, { usdCents: 10_000_000n }, { usdCents: 30_000n }, { usdCents: 20_000n }];
    expect(selectBurnBatch(rows, 45_000n)).toEqual([rows[0], rows[2]]);
  });

  it('caps the hedge by tokens sold, not only by the (manipulable) dollar quote', () => {
    const j = new OutflowJournal({ kind: 'memory' });
    const d = 18, unit = 10n ** 18n;
    expect(hedgeTokenRoomRaw(j, d, 5_000_000, 20_000_000)).toBe(5_000_000n * unit);
    j.record('hedge_tokens', wholeTokensUp(18_000_000n * unit + 1n, d), 'x');   // rounded UP
    expect(j.sumSince('hedge_tokens')).toBe(18_000_001);
    expect(hedgeTokenRoomRaw(j, d, 5_000_000, 20_000_000)).toBe(1_999_999n * unit);
    j.record('hedge_tokens', 1_999_999, 'y');
    expect(hedgeTokenRoomRaw(j, d, 5_000_000, 20_000_000)).toBe(0n);
    // A dollar-side record does not count against the token cap, nor the reverse.
    expect(j.sumSince('hedge')).toBe(0);
    expect(() => hedgeTokenRoomRaw(new OutflowJournal({ kind: 'missing' }), d)).toThrow(OutflowJournalUnavailable);
  });
});

describe('moderation queue vs a widely reported mass DM', () => {
  // Every OPEN report (all pages), keyed by id.
  async function allOpen(app: any, extra = '') {
    const out = new Map<string, any>();
    for (let offset = 0; ; offset += 200) {
      const page = (await app.inject({ method: 'GET', url: `/admin/reports?limit=200&offset=${offset}${extra}` })).json();
      for (const r of page.reports) out.set(r.id, r);
      if (offset + 200 >= page.total) return out;
    }
  }

  it('actioning one copy takes the drop down but leaves the other reports OPEN, returned with their reasons and sorted after live content', async () => {
    const creator = await makeCreator();
    const fans = [await makeUser(), await makeUser(), await makeUser()];
    const { broadcastId, messages } = await massDm(creator, fans);
    const reps = [];
    for (let i = 0; i < fans.length; i++) reps.push(await fileReport(fans[i], 'message', messages[i].id, i === 2 ? 'performer looks underage' : 'this is me'));
    const unrelated = await fileReport(fans[0], 'user', creator, 'harassment');

    const app = await adminApp();
    const res = await app.inject({ method: 'POST', url: `/admin/reports/${reps[0].id}/resolve`, payload: { action: 'remove_content' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect((await prisma.report.findUniqueOrThrow({ where: { id: reps[0].id } })).status).toBe('ACTIONED');
    // Nobody read the other reporters' reasons: they are not closed with this one.
    for (const r of reps.slice(1)) expect((await prisma.report.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('OPEN');
    expect(body.settledReports).toEqual([]);
    expect(body.openRelatedReports.map((o: any) => o.id).sort()).toEqual([reps[1].id, reps[2].id].sort());
    expect(body.openRelatedReports.map((o: any) => o.reason)).toContain('performer looks underage');
    expect(await broadcastTakenDown(creator, broadcastId)).toBe(true);

    // A later report on an already-blanked copy is still filed -- its reason is kept.
    const late = await fileReport(await makeUser(), 'message', messages[1].id, 'me too, and she is 15');
    expect(late.already).toBe(false);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: late.id } })).status).toBe('OPEN');

    // The queue: live content first, the taken-down drop's reports after it.
    const first = (await app.inject({ method: 'GET', url: '/admin/reports?limit=200' })).json();
    const flags = first.reports.map((r: any) => r.contentRemoved);
    expect(flags).toEqual([...flags].sort((x: boolean, y: boolean) => Number(x) - Number(y)));
    const open = await allOpen(app);
    for (const id of [reps[1].id, reps[2].id, late.id]) expect(open.get(id)?.contentRemoved).toBe(true);
    expect(open.get(unrelated.id)?.contentRemoved).toBe(false);
    const live = await allOpen(app, '&contentRemoved=false');
    expect(live.has(unrelated.id)).toBe(true);
    expect(live.has(reps[1].id)).toBe(false);
    await app.close();
  });

  it('a ban settles the other reports on the same content, returning each one it closed', async () => {
    const creator = await makeCreator();
    const fans = [await makeUser(), await makeUser()];
    const { messages } = await massDm(creator, fans);
    const a = await fileReport(fans[0], 'message', messages[0].id, 'x');
    const b = await fileReport(fans[1], 'message', messages[1].id, 'y');
    const app = await adminApp();
    const res = await app.inject({ method: 'POST', url: `/admin/reports/${a.id}/resolve`, payload: { action: 'ban_user' } });
    expect(res.statusCode).toBe(200);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('ACTIONED');
    expect(res.json().settledReports).toMatchObject([{ id: b.id, reason: 'y' }]);
    await app.close();
  });

  it('dismissing one copy leaves every other reporter\'s report open', async () => {
    const creator = await makeCreator();
    const fans = [await makeUser(), await makeUser()];
    const { messages } = await massDm(creator, fans);
    const a = await fileReport(fans[0], 'message', messages[0].id, 'x');
    const b = await fileReport(fans[1], 'message', messages[1].id, 'y');
    const app = await adminApp();
    const res = await app.inject({ method: 'POST', url: `/admin/reports/${a.id}/resolve`, payload: { action: 'dismiss' } });
    expect(res.statusCode).toBe(200);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('OPEN');
    await app.close();
  });

  it('GET /admin/reports is paged with a total, so nothing is capped at the oldest 100', async () => {
    const app = await adminApp();
    const creator = await makeCreator();
    for (let i = 0; i < 5; i++) await fileReport(await makeUser(), 'user', creator, `r${i}`);
    const total = await prisma.report.count({ where: { status: 'OPEN' } });
    const p1 = (await app.inject({ method: 'GET', url: '/admin/reports?limit=2' })).json();
    expect(p1).toMatchObject({ total, limit: 2, offset: 0 });
    expect(p1.reports).toHaveLength(2);
    const last = (await app.inject({ method: 'GET', url: `/admin/reports?limit=2&offset=${total - 1}` })).json();
    expect(last.reports).toHaveLength(1);
    const users = (await app.inject({ method: 'GET', url: '/admin/reports?targetType=user&limit=200' })).json();
    expect(users.reports.every((r: any) => r.targetType === 'user')).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/admin/reports?status=BOGUS' })).statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });
});
