import { prisma } from '../lib/prisma.js';
import { charge, money } from './ledger.js';

/**
 * Per-minute live billing.
 *
 * A viewer's paid time is tracked server-side as `paidThrough` on their
 * latest LiveMinute row: each minute bought pushes it to
 * max(now, previous paidThrough) + 60s. POST /live/:id/join buys the first
 * minute (unless the viewer is rejoining inside time they already paid for),
 * POST /live/:id/minute buys the next one, and core/live-sweep.ts removes
 * anyone whose paidThrough has lapsed from the LiveKit room. Before this,
 * /join handed out a 2-hour token and billing was whatever the client chose
 * to call -- a viewer who never called /minute watched for free.
 */
export const MINUTE_MS = 60_000;
// A runaway client timer can't pre-buy more than this much time ahead.
export const MAX_PREPAID_MS = 10 * MINUTE_MS;

type Stream = { id: string; creatorId: string; perMinuteCents: number };

function effectivePaidThrough(row: { paidThrough: Date | null; createdAt: Date } | null): Date | null {
  if (!row) return null;
  return row.paidThrough ?? new Date(row.createdAt.getTime() + MINUTE_MS);
}

export async function paidThrough(fanId: string, streamId: string): Promise<Date | null> {
  const last = await prisma.liveMinute.findFirst({ where: { fanId, streamId }, orderBy: { minuteIndex: 'desc' } });
  return effectivePaidThrough(last);
}

/**
 * Buys the next minute. The minute number and the new paid-through time are
 * decided HERE from what the fan has already paid for -- never sent by the
 * client (a client-chosen index could be resent forever to watch free).
 */
export async function payNextMinute(fanId: string, s: Stream): Promise<{ paidMinutes: number; paidThrough: Date; charged: boolean }> {
  const last = await prisma.liveMinute.findFirst({ where: { fanId, streamId: s.id }, orderBy: { minuteIndex: 'desc' } });
  const prev = effectivePaidThrough(last);
  const now = Date.now();
  if (prev && prev.getTime() - now >= MAX_PREPAID_MS) {
    return { paidMinutes: (last?.minuteIndex ?? -1) + 1, paidThrough: prev, charged: false };
  }
  const idx = last ? last.minuteIndex + 1 : 0;
  const through = new Date(Math.max(now, prev?.getTime() ?? 0) + MINUTE_MS);

  try {
    await money(prisma, async (tx) => {
      await tx.liveMinute.create({
        data: { fanId, streamId: s.id, minuteIndex: idx, paidCents: s.perMinuteCents, paidThrough: through },
      });
      await charge(tx, {
        fanId, creatorId: s.creatorId, grossCents: s.perMinuteCents,
        type: 'LIVE_MINUTE', refId: `${s.id}:${idx}`,
      });
    });
  } catch (e) {
    // P2002 alone is NOT proof this fan already paid: charge() upserts shared
    // Account rows for the creator, the platform and any referrers, so two
    // DIFFERENT viewers billing at the same instant collide on those instead.
    // Only the fan's own row at this index proves it. Re-read on `prisma`,
    // never on the rolled-back transaction (see posts.ts unlockPost).
    if ((e as { code?: string }).code !== 'P2002') throw e;
    const mine = await prisma.liveMinute.findUnique({
      where: { fanId_streamId_minuteIndex: { fanId, streamId: s.id, minuteIndex: idx } },
    });
    if (!mine) throw e;
    return { paidMinutes: idx + 1, paidThrough: effectivePaidThrough(mine)!, charged: false };
  }
  return { paidMinutes: idx + 1, paidThrough: through, charged: true };
}

/** For /join: charge a minute only if the viewer isn't already inside paid time. */
export async function ensureMinutePaid(fanId: string, s: Stream) {
  const through = await paidThrough(fanId, s.id);
  if (through && through.getTime() > Date.now()) return { paidThrough: through, charged: false };
  const r = await payNextMinute(fanId, s);
  return { paidThrough: r.paidThrough, charged: r.charged };
}
