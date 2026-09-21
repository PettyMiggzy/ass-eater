import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { charge, money, PLATFORM_ID, getTopSupporters, post } from './ledger';

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
const makeVip = (userId: string) =>
  prisma.account.upsert({
    where: { userId },
    create: { userId, vipUntil: new Date(Date.now() + 86_400_000) },
    update: { vipUntil: new Date(Date.now() + 86_400_000) },
  });

afterAll(() => prisma.$disconnect());

describe('getTopSupporters', () => {
  it('ranks VIP fans by total spend with that creator, highest first', async () => {
    const creator = await makeCreator();
    const bigSpender = await makeUser();
    const smallSpender = await makeUser();
    await fund(bigSpender, 10_000);
    await fund(smallSpender, 10_000);
    await makeVip(bigSpender);
    await makeVip(smallSpender);

    await money(prisma, (tx) => charge(tx, { fanId: bigSpender, creatorId: creator, grossCents: 5000, type: 'TIP', refId: 'a' }));
    await money(prisma, (tx) => charge(tx, { fanId: smallSpender, creatorId: creator, grossCents: 500, type: 'TIP', refId: 'b' }));

    const top = await money(prisma, (tx) => getTopSupporters(tx, creator, 10));
    const ids = top.map((r) => r.fanId);
    expect(ids.indexOf(bigSpender)).toBeLessThan(ids.indexOf(smallSpender));
  });

  // The entire point of the perk: a non-VIP does not appear regardless of
  // how much money they have put in.
  it('excludes a non-VIP fan no matter how much they spent', async () => {
    const creator = await makeCreator();
    const whale = await makeUser();
    await fund(whale, 100_000);
    await money(prisma, (tx) => charge(tx, { fanId: whale, creatorId: creator, grossCents: 50_000, type: 'TIP', refId: 'whale-1' }));

    const top = await money(prisma, (tx) => getTopSupporters(tx, creator, 10));
    expect(top.map((r) => r.fanId)).not.toContain(whale);
  });

  it('excludes a fan whose VIP has lapsed', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await fund(fan, 10_000);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 5000, type: 'TIP', refId: 'lapsed-1' }));
    await prisma.account.update({ where: { userId: fan }, data: { vipUntil: new Date(Date.now() - 1000) } });

    const top = await money(prisma, (tx) => getTopSupporters(tx, creator, 10));
    expect(top.map((r) => r.fanId)).not.toContain(fan);
  });

  // Money the creator earns that is NOT a fan paying them -- there is no
  // realistic path to this, but the query must never accidentally group a
  // payout, a platform fee, or a referral cut in with fan spend.
  it('never counts non-charge ledger types as supporter spend', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await makeVip(fan);
    // A REFERRAL credit landing on the creator, with fanId in meta by
    // coincidence of shape -- must not be picked up as "fan spend".
    await money(prisma, (tx) => post(tx, creator, 999_999, 'REFERRAL', 'not-a-charge', { fanId: fan }));

    const top = await money(prisma, (tx) => getTopSupporters(tx, creator, 10));
    expect(top.map((r) => r.fanId)).not.toContain(fan);
  });

  it('sums multiple payments from the same fan rather than counting the latest only', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await fund(fan, 10_000);
    await makeVip(fan);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'sum-1' }));
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 2000, type: 'TIP', refId: 'sum-2' }));

    const top = await money(prisma, (tx) => getTopSupporters(tx, creator, 10));
    const row = top.find((r) => r.fanId === fan);
    expect(row?.totalCents).toBe(2700); // 90% net of 1000 + 90% net of 2000
  });

  // FAN_CHARGE_TYPES was written before DM_SEND/LIVE_MINUTE/LIVE_TIP existed
  // as fan-to-creator TxTypes and was never updated -- a fan who only ever
  // paid a creator through live tipping or a priced DM was invisible to this
  // perk however much they'd spent. Regression test for that fix.
  it('counts DM_SEND, LIVE_MINUTE and LIVE_TIP as real supporter spend', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    await fund(fan, 10_000);
    await makeVip(fan);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 100, type: 'DM_SEND', refId: 'dm-1' }));
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 200, type: 'LIVE_MINUTE', refId: 'lm-1' }));
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 300, type: 'LIVE_TIP', refId: 'lt-1' }));

    const top = await money(prisma, (tx) => getTopSupporters(tx, creator, 10));
    expect(top.map((r) => r.fanId)).toContain(fan);
  });

  it('never returns supporters belonging to a different creator', async () => {
    const creatorA = await makeCreator();
    const creatorB = await makeCreator();
    const fan = await makeUser();
    await fund(fan, 10_000);
    await makeVip(fan);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creatorA, grossCents: 1000, type: 'TIP', refId: 'cross-1' }));

    const topB = await money(prisma, (tx) => getTopSupporters(tx, creatorB, 10));
    expect(topB.map((r) => r.fanId)).not.toContain(fan);
  });
});
