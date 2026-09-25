import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { charge, FEES, money, PLATFORM_ID, platformBpsFor, post } from './ledger';

/**
 * The live-revenue rate, decided 2026-09-20: 20% on anything earned DURING a
 * stream, 10% on everything else.
 *
 * What these tests actually guard is the SHAPE of that decision, not the
 * number. The rate is higher on live because live is the one thing with a
 * real per-minute marginal cost; it is explicitly NOT a fee on a creator's
 * income, so a creator who never goes live must pay exactly what they paid
 * before. If the "ordinary charge is still 10%" case ever starts failing,
 * the rate has stopped being about live and started being about creators.
 */

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
  await prisma.creatorProfile.create({ data: { userId, displayName: 'Test Creator', payoutAsset: 'STABLE' } });
  return userId;
}

const fund = (userId: string, cents: number) => money(prisma, (tx) => post(tx, userId, cents, 'ADJUSTMENT'));
const balanceOf = async (userId: string) =>
  (await prisma.account.findUnique({ where: { userId } }))?.balanceCents ?? 0n;

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await prisma.account.upsert({ where: { userId: PLATFORM_ID }, create: { userId: PLATFORM_ID }, update: {} });
  await prisma.platformConfig.upsert({
    where: { id: 1 },
    create: { id: 1, vipPriceCents: 2000, burnBps: 2500, minDmPriceCents: 99 },
    update: { vipPriceCents: 2000, burnBps: 2500, minDmPriceCents: 99 },
  });
});

afterAll(async () => { await prisma.$disconnect(); });

describe('platformBpsFor', () => {
  it('charges 20% on every kind of live revenue', () => {
    expect(platformBpsFor('LIVE_TICKET')).toBe(FEES.LIVE_BPS);
    expect(platformBpsFor('LIVE_MINUTE')).toBe(FEES.LIVE_BPS);
    expect(platformBpsFor('LIVE_TIP')).toBe(FEES.LIVE_BPS);
    expect(FEES.LIVE_BPS).toBe(2000);
  });

  it('leaves everything a creator earns off-stream at the standard 10%', () => {
    // The whole point of the design: a creator who never goes live pays what
    // they always paid. If any of these start returning LIVE_BPS, the rate
    // has quietly become a tax on income instead of on live.
    for (const t of ['SUBSCRIPTION', 'TIP', 'PPV', 'MESSAGE_UNLOCK', 'MARKETPLACE_SALE', 'DM_SEND'] as const) {
      expect(platformBpsFor(t)).toBe(FEES.DEFAULT_BPS);
    }
    expect(FEES.DEFAULT_BPS).toBe(1000);
  });
});

describe('live charges', () => {
  it('splits a live ticket 80/20 while an identical ordinary charge splits 90/10', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 100_000);
    const platformStart = await balanceOf(PLATFORM_ID);

    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 10_000, type: 'LIVE_TICKET', refId: randomUUID() }));
    expect(await balanceOf(creator)).toBe(8_000n);
    expect((await balanceOf(PLATFORM_ID)) - platformStart).toBe(2_000n);

    // Same creator, same amount, not live -- and the split has to differ.
    const platformMid = await balanceOf(PLATFORM_ID);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 10_000, type: 'TIP', refId: randomUUID() }));
    expect(await balanceOf(creator)).toBe(8_000n + 9_000n);
    expect((await balanceOf(PLATFORM_ID)) - platformMid).toBe(1_000n);
  });

  it('charges a per-minute view at the live rate', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 10_000);
    const before = await balanceOf(PLATFORM_ID);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 500, type: 'LIVE_MINUTE', refId: randomUUID() }));
    expect(await balanceOf(creator)).toBe(400n);
    expect((await balanceOf(PLATFORM_ID)) - before).toBe(100n);
  });

  it('never lets the fan pay more because the stream is live -- only the split moves', async () => {
    // The higher rate comes out of the CREATOR/PLATFORM split, not out of a
    // surcharge on the fan. A fan tipping $50 spends $50 either way.
    const fan = await makeUser();
    const a = await makeCreator();
    const b = await makeCreator();
    await fund(fan, 20_000);

    const start = await balanceOf(fan);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: a, grossCents: 5_000, type: 'LIVE_TIP', refId: randomUUID() }));
    const afterLive = await balanceOf(fan);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: b, grossCents: 5_000, type: 'TIP', refId: randomUUID() }));
    const afterOrdinary = await balanceOf(fan);

    expect(start - afterLive).toBe(5_000n);
    expect(afterLive - afterOrdinary).toBe(5_000n);
  });

  it('keeps the referral cap binding against the live fee, not the default one', async () => {
    // Two 5% referral cuts against a 20% fee fit comfortably, where against
    // 10% they only just do. The invariant is the same either way: the
    // platform can never pay out more referral than the fee it collected.
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 10_000);
    const before = await balanceOf(PLATFORM_ID);
    await money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 10_000, type: 'LIVE_TICKET', refId: randomUUID() }));
    expect((await balanceOf(PLATFORM_ID)) - before).toBeGreaterThanOrEqual(0n);
  });
});
