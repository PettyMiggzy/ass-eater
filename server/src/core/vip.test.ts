import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, post, InsufficientFunds, BURNED_ID, PLATFORM_ID } from './ledger';
import { burnTokens, getVipStatus } from './vip';

// ONLYASS_PRICE_OVERRIDE must be set (see .env) so getUsdPrice('ONLYASS')
// doesn't try a real RPC call -- these tests fix it at $0.01/token via that
// override so the USD-cents math below is exact and deterministic.
const PRICE = 0.01;

const prisma = new PrismaClient();

async function makeUser() {
  const id = randomUUID();
  await prisma.user.create({
    data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01') },
  });
  return id;
}

async function fundOnlyAss(userId: string, cents: number) {
  await money(prisma, (tx) => post(tx, userId, cents, 'DEPOSIT', undefined, undefined, 'ONLYASS'));
}

async function onlyAssBalanceOf(userId: string) {
  const acct = await prisma.account.findUnique({ where: { userId } });
  return acct?.onlyAssCents ?? 0n;
}

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: BURNED_ID },
    create: { id: BURNED_ID, email: 'burned@internal', username: '__burned__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await prisma.platformConfig.upsert({ where: { id: 1 }, create: { id: 1, vipBurnThresholdTokens: 10_000_000 }, update: { vipBurnThresholdTokens: 10_000_000 } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('vip.burnTokens', () => {
  it('debits the fan\'s $ONLYASS balance at the live price and credits BURNED_ID, not any user', async () => {
    const fan = await makeUser();
    await fundOnlyAss(fan, 100_000_00); // $100,000 of $ONLYASS balance

    const burnedBefore = await onlyAssBalanceOf(BURNED_ID);
    const result = await money(prisma, (tx) => burnTokens(tx, fan, 1_000_000)); // 1,000,000 tokens @ $0.01 = $10,000

    expect(result.usdCentsSpent).toBe(10_000_00);
    expect(await onlyAssBalanceOf(fan)).toBe(100_000_00n - 10_000_00n);
    expect((await onlyAssBalanceOf(BURNED_ID)) - burnedBefore).toBe(10_000_00n);
    expect(result.burnedTokens).toBe(1_000_000);
    expect(result.isVip).toBe(false); // threshold is 10,000,000
  });

  it('does not touch the regular USD balance, only the $ONLYASS-funded one', async () => {
    const fan = await makeUser();
    await money(prisma, (tx) => post(tx, fan, 5_000_00, 'ADJUSTMENT'));
    await fundOnlyAss(fan, 100_000_00);

    await money(prisma, (tx) => burnTokens(tx, fan, 1_000_000));

    const acct = await prisma.account.findUnique({ where: { userId: fan } });
    expect(acct?.balanceCents).toBe(5_000_00n);
  });

  it('rejects burning more $ONLYASS-value than the fan actually has, leaving balances untouched', async () => {
    const fan = await makeUser();
    await fundOnlyAss(fan, 100_00); // $100 worth -- not enough for a 1,000,000-token ($10,000) burn

    await expect(money(prisma, (tx) => burnTokens(tx, fan, 1_000_000))).rejects.toThrow(InsufficientFunds);
    expect(await onlyAssBalanceOf(fan)).toBe(100_00n);
  });

  it('rejects a zero or negative token amount', async () => {
    const fan = await makeUser();
    await fundOnlyAss(fan, 100_000_00);
    await expect(money(prisma, (tx) => burnTokens(tx, fan, 0))).rejects.toThrow('invalid_amount');
    await expect(money(prisma, (tx) => burnTokens(tx, fan, -5))).rejects.toThrow('invalid_amount');
  });

  it('accumulates across multiple burns until the threshold is crossed', async () => {
    const fan = await makeUser();
    await fundOnlyAss(fan, 1_000_000_00);

    let status = await money(prisma, (tx) => burnTokens(tx, fan, 6_000_000));
    expect(status.isVip).toBe(false);

    status = await money(prisma, (tx) => burnTokens(tx, fan, 4_000_000));
    expect(status.burnedTokens).toBe(10_000_000);
    expect(status.isVip).toBe(true);
  });
});

describe('vip.getVipStatus', () => {
  it('reports not-VIP with zero burned tokens for a fan who has never burned', async () => {
    const fan = await makeUser();
    const status = await money(prisma, (tx) => getVipStatus(tx, fan));
    expect(status).toEqual({ burnedTokens: 0, thresholdTokens: 10_000_000, isVip: false });
  });

  it('reflects the current threshold, not whatever it was when the fan burned', async () => {
    const fan = await makeUser();
    await fundOnlyAss(fan, 1_000_000_00);
    await money(prisma, (tx) => burnTokens(tx, fan, 6_000_000));

    await prisma.platformConfig.update({ where: { id: 1 }, data: { vipBurnThresholdTokens: 5_000_000 } });

    const status = await money(prisma, (tx) => getVipStatus(tx, fan));
    expect(status).toEqual({ burnedTokens: 6_000_000, thresholdTokens: 5_000_000, isVip: true });
  });
});
