import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { charge, creditDeposit, FEES, InsufficientFunds, money, PLATFORM_ID, post, splitDeposit } from './ledger';

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

async function makeCreator(opts: { referredById?: string; payoutAsset?: 'STABLE' | 'ONLYONE' } = {}) {
  const userId = await makeUser({ referredById: opts.referredById });
  await prisma.user.update({ where: { id: userId }, data: { role: 'CREATOR' } });
  await prisma.creatorProfile.create({
    data: { userId, displayName: 'Test Creator', payoutAsset: opts.payoutAsset ?? 'STABLE' },
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

async function onlyOneBalanceOf(userId: string) {
  const acct = await prisma.account.findUnique({ where: { userId } });
  return acct?.onlyOneCents ?? 0n;
}

async function fundOnlyOne(userId: string, cents: number) {
  await money(prisma, (tx) => post(tx, userId, cents, 'DEPOSIT', undefined, undefined, 'ONLYONE'));
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
  await prisma.platformConfig.upsert({ where: { id: 1 }, create: { id: 1, vipPriceCents: 2000, burnBps: 2500 }, update: { vipPriceCents: 2000, burnBps: 2500 } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('ledger.charge', () => {
  it('splits a standard USDG-payout purchase 90/10', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 10_000);
    const platformBefore = await balanceOf(PLATFORM_ID);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-1' }),
    );

    expect(result).toEqual({ gross: 1000, fee: 100, net: 900, referral: 0 });
    expect(await balanceOf(fan)).toBe(9000n);
    expect(await balanceOf(creator)).toBe(900n);
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(100n);
  });

  // The 8% token-payout rate is gone: the token is not a payout asset any
  // more (2026-09-18). A record that still carries the old value -- the Asset
  // enum can still express it, and a row written before the change would --
  // must not buy a cheaper fee through the back door.
  it('charges the standard 10% even for a creator record still set to an ONLYONE payout', async () => {
    const fan = await makeUser();
    const creator = await makeCreator({ payoutAsset: 'ONLYONE' });
    await fund(fan, 10_000);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-2' }),
    );

    expect(result.fee).toBe(100);
    expect(result.net).toBe(900);
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

  it('never pays out more in referrals than the fee it collected', async () => {
    const fanReferrer = await makeUser();
    const creatorReferrer = await makeUser();
    const fan = await makeUser({ referredById: fanReferrer });
    const creator = await makeCreator({ referredById: creatorReferrer });
    await fund(fan, 10_000);
    const platformBefore = await balanceOf(PLATFORM_ID);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-8' }),
    );

    // Two 5% referral cuts against a 10% fee is the exact-equality case: both
    // referrers are paid in full and the platform keeps nothing, but not a
    // cent more leaves than came in. Removing the 8% token-payout rate made
    // the over-claim unreachable by rate; the cap stays because it is the
    // invariant, and a future rate change must not be able to mint value.
    expect(result.fee).toBe(100);
    expect(result.referral).toBe(100);
    expect(await balanceOf(fanReferrer)).toBe(50n);
    expect(await balanceOf(creatorReferrer)).toBe(50n);
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(0n);
    // Nothing created from nothing: what left the fan is exactly what landed
    // in the creator's, the platform's and both referrers' balances.
    expect(await balanceOf(fan)).toBe(9000n);
    expect(await balanceOf(creator)).toBe(900n);
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

  // The token is a holding, not money. These two are the regression tests for
  // that: a fan sitting on a pile of $ONLYONE cannot buy anything with it, and
  // the token balance is never quietly reached for to cover a shortfall in
  // credits. If either of these ever starts passing for the wrong reason, the
  // token has become currency again.
  it('will not spend a fan\'s $ONLYONE balance on a charge, however large it is', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fundOnlyOne(fan, 1_000_000); // a fortune in tokens, no credits at all

    await expect(
      money(prisma, (tx) =>
        charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-onlyone-1' }),
      ),
    ).rejects.toThrow(InsufficientFunds);

    expect(await onlyOneBalanceOf(fan)).toBe(1_000_000n); // untouched
    expect(await balanceOf(creator)).toBe(0n);
  });

  it('does not top a short credit balance up out of the token balance', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 400); // 400 of credits against a 1000 charge
    await fundOnlyOne(fan, 10_000); // plenty of tokens beside it

    await expect(
      money(prisma, (tx) =>
        charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-onlyone-2' }),
      ),
    ).rejects.toThrow(InsufficientFunds);

    expect(await balanceOf(fan)).toBe(400n);
    expect(await onlyOneBalanceOf(fan)).toBe(10_000n);
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

  // Decided 2026-09-18: the platform keeps a flat 10% and NOTHING reduces it.
  // VIP is sold on perks alone. These three are the guard on that -- a
  // discount reappearing anywhere would show up here as a charge below list.
  it('charges a VIP member exactly the list price, like everyone else', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 10_000);
    const platformBefore = await balanceOf(PLATFORM_ID);
    await prisma.account.update({ where: { userId: fan }, data: { vipUntil: new Date(Date.now() + 86_400_000) } });

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-vip-1' }),
    );

    expect(result.gross).toBe(1000);
    expect(result.fee).toBe(100);
    expect(result.net).toBe(900);
    expect(await balanceOf(fan)).toBe(10_000n - 1000n);
    expect(await balanceOf(creator)).toBe(900n);
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(100n);
  });

  it('keeps the full platform cut regardless of VIP', async () => {
    const creator = await makeCreator();
    const platformBefore = await balanceOf(PLATFORM_ID);

    for (const [refId, vip] of [['flat-a', false], ['flat-b', true]] as const) {
      const fan = await makeUser();
      await fund(fan, 10_000);
      if (vip) await prisma.account.update({ where: { userId: fan }, data: { vipUntil: new Date(Date.now() + 86_400_000) } });
      const r = await money(prisma, (tx) =>
        charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId }),
      );
      expect(r.fee).toBe(100);
    }
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(200n);
  });

  it('charges a non-VIP the list price too', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 10_000);

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-vip-2' }),
    );

    expect(result.gross).toBe(1000);
    expect(result.fee).toBe(100);
  });

  // VIP is a membership now, not a permanent badge (decided 2026-09-18). An
  // expiry in the past must stop discounting -- a lapsed member who kept the
  // discount would be a paid feature nobody ever needs to renew.
  it('charges a lapsed VIP the list price', async () => {
    const fan = await makeUser();
    const creator = await makeCreator();
    await fund(fan, 10_000);
    await prisma.account.update({ where: { userId: fan }, data: { vipUntil: new Date(Date.now() - 1000) } });

    const result = await money(prisma, (tx) =>
      charge(tx, { fanId: fan, creatorId: creator, grossCents: 1000, type: 'TIP', refId: 'tip-vip-3' }),
    );

    expect(result.gross).toBe(1000);
    expect(result.fee).toBe(100);
  });
});

describe('ledger.creditDeposit (buy-credits fee)', () => {
  it('credits the deposit less 2% and pays the rest to the platform', async () => {
    const fan = await makeUser();
    const platformBefore = await balanceOf(PLATFORM_ID);

    const r = await money(prisma, (tx) => creditDeposit(tx, fan, 10_000n, 'dep-1'));

    expect(r.feeCents).toBe(200n); // 2% of $100
    expect(r.creditedCents).toBe(9_800n);
    expect(await balanceOf(fan)).toBe(9_800n);
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(200n);
  });

  // The float must never owe more than it holds. Taking the fee out of the
  // credited amount leaves the pool holding the full deposit against fewer
  // credits, which is the safe direction -- and the floor on the fee has to
  // keep it that way rather than rounding a cent into existence.
  it('never issues more credits than the dollars that arrived', async () => {
    for (const gross of [1n, 7n, 49n, 99n, 101n, 12_345n, 999_999n]) {
      const { creditedCents, feeCents } = splitDeposit(gross);
      expect(creditedCents + feeCents).toBe(gross);
      expect(creditedCents).toBeLessThanOrEqual(gross);
      expect(feeCents).toBeGreaterThanOrEqual(0n);
    }
  });

  it('posts no platform entry when the deposit is too small to round a fee', async () => {
    const fan = await makeUser();
    const platformBefore = await balanceOf(PLATFORM_ID);

    const r = await money(prisma, (tx) => creditDeposit(tx, fan, 10n, 'dep-2')); // 10c -> 0.2c fee

    expect(r.feeCents).toBe(0n);
    expect(r.creditedCents).toBe(10n);
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(0n);
  });

  it('matches the configured rate rather than a hardcoded 2%', async () => {
    const { feeCents } = splitDeposit(100_000n);
    expect(feeCents).toBe((100_000n * BigInt(FEES.DEPOSIT_BPS)) / 10_000n);
  });
});
