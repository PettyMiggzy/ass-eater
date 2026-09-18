import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, post, InsufficientFunds, BURNED_ID, PLATFORM_ID } from './ledger';
import { redis } from '../lib/redis';
import { burnTokens, getVipStatus, isVip } from './vip';

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
  await prisma.platformConfig.upsert({ where: { id: 1 }, create: { id: 1, vipBurnThresholdTokens: 10_000_000, vipBurnThresholdUsdCents: null }, update: { vipBurnThresholdTokens: 10_000_000, vipBurnThresholdUsdCents: null } });
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
    expect(status).toEqual({ burnedTokens: 0, thresholdTokens: 10_000_000, isVip: false, vipSince: null });
  });

  it('reflects the current threshold, not whatever it was when the fan burned', async () => {
    const fan = await makeUser();
    await fundOnlyAss(fan, 1_000_000_00);
    await money(prisma, (tx) => burnTokens(tx, fan, 6_000_000));

    await prisma.platformConfig.update({ where: { id: 1 }, data: { vipBurnThresholdTokens: 5_000_000, vipBurnThresholdUsdCents: null } });

    const status = await money(prisma, (tx) => getVipStatus(tx, fan));
    expect(status.burnedTokens).toBe(6_000_000);
    expect(status.thresholdTokens).toBe(5_000_000);
    expect(status.isVip).toBe(true);
    expect(status.vipSince).toBeInstanceOf(Date);
  });

  // VIP was sold as permanent -- "a club, not a subscription". Before vipSince
  // existed, isVip was recomputed live, so raising the bar took VIP away from
  // people who had already burned tokens they can never get back. Pricing the
  // bar in dollars would have made that routine: every dip in the token price
  // raises the token count and would have revoked everyone.
  it('never takes VIP away once it has been earned, however the bar moves afterwards', async () => {
    const fan = await makeUser();
    await fundOnlyAss(fan, 1_000_000_00);
    await money(prisma, (tx) => burnTokens(tx, fan, 6_000_000));
    await prisma.platformConfig.update({ where: { id: 1 }, data: { vipBurnThresholdTokens: 5_000_000, vipBurnThresholdUsdCents: null } });
    expect((await money(prisma, (tx) => getVipStatus(tx, fan))).isVip).toBe(true);

    // The bar is now far out of reach, and they have burned nothing more.
    await prisma.platformConfig.update({ where: { id: 1 }, data: { vipBurnThresholdTokens: 900_000_000, vipBurnThresholdUsdCents: null } });

    const status = await money(prisma, (tx) => getVipStatus(tx, fan));
    expect(status.burnedTokens).toBe(6_000_000);
    expect(status.thresholdTokens).toBe(900_000_000);
    expect(status.isVip).toBe(true);
    expect(await money(prisma, (tx) => isVip(tx, fan))).toBe(true);
  });

  // A fixed token count cannot survive supply: 10,000,000 against a
  // 1,000,000,000 supply caps the club at 100 members ever. The bar is a
  // dollar target instead, and the token count falls out of the live price.
  it('derives the bar from the dollar target and the live price', async () => {
    const price = Number(process.env.ONLYASS_PRICE_OVERRIDE);
    expect(price).toBeGreaterThan(0);
    // getUsdPrice caches for 30s in Redis, so a price-dependent assertion has
    // to clear it or it reads whatever an earlier test left behind.
    await redis.del('px:ONLYASS');
    await prisma.platformConfig.update({ where: { id: 1 }, data: { vipBurnThresholdUsdCents: 7500 } });

    const fan = await makeUser();
    const status = await money(prisma, (tx) => getVipStatus(tx, fan));
    expect(status.thresholdTokens).toBeCloseTo(75 / price, 6);
  });

  // Before the token has a pool there is no price. Failing to the fixed count
  // is the safe direction; failing to zero would hand VIP to everybody.
  it('falls back to the fixed count when no price is available', async () => {
    const saved = process.env.ONLYASS_PRICE_OVERRIDE;
    // A zero price is what a dead or empty pool reads as, and it is the
    // branch that matters: dividing by it would make the bar Infinity, and
    // treating it as valid would make the bar zero and hand VIP to everyone.
    process.env.ONLYASS_PRICE_OVERRIDE = '0';
    await redis.del('px:ONLYASS'); // else the cached good price hides the failure
    try {
      await prisma.platformConfig.update({ where: { id: 1 }, data: { vipBurnThresholdTokens: 250_000, vipBurnThresholdUsdCents: 7500 } });
      const fan = await makeUser();
      const status = await money(prisma, (tx) => getVipStatus(tx, fan));
      expect(status.thresholdTokens).toBe(250_000);
      expect(status.isVip).toBe(false);
    } finally {
      process.env.ONLYASS_PRICE_OVERRIDE = saved;
      await redis.del('px:ONLYASS');
    }
  });
});
