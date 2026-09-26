import { prisma } from '../lib/prisma.js';
import { money, post, PLATFORM_ID } from './ledger.js';

/** Midnight UTC of the day `now` falls on. */
export function utcDayStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 5000;

/**
 * Credits referral cuts to their referrers, one summed REFERRAL entry per
 * referrer per side (creator/fan referred) per UTC day, and only for days
 * that have ENDED.
 *
 * core/ledger.ts charge() holds each cut on the platform account and writes
 * a PendingReferral row instead of crediting the referrer per charge -- a
 * per-charge credit, visible in the referrer's balance, withdrawable amount,
 * earnings and spend outcomes, dated every purchase their referred friend
 * made. After this runs, everything the referrer can see about referrals
 * changes at most once per day, by the day's total.
 *
 * The referrer's row is stamped at the start of the day it was earned, so
 * GET /wallet/history's per-day rows and GET /auth/referral's total line up
 * with the day, not with when this happened to run. Each group is its own
 * transaction: its rows are claimed (settledAt IS NULL) in the same
 * transaction that moves the money, so two runs can never pay one row twice,
 * and one referrer whose posting fails is logged and retried next run
 * without holding up anyone else.
 *
 * Runs on the renewals tick (workers/renewals.ts). `referrerIds` narrows a
 * run (tests); `now` decides which days have ended.
 */
export async function settleReferrals(opts: { now?: Date; referrerIds?: string[]; log?: (...a: unknown[]) => void } = {}) {
  const cutoff = utcDayStart(opts.now ?? new Date());
  const log = opts.log ?? console.error;
  const rows = await prisma.pendingReferral.findMany({
    where: { settledAt: null, createdAt: { lt: cutoff }, ...(opts.referrerIds ? { referrerId: { in: opts.referrerIds } } : {}) },
    select: { referrerId: true, side: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });
  const groups = new Map<string, { referrerId: string; side: string; day: Date }>();
  for (const r of rows) {
    const day = utcDayStart(r.createdAt);
    groups.set(`${r.referrerId}|${r.side}|${day.getTime()}`, { referrerId: r.referrerId, side: r.side, day });
  }
  let settled = 0, cents = 0n;
  for (const g of groups.values()) {
    try {
      const got = await money(prisma, async (tx) => {
        const where = { settledAt: null, referrerId: g.referrerId, side: g.side, createdAt: { gte: g.day, lt: new Date(g.day.getTime() + DAY_MS) } };
        const pending = await tx.pendingReferral.findMany({ where, select: { id: true, amountCents: true } });
        if (!pending.length) return 0n;
        const claim = await tx.pendingReferral.updateMany({ where: { ...where, id: { in: pending.map((p) => p.id) } }, data: { settledAt: new Date() } });
        if (claim.count !== pending.length) throw new Error('referral_settle_conflict');
        const sum = pending.reduce((a, p) => a + p.amountCents, 0n);
        if (sum <= 0n) return 0n;
        const side = g.side === 'creator' || g.side === 'fan' ? g.side : undefined;
        const day = g.day.toISOString().slice(0, 10);
        await post(tx, PLATFORM_ID, -sum, 'REFERRAL', undefined, { settled: true, day, ...(side ? { for: side } : {}), referrerId: g.referrerId });
        await post(tx, g.referrerId, sum, 'REFERRAL', undefined, side ? { for: side } : undefined, 'CREDITS', { earned: true, at: g.day });
        return sum;
      });
      if (got > 0n) { settled++; cents += got; }
    } catch (e) {
      log('referrals: settling failed', g.referrerId, g.side, g.day.toISOString(), e);
    }
  }
  return { groups: settled, cents };
}
