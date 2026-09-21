import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, post, PLATFORM_ID } from '../core/ledger';
import { unlockPost } from './posts';

const prisma = new PrismaClient();

async function makeUser() {
  const id = randomUUID();
  await prisma.user.create({
    data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01') },
  });
  return id;
}
async function makeCreator() {
  const userId = await makeUser();
  await prisma.creatorProfile.create({ data: { userId, displayName: 'C' } });
  return userId;
}
async function fund(userId: string, cents: number) {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await money(prisma, (tx) => post(tx, userId, cents, 'DEPOSIT'));
}
async function makePpvPost(creatorId: string, priceCents: number) {
  return prisma.post.create({ data: { creatorId, text: 'x', visibility: 'PPV', priceCents } });
}

afterAll(() => prisma.$disconnect());

describe('unlockPost double-click race', () => {
  // A real double-click: two concurrent requests both pass the caller's
  // "already unlocked?" pre-check before either commits its create. Postgres
  // guarantees exactly one wins the unique constraint on (fanId, postId);
  // the earlier version of this fix re-read the loser's row on the SAME
  // (now-aborted) transaction, which throws 25P02 instead of returning the
  // row -- this test fails against that version and passes against the
  // fixed one, which re-reads on a fresh `prisma` connection.
  it('lets the loser succeed as "already unlocked" instead of throwing, and charges exactly once', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await fund(fan, 10_000);
    const p = await makePpvPost(creator, 500);

    const [a, b] = await Promise.all([
      unlockPost(fan, p),
      unlockPost(fan, p),
    ]);

    // Both calls must resolve, not throw -- a genuine double-click is not an
    // error condition for the fan who clicked twice.
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    // Exactly one of the two actually ran the charge; the other reports
    // "already true" off the winner's row.
    const already = [a, b].filter((r: any) => r.already).length;
    expect(already).toBe(1);

    // The fan was charged exactly once (500 cents), not twice or zero times.
    const unlocks = await prisma.postUnlock.count({ where: { fanId: fan, postId: p.id } });
    expect(unlocks).toBe(1);
    const charges = await prisma.ledgerEntry.count({ where: { userId: fan, type: 'PPV', refId: p.id } });
    expect(charges).toBe(1);
  });

  // Direct proof of why the re-read has to use a fresh connection: forcing
  // the exact failure mode (query on an aborted transaction) the first
  // version of this fix silently reintroduced.
  it('a query on the SAME transaction after its own P2002 throws 25P02, not the row', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const p = await makePpvPost(creator, 500);
    await prisma.postUnlock.create({ data: { fanId: fan, postId: p.id } });

    let caught: any;
    try {
      await prisma.$transaction(async (tx) => {
        try {
          await tx.postUnlock.create({ data: { fanId: fan, postId: p.id } });
        } catch (e: any) {
          expect(e.code).toBe('P2002');
          // The bug: re-reading on the same `tx` whose previous statement
          // just failed. This must throw 25P02, proving the fix's comment
          // (and the reason the re-read must use `prisma`, not `tx`) is
          // correct rather than theoretical.
          return tx.postUnlock.findUnique({ where: { fanId_postId: { fanId: fan, postId: p.id } } });
        }
      });
    } catch (e) {
      caught = e;
    }
    // Prisma surfaces this as a PrismaClientUnknownRequestError (no `.code`
    // of its own) whose message carries the underlying Postgres SQLSTATE.
    expect(caught).toBeDefined();
    expect(String(caught.message)).toContain('25P02');
  });
});
