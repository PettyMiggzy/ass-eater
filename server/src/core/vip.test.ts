import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { money, post, isVip, InsufficientFunds, PLATFORM_ID } from './ledger';
import { subscribeVip, getVipStatus, pendingBurnCents, VIP_PERIOD_MS } from './vip';

const prisma = new PrismaClient();

async function makeUser() {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      email: `${id}@test.local`,
      username: `u_${id.slice(0, 8)}`,
      passwordHash: 'x',
      dob: new Date('2000-01-01'),
    },
  });
  return id;
}
async function fund(userId: string, cents: number) {
  await money(prisma, (tx) => post(tx, userId, cents, 'DEPOSIT'));
}
const balanceOf = async (userId: string) =>
  (await prisma.account.findUnique({ where: { userId }, select: { balanceCents: true } }))?.balanceCents ?? 0n;

// No deletes: test files run in parallel workers against one database, and
// wiping users cascades into rows another file is mid-way through using. Every
// test makes its own random user instead, and assertions are scoped to it.
beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await prisma.account.upsert({ where: { userId: PLATFORM_ID }, create: { userId: PLATFORM_ID }, update: {} });
  await prisma.platformConfig.upsert({
    where: { id: 1 },
    create: { id: 1, vipPriceCents: 2000, vipBurnBps: 10_000 },
    update: { vipPriceCents: 2000, vipBurnBps: 10_000 },
  });
});

/** Burn obligations from this fan only -- the table is shared across tests. */
async function burnsFor(userId: string) {
  return prisma.tokenBurn.findMany({ where: { refId: userId } });
}
afterAll(() => prisma.$disconnect());

describe('vip.subscribeVip', () => {
  it('charges the monthly price in credits and grants a month', async () => {
    const fan = await makeUser();
    await fund(fan, 5_000);

    const r = await money(prisma, (tx) => subscribeVip(tx, fan));

    expect(r.priceCents).toBe(2000);
    expect(r.isVip).toBe(true);
    expect(await balanceOf(fan)).toBe(3_000n);
    expect(await money(prisma, (tx) => isVip(tx, fan))).toBe(true);
    // ~30 days out, allowing for the seconds the test itself takes.
    expect(r.vipUntil.getTime() - Date.now()).toBeGreaterThan(VIP_PERIOD_MS - 60_000);
  });

  it('refuses when the fan cannot cover it, and changes nothing', async () => {
    const fan = await makeUser();
    await fund(fan, 1_999);

    await expect(money(prisma, (tx) => subscribeVip(tx, fan))).rejects.toThrow(InsufficientFunds);

    expect(await balanceOf(fan)).toBe(1_999n);
    expect(await money(prisma, (tx) => isVip(tx, fan))).toBe(false);
    // The burn obligation must not exist for a charge that never happened.
    expect(await burnsFor(fan)).toHaveLength(0);
  });

  // Paying early should add a month, not throw away the remainder of the one
  // already paid for -- otherwise renewing on the 20th silently costs 10 days.
  it('extends from the existing expiry rather than from today', async () => {
    const fan = await makeUser();
    await fund(fan, 10_000);

    const first = await money(prisma, (tx) => subscribeVip(tx, fan));
    const second = await money(prisma, (tx) => subscribeVip(tx, fan));

    expect(second.vipUntil.getTime() - first.vipUntil.getTime()).toBeCloseTo(VIP_PERIOD_MS, -3);
  });

  // A lapsed member restarts from today; they do not get credited for the
  // months they were not paying.
  it('restarts from today when the membership already lapsed', async () => {
    const fan = await makeUser();
    await fund(fan, 10_000);
    await prisma.account.upsert({ where: { userId: fan }, create: { userId: fan }, update: {} });
    await prisma.account.update({ where: { userId: fan }, data: { vipUntil: new Date(Date.now() - 90 * 86_400_000) } });

    const r = await money(prisma, (tx) => subscribeVip(tx, fan));

    expect(r.vipUntil.getTime()).toBeGreaterThan(Date.now() + VIP_PERIOD_MS - 60_000);
  });
});

describe('vip token burn obligation', () => {
  // The whole point of charging dollars instead of asking fans to burn: the
  // revenue still has to reach the market and destroy supply. Recording the
  // obligation in the same transaction as the charge is what stops a crash
  // from silently keeping the money and never buying the tokens -- the one
  // failure nobody would notice, because the fan still gets their badge.
  it('records the burn obligation in the same transaction as the charge', async () => {
    const fan = await makeUser();
    await fund(fan, 5_000);

    await money(prisma, (tx) => subscribeVip(tx, fan));

    const rows = await burnsFor(fan);
    expect(rows).toHaveLength(1);
    expect(rows[0].usdCents).toBe(2000n);
    expect(rows[0].reason).toBe('vip');
    expect(rows[0].executedAt).toBeNull();
    // The global tally counts it too.
    expect(await money(prisma, (tx) => pendingBurnCents(tx))).toBeGreaterThanOrEqual(2000n);
  });

  it('commits only the configured share of revenue to the burn', async () => {
    await prisma.platformConfig.update({ where: { id: 1 }, data: { vipBurnBps: 5000 } });
    const fan = await makeUser();
    await fund(fan, 5_000);

    const platformBefore = await balanceOf(PLATFORM_ID);
    const r = await money(prisma, (tx) => subscribeVip(tx, fan));

    expect(r.committedToBurnCents).toBe(1000);
    const rows = await burnsFor(fan);
    expect(rows).toHaveLength(1);
    expect(rows[0].usdCents).toBe(1000n);
    // The platform still collected the whole $20 -- half is just earmarked.
    expect((await balanceOf(PLATFORM_ID)) - platformBefore).toBe(2000n);
  });

  it('commits nothing when the burn share is set to zero', async () => {
    await prisma.platformConfig.update({ where: { id: 1 }, data: { vipBurnBps: 0 } });
    const fan = await makeUser();
    await fund(fan, 5_000);

    await money(prisma, (tx) => subscribeVip(tx, fan));

    expect(await burnsFor(fan)).toHaveLength(0);
  });
});
