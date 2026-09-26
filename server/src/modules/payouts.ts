import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isAddress } from 'viem';
import { prisma } from '../lib/prisma.js';
import { money, reserveWithdrawable, post, FEES, postPlatformRevenue } from '../core/ledger.js';
import { payoutJobOptions } from '../core/payout-queue.js';
import { payoutQueue } from '../lib/redis.js';

type PayoutRow = Awaited<ReturnType<typeof prisma.payout.findUniqueOrThrow>>;
const publicPayout = (p: PayoutRow) => ({ ...p, amountCents: Number(p.amountCents), feeCents: Number(p.feeCents) });

/**
 * The payout an earlier request with this requestId already created, or
 * null. A requestId reused for a DIFFERENT cash-out (another amount, or
 * instant flipped) is a client bug, not a retry: answering "already" would
 * tell the creator a withdrawal went through that never did -- refused, like
 * a tip's idempotency_key_reused. The requested amount is net + fee.
 */
export async function priorPayout(creatorId: string, requestId: string, amountCents: number, instant: boolean): Promise<PayoutRow | null> {
  const prior = await prisma.payout.findUnique({ where: { creatorId_requestId: { creatorId, requestId } } });
  if (!prior) return null;
  if (Number(prior.amountCents + prior.feeCents) !== amountCents || prior.instant !== instant) {
    throw Object.assign(new Error('request_id_reused'), { statusCode: 409 });
  }
  return prior;
}

/**
 * Reserves the creator's earned credits and creates one PENDING payout, at
 * most once per (creator, requestId).
 *
 * Cash-out used to take no request id: a double tap, or a retry after a lost
 * response, created a second payout that reserved more earned credits and
 * charged the flat withdrawal fee (plus the percentage) a second time --
 * fees nobody could get back. The Payout row carrying the requestId is now
 * inserted FIRST in the money() transaction, before anything is reserved: a
 * concurrent duplicate collides on the unique (creatorId, requestId) index
 * and rolls back with nothing reserved, and a duplicate re-run after a
 * serialization retry collides with the committed original before it could
 * be refused as insufficient funds. As in tips.ts chargeTip, the re-read
 * that decides runs on `prisma`, never on the aborted transaction.
 */
export async function requestPayout(
  creatorId: string,
  p: { requestId: string; amountCents: number; instant: boolean; address: string },
): Promise<{ payout: PayoutRow; already: boolean }> {
  const { requestId, amountCents, instant } = p;
  // Instant/on-demand payout costs an extra 2% on top of the normal withdrawal
  // fee, for every creator. It used to be waived whenever the token-lock
  // perk was switched on -- but that perk is a free, instant toggle
  // (modules/stake.ts PATCH /me/perk) with no fan required, so any creator
  // could flip it on, cash out fee-free and flip it off again. Until the
  // owner picks a waiver rule that costs something or reflects real use
  // (e.g. an ACTIVE TokenLock at payout time, or the perk enabled for N
  // days), the fee is charged unconditionally.
  const instantBps = instant ? FEES.INSTANT_PAYOUT_BPS : 0;
  const fee = FEES.WITHDRAWAL_FLAT_CENTS + Math.floor((amountCents * (FEES.WITHDRAWAL_BPS + instantBps)) / 10_000);
  const net = amountCents - fee;
  if (net <= 0) throw Object.assign(new Error('amount_too_small'), { statusCode: 400 });
  try {
    const payout = await money(prisma, async (tx) => {
      const created = await tx.payout.create({ data: { creatorId, requestId, asset: 'STABLE', address: p.address, instant, amountCents: BigInt(net), feeCents: BigInt(fee) } });
      // Closed loop: only EARNED credits are payable. Deposited (bought)
      // credits are spendable here and never withdrawn -- otherwise a
      // "creator" could deposit ETH or stablecoin and cash it straight back
      // out, turning the platform into an exchange desk. This reserves the
      // amount out of withdrawableCents under the row lock.
      await reserveWithdrawable(tx, creatorId, amountCents);
      await post(tx, creatorId, -amountCents, 'PAYOUT', created.id, { fee, net, instant });
      await postPlatformRevenue(tx, fee, created.id, { source: 'withdrawal' });
      return created;
    });
    return { payout, already: false };
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    // P2002 alone is not proof: post() upserts shared Account rows. Only
    // this creator's own row for this requestId decides.
    const prior = await priorPayout(creatorId, requestId, amountCents, instant);
    if (!prior) throw e;
    return { payout: prior, already: true };
  }
}

export const payouts: FastifyPluginAsync = async (app) => {
  app.post('/', { preHandler: app.creatorOk }, async (req, reply) => {
    const { amountCents, instant, requestId } = z.object({
      amountCents: z.number().int().min(FEES.MIN_PAYOUT_CENTS), instant: z.boolean().default(false),
      // A fresh uuid per cash-out the creator intends, REUSED on any retry of
      // that same cash-out -- see requestPayout(). Required: a payout without
      // one cannot be told apart from a second payout.
      requestId: z.string().uuid(),
    }).parse(req.body);
    // A retry of a request that already went through answers first, before
    // the checks below: the first request passed them, and a freeze or
    // address change since must not turn "it went through" into an error.
    const earlier = await priorPayout(req.user.id, requestId, amountCents, instant);
    if (earlier) return { ...publicPayout(earlier), already: true, queued: true };
    const c = await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: req.user.id } });
    if (c.payoutsFrozen) return reply.code(403).send({ error: 'payouts_frozen' });
    if (!c.payoutAddress || !isAddress(c.payoutAddress)) return reply.code(400).send({ error: 'no_payout_address' });
    // USDG only (decided): an older row still set to ETH must change it first.
    if (c.payoutAsset !== 'STABLE') return reply.code(400).send({ error: 'payout_asset_unsupported' });

    const { payout: p, already } = await requestPayout(req.user.id, { requestId, amountCents, instant, address: c.payoutAddress! });
    if (already) return { ...publicPayout(p), already: true, queued: true };
    // Outside the money transaction, so a Redis failure here cannot be
    // allowed to strand the payout: it is already PENDING with the creator
    // debited. The deterministic jobId plus the reconciler in
    // workers/payout-worker.ts (which re-queues PENDING payouts a few minutes
    // old) mean it still goes out; the creator is told it is queued either way.
    let queued = true;
    try {
      await payoutQueue.add('send', { payoutId: p.id }, payoutJobOptions(p.id, instant));
    } catch (err) {
      queued = false;
      req.log.error({ err, payoutId: p.id }, 'payout enqueue failed; the reconciler will re-queue it');
    }
    return { ...publicPayout(p), queued };
  });

  app.get('/', { preHandler: app.creatorOk }, async (req) => {
    const rows = await prisma.payout.findMany({ where: { creatorId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(r => ({ ...r, amountCents: Number(r.amountCents), feeCents: Number(r.feeCents) }));
  });

  // REFERRAL is credited once per ended UTC day as that day's total
  // (core/referrals.ts); it is also cut off at today's start here, like
  // GET /wallet/history and /auth/referral, so a total polled through the
  // day can never date a referred friend's individual purchases.
  app.get('/earnings', { preHandler: app.creatorOk }, async (req) => {
    const rows = await prisma.$queryRaw<{ type: string; total: bigint }[]>`
      SELECT type, SUM("amountCents") AS total FROM "LedgerEntry"
      WHERE "userId"=${req.user.id} AND "amountCents">0 AND "createdAt" > now() - interval '30 days'
        AND (type <> 'REFERRAL' OR "createdAt" < date_trunc('day', now() AT TIME ZONE 'UTC'))
      GROUP BY type`;
    return Object.fromEntries(rows.map(r => [r.type, Number(r.total)]));
  });
};
