import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { charge, FEES, InsufficientFunds, money, PLATFORM_ID, post } from './ledger';

const prisma = new PrismaClient();

async function makeUser(opts: { referredById?: string } = {}) {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      email: `${id}@test.local`,
      username: `u_${id.slice(0, 8)}`,
      passwordHash: 'x',
      dob: new Date('2000-01-01'),
      referredById: opts.referredById,
    },
  });
  return id;
}

async function makeCreator(opts: { referredById?: string; payoutAsset?: 'USDC' | 'ONLYASS' } = {}) {
  const userId = await makeUser({ referredById: opts.referredById });
  await prisma.user.update({ where: { id: userId }, data: { role: 'CREATOR' } });
  await prisma.creatorProfile.create({
    data: { userId, displayName: 'Test Creator', payoutAsset: opts.payoutAsset ?? 'USDC' },
  });
  return userId;
}

async function fund(userId: string, cents: number) {
  await money(prisma, (tx) => post(tx, userId, cents, 'ADJUSTMENT'));
}

async function balanceOf(userId: string) {
  const acct = await prisma.account.findUnique({ where: { userId } });
  return acct?.balanceCents ?? 0n;
}

async function onlyAssBalanceOf(userId: string) {
  const acct = await prisma.account.findUnique({ where: { userId } });
  return acct?.onlyAssCents ?? 0n;
}

async function fundOnlyAss(userId: string, cents: number) {
  await money(prisma, (tx) => post(tx, userId, cents, 'DEPOSIT', undefined, undefined, 'ONLYASS'));
}

beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: {
      id: PLATFORM_ID,
      email: 'treasury@internal',
      username: '__platform__',
      passwordHash: 'x',
      role: 'ADMIN',
      dob: new Date('1970-01-01'),
    },
    update: {},
  });
  await prisma.account.upsert({ where: { userId: PLATFORM_ID }, create: { userId: PLATFORM_ID }, update: {} });
  // PlatformConfig is a true singleton (id 1), shared across every test in
  // this file -- reset it to the real default before each test so a test
  // that lowers the VIP threshold can't leak into whichever test runs next.
  await prisma.platformConfig.upsert({ where: { id: 1 }, create: { id: 1, vipBurnThresholdTokens: 10_000_000 }, update: { vipBurnThresholdTokens: 10_000_000 } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('ledger.charge', () => {
  it('splits a standard USDC-payout purchase 90/10', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 10_000);
    const platformBefore = await balanceOf(PLATFORM_ID);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-1' }),
    );

    expect(result).toEqual({ gross: 1000, fee: 100, net: 900, referral: 0, payAsset: 'USD' });
    expect(await balanceOf(fan)).toBe(9000n);
    expect(await balanceOf(creator)).toBe(900n);
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(100n);
  });

  it('charges a lower fee when the creator is paid out in $ONLYASS', async () => {
    const fan = await makeUser();
    const creator = await makeCreator({ payoutAsset: 'ONLYASS' });
    await fund(fan, 10_000);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-2' }),
    );

    expect(result.fee).toBe(80); // 8% instead of 10%
    expect(result.net).toBe(920);
  });

  it('pays the referrer a cut of the platform fee for a recently referred creator', async () => {
    const referrer = await makeUser();
    const fan = await makeUser();
    const creator = await makeCreator({ referredById: referrer });
    await fund(fan, 10_000);
    const platformBefore = await balanceOf(PLATFORM_ID);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-3' }),
    );

    expect(result.referral).toBe(50); // 5% of gross
    expect(await balanceOf(referrer)).toBe(50n);
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(50n); // fee(100) - referral(50)
  });

  it('does not pay a referral once the referral window has expired', async () => {
    const referrer = await makeUser();
    const fan = await makeUser();
    const creator = await makeCreator({ referredById: referrer });
    // Backdate the creator's account past the 12-month referral window.
    await prisma.user.update({
      where: { id: creator },
      data: { createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
    });
    await fund(fan, 10_000);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-4' }),
    );

    expect(result.referral).toBe(0);
    expect(await balanceOf(referrer)).toBe(0n);
  });

  it('pays the referrer a cut of the platform fee for a recently referred fan', async () => {
    const referrer = await makeUser();
    const fan = await makeUser({ referredById: referrer });
    const creator = await makeCreator();
    await fund(fan, 10_000);
    const platformBefore = await balanceOf(PLATFORM_ID);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-5' }),
    );

    expect(result.referral).toBe(50); // 5% of gross
    expect(await balanceOf(referrer)).toBe(50n);
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(50n); // fee(100) - referral(50)
  });

  it('does not pay a referral once the referred fan\'s window has expired', async () => {
    const referrer = await makeUser();
    const fan = await makeUser({ referredById: referrer });
    // Backdate the fan's account past the 12-month referral window.
    await prisma.user.update({
      where: { id: fan },
      data: { createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
    });
    const creator = await makeCreator();
    await fund(fan, 10_000);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-6' }),
    );

    expect(result.referral).toBe(0);
    expect(await balanceOf(referrer)).toBe(0n);
  });

  it('pays both referrers when both the fan and the creator were referred', async () => {
    const fanReferrer = await makeUser();
    const creatorReferrer = await makeUser();
    const fan = await makeUser({ referredById: fanReferrer });
    const creator = await makeCreator({ referredById: creatorReferrer });
    await fund(fan, 10_000);
    const platformBefore = await balanceOf(PLATFORM_ID);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-7' }),
    );

    expect(result.referral).toBe(100); // 5% + 5% of gross
    expect(await balanceOf(fanReferrer)).toBe(50n);
    expect(await balanceOf(creatorReferrer)).toBe(50n);
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(0n); // fee(100) - referral(100)
  });

  it('rejects a charge when the fan has insufficient balance, leaving all balances untouched', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 500);

    await expect(
      money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-5' })),
    ).rejects.toThrow(InsufficientFunds);

    expect(await balanceOf(fan)).toBe(500n);
    expect(await balanceOf(creator)).toBe(0n);
  });

  it('rejects a fan paying themselves', async () => {
    const fan = await makeUser();
    await prisma.user.update({ where: { id: fan }, data: { role: 'CREATOR' } });
    await prisma.creatorProfile.create({ data: { userId: fan, displayName: 'Self' } });
    await fund(fan, 10_000);

    await expect(
      money(prisma, (tx) => charge(tx, { fanId: fan, creatorId: fan, grossCents: 1000, type: 'TIP', refId: 'tip-6' })),
    ).rejects.toThrow('self_payment');
  });

  it('charges the fan\'s $ONLYASS balance at full price, with no discount, leaving the regular balance untouched', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 500); // regular balance -- should be left alone
    await fundOnlyAss(fan, 10_000);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-onlyass-1', payAsset: 'ONLYASS' }),
    );

    // Staking (not built yet) is meant to be the only fan-facing discount --
    // paying in $ONLYASS no longer discounts the charge on its own.
    expect(result.gross).toBe(1000);
    expect(result.fee).toBe(100); // 10% of the full 1000
    expect(result.net).toBe(900);
    expect(result.payAsset).toBe('ONLYASS');
    expect(await onlyAssBalanceOf(fan)).toBe(9000n); // 10,000 - 1000
    expect(await balanceOf(fan)).toBe(500n); // regular balance untouched
    expect(await balanceOf(creator)).toBe(900n);
  });

  it('rejects an $ONLYASS payment for insufficient $ONLYASS balance even when the regular balance could cover it', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 10_000); // plenty in the regular pool
    await fundOnlyAss(fan, 100); // not enough in the token pool

    await expect(
      money(prisma, (tx) =>
        charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-onlyass-2', payAsset: 'ONLYASS' }),
      ),
    ).rejects.toThrow(InsufficientFunds);

    expect(await balanceOf(fan)).toBe(10_000n); // untouched
    expect(await onlyAssBalanceOf(fan)).toBe(100n); // untouched
  });

  it('never lets two concurrent charges double-spend a balance that can only cover one', async () => {
    const fan = await makeUser();
    const creatorA = await makeCreator();
    const creatorB = await makeCreator();
    await fund(fan, 1000); // enough for exactly one 1000-cent charge

    const attempt = (creatorId: string, refId: string) =>
      money(prisma, (tx) => charge(tx, { fanId: fan, creatorId, grossCents: 1000, type: 'TIP', refId })).then(
        () => 'ok' as const,
        () => 'failed' as const,
      );

    const [a, b] = await Promise.all([attempt(creatorA, 'race-1'), attempt(creatorB, 'race-2')]);
    const outcomes = [a, b].sort();

    expect(outcomes).toEqual(['failed', 'ok']);
    expect(await balanceOf(fan)).toBe(0n);
  });

  it('gives a VIP fan (burned enough $ONLYASS) 10% off, regardless of which balance they pay from', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 10_000);
    await prisma.account.update({ where: { userId: fan }, data: { vipBurnedTokens: 10_000_000 } });

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-vip-1' }),
    );

    expect(result.gross).toBe(900); // 1000 - 10% VIP discount
    expect(result.fee).toBe(90);
    expect(result.net).toBe(810);
    expect(await balanceOf(fan)).toBe(10_000n - 900n);
    expect(await balanceOf(creator)).toBe(810n);
  });

  it('gives no discount to a fan who has burned some tokens but not enough to reach the threshold', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 10_000);
    await prisma.account.update({ where: { userId: fan }, data: { vipBurnedTokens: 9_999_999 } });

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-vip-2' }),
    );

    expect(result.gross).toBe(1000);
    expect(result.fee).toBe(100);
  });

  it('respects a lowered VIP threshold retroactively for a fan who already burned enough for the new bar', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 10_000);
    await prisma.account.update({ where: { userId: fan }, data: { vipBurnedTokens: 6_000_000 } });
    await prisma.platformConfig.upsert({ where: { id: 1 }, create: { id: 1, vipBurnThresholdTokens: 5_000_000 }, update: { vipBurnThresholdTokens: 5_000_000 } });

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-vip-3' }),
    );

    expect(result.gross).toBe(900); // now qualifies under the lowered 5,000,000 threshold
  });
});
