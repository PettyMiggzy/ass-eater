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

  it('gives a 10% discount when the fan pays out of their $ONLYASS balance, leaving the regular balance untouched', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 500); // regular balance -- should be left alone
    await fundOnlyAss(fan, 10_000);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-onlyass-1', payAsset: 'ONLYASS' }),
    );

    expect(result.gross).toBe(900); // 1000 - 10% token-payment discount
    expect(result.fee).toBe(90); // 10% of the discounted 900
    expect(result.net).toBe(810);
    expect(result.payAsset).toBe('ONLYASS');
    expect(await onlyAssBalanceOf(fan)).toBe(9100n); // 10,000 - 900
    expect(await balanceOf(fan)).toBe(500n); // regular balance untouched
    expect(await balanceOf(creator)).toBe(810n);
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
});
