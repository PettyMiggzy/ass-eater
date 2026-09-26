import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

// A takedown that lands while a mass DM is still delivering -- DELETE
// /admin/media/:id writes no Report, so the worker must see it through the
// source media itself (workers/broadcast.ts re-checks the source FOR SHARE
// in every per-fan transaction).

const prisma = new PrismaClient();
let onPublish: (() => Promise<void>) | null = null;
vi.mock('../lib/redis.js', () => ({
  connection: { connection: {} },
  publish: vi.fn(async () => { if (onPublish) { const f = onPublish; onPublish = null; await f(); } }),
}));
const { processBroadcast } = await import('./broadcast.js');
const { broadcastTakenDown } = await import('../core/reports.js');

async function makeUser(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01'), ...extra } });
  return id;
}

afterAll(async () => { await prisma.$disconnect(); });

describe('broadcast worker vs a media takedown mid-delivery', () => {
  it('stops at the next fan and blanks every copy, instead of writing READY priced copies of deleted content', async () => {
    const creator = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED' });
    await prisma.creatorProfile.create({ data: { userId: creator, displayName: 'C' } });
    const fans = [await makeUser(), await makeUser(), await makeUser()];
    const tier = await prisma.subscriptionTier.create({ data: { creatorId: creator, name: 'T', priceCents: 500 } });
    for (const fanId of fans) {
      await prisma.subscription.create({ data: { fanId, creatorId: creator, tierId: tier.id, status: 'ACTIVE', priceCents: 500, currentPeriodEnd: new Date(Date.now() + 86_400_000) } });
    }
    const source = await prisma.media.create({ data: { ownerId: creator, key: `raw/${creator}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY' } });
    const broadcastId = 'bc-' + randomUUID();

    // After the FIRST copy is delivered, the admin takes the media down the
    // way modules/admin.ts does: root first, then every copy.
    onPublish = async () => {
      await prisma.media.updateMany({ where: { id: source.id }, data: { status: 'REJECTED', hlsKey: null, previewKey: null } });
      await prisma.media.updateMany({ where: { sourceMediaId: source.id }, data: { status: 'REJECTED', hlsKey: null, previewKey: null } });
    };
    const r = await processBroadcast({ creatorId: creator, text: 'priced drop', mediaIds: [source.id], priceCents: 1500, broadcastId }, 'job-1');
    expect(r).toMatchObject({ stopped: 'source_taken_down' });

    const copies = await prisma.message.findMany({ where: { senderId: creator, broadcastId }, include: { media: true } });
    expect(copies).toHaveLength(1);   // the second fan never got a copy
    for (const c of copies) {
      expect([c.text, c.priceCents]).toEqual(['', 0]);
      expect(c.media.every((m) => m.status === 'REJECTED')).toBe(true);
    }
    expect(await broadcastTakenDown(creator, broadcastId)).toBe(true);

    // A retry of the job sends nothing either.
    expect(await processBroadcast({ creatorId: creator, text: 'priced drop', mediaIds: [source.id], priceCents: 1500, broadcastId }, 'job-1'))
      .toMatchObject({ skipped: 'taken_down' });
  });
});
