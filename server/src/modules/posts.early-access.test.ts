import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { earlyAccessFilter } from './posts';

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
async function makePost(creatorId: string, earlyHours: number | null) {
  return prisma.post.create({
    data: {
      creatorId,
      text: 'x',
      visibility: 'PUBLIC',
      vipEarlyUntil: earlyHours === null ? null : new Date(Date.now() + earlyHours * 3600_000),
    },
  });
}
/** Exactly what the route does: the filter, applied to this creator's posts. */
async function visibleTo(viewerId: string | null, creatorId: string) {
  const rows = await prisma.post.findMany({
    where: { creatorId, removed: false, ...(await earlyAccessFilter(viewerId)) },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
const makeVip = (userId: string) =>
  prisma.account.upsert({
    where: { userId },
    create: { userId, vipUntil: new Date(Date.now() + 86_400_000) },
    update: { vipUntil: new Date(Date.now() + 86_400_000) },
  });

beforeEach(async () => {});
afterAll(() => prisma.$disconnect());

describe('VIP early access', () => {
  it('hides a post inside its window from a non-VIP, and shows it to a VIP', async () => {
    const creator = await makeCreator();
    const early = await makePost(creator, 24);
    const normal = await makePost(creator, null);

    const outsider = await makeUser();
    expect(await visibleTo(outsider, creator)).toEqual([normal.id]);

    const member = await makeUser();
    await makeVip(member);
    expect((await visibleTo(member, creator)).sort()).toEqual([early.id, normal.id].sort());
  });

  // A redacted row still announces that something exists, when it landed and
  // roughly how big it is -- which is most of what the window is selling. The
  // post must not be in the result set at all.
  it('leaves the post out of the result entirely rather than returning it locked', async () => {
    const creator = await makeCreator();
    await makePost(creator, 24);
    const outsider = await makeUser();

    expect(await visibleTo(outsider, creator)).toHaveLength(0);
  });

  it('shows it to everyone once the window has passed', async () => {
    const creator = await makeCreator();
    const expired = await prisma.post.create({
      data: { creatorId: creator, text: 'x', visibility: 'PUBLIC', vipEarlyUntil: new Date(Date.now() - 1000) },
    });
    const outsider = await makeUser();

    expect(await visibleTo(outsider, creator)).toEqual([expired.id]);
  });

  it('always shows a creator their own post inside its window', async () => {
    const creator = await makeCreator();
    const early = await makePost(creator, 24);

    expect(await visibleTo(creator, creator)).toEqual([early.id]);
  });

  it('hides it from a signed-out visitor', async () => {
    const creator = await makeCreator();
    await makePost(creator, 24);

    expect(await visibleTo(null, creator)).toHaveLength(0);
  });

  // A membership that has run out must stop letting someone in, or the perk
  // is permanent again by accident.
  it('hides it from a member whose VIP has lapsed', async () => {
    const creator = await makeCreator();
    await makePost(creator, 24);
    const lapsed = await makeUser();
    await prisma.account.upsert({
      where: { userId: lapsed },
      create: { userId: lapsed, vipUntil: new Date(Date.now() - 1000) },
      update: { vipUntil: new Date(Date.now() - 1000) },
    });

    expect(await visibleTo(lapsed, creator)).toHaveLength(0);
  });
});
