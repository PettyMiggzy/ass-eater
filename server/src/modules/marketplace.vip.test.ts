import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { vipFirstLookFilter } from './marketplace';

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
  await prisma.user.update({ where: { id: userId }, data: { role: 'CREATOR', kycStatus: 'APPROVED' } });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'C' } });
  return userId;
}
const makeVip = (userId: string) =>
  prisma.account.upsert({
    where: { userId },
    create: { userId, vipUntil: new Date(Date.now() + 86_400_000) },
    update: { vipUntil: new Date(Date.now() + 86_400_000) },
  });
async function makeListing(creatorId: string, earlyHours: number | null) {
  return prisma.listing.create({
    data: {
      creatorId, title: 'T', priceCents: 1000, status: 'ACTIVE',
      vipEarlyUntil: earlyHours === null ? null : new Date(Date.now() + earlyHours * 3600_000),
    },
  });
}
/** Exactly what GET /listings does, scoped to one creator's listings. */
async function visibleTo(viewerId: string | null, creatorId: string) {
  const early = await vipFirstLookFilter(viewerId);
  const conditions: any[] = [early].filter((c) => Object.keys(c).length);
  const rows = await prisma.listing.findMany({
    where: { status: 'ACTIVE', creatorId, ...(conditions.length ? { AND: conditions } : {}) },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

afterAll(() => prisma.$disconnect());

describe('VIP marketplace first look', () => {
  it('hides a listing inside its window from a non-VIP and shows it to a VIP', async () => {
    const creator = await makeCreator();
    const early = await makeListing(creator, 24);
    const open = await makeListing(creator, null);

    expect(await visibleTo(await makeUser(), creator)).toEqual([open.id]);

    const member = await makeUser();
    await makeVip(member);
    expect((await visibleTo(member, creator)).sort()).toEqual([early.id, open.id].sort());
  });

  it('hides it from a signed-out visitor', async () => {
    const creator = await makeCreator();
    await makeListing(creator, 24);
    expect(await visibleTo(null, creator)).toHaveLength(0);
  });

  it('shows it to everyone once the window passes', async () => {
    const creator = await makeCreator();
    const past = await prisma.listing.create({
      data: { creatorId: creator, title: 'T', priceCents: 1000, status: 'ACTIVE', vipEarlyUntil: new Date(Date.now() - 1000) },
    });
    expect(await visibleTo(await makeUser(), creator)).toEqual([past.id]);
  });

  it('always shows a creator their own listing inside the window', async () => {
    const creator = await makeCreator();
    const early = await makeListing(creator, 24);
    expect(await visibleTo(creator, creator)).toEqual([early.id]);
  });

  it('hides it from a member whose VIP has lapsed', async () => {
    const creator = await makeCreator();
    await makeListing(creator, 24);
    const lapsed = await makeUser();
    await prisma.account.upsert({
      where: { userId: lapsed },
      create: { userId: lapsed, vipUntil: new Date(Date.now() - 1000) },
      update: { vipUntil: new Date(Date.now() - 1000) },
    });
    expect(await visibleTo(lapsed, creator)).toHaveLength(0);
  });

  // The filter is AND-ed with the search clause. Spreading a second `OR` key
  // would replace the first, quietly returning listings a search excluded --
  // or leaking the window. This is the regression test for that shape.
  it('composes with a search clause instead of replacing it', async () => {
    const creator = await makeCreator();
    const open = await prisma.listing.create({
      data: { creatorId: creator, title: 'blue hoodie', priceCents: 1000, status: 'ACTIVE' },
    });
    await prisma.listing.create({
      data: { creatorId: creator, title: 'red cap', priceCents: 1000, status: 'ACTIVE' },
    });
    await makeListing(creator, 24); // hidden, title 'T'

    const conditions: any[] = [await vipFirstLookFilter(await makeUser())].filter((c) => Object.keys(c).length);
    conditions.push({ OR: [{ title: { contains: 'hoodie', mode: 'insensitive' } }] });
    const rows = await prisma.listing.findMany({
      where: { status: 'ACTIVE', creatorId: creator, AND: conditions }, select: { id: true },
    });

    expect(rows.map((r) => r.id)).toEqual([open.id]);
  });
});
