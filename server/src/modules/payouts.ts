import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { isAddress } from 'viem';
import { prisma } from '../lib/prisma.js';
import { money, reserveWithdrawable, post, FEES, postPlatformRevenue } from '../core/ledger.js';
import { payoutJobOptions } from '../core/payout-queue.js';
import { payoutQueue } from '../lib/redis.js';

export const payouts: FastifyPluginAsync = async (app) => {
  app.post('/', { preHandler: app.creatorOk }, async (req, reply) => {
    const { amountCents, instant } = z.object({
      amountCents: z.number().int().min(FEES.MIN_PAYOUT_CENTS), instant: z.boolean().default(false),
    }).parse(req.body);
    const c = await prisma.creatorProfile.findUniqueOrThrow({ where: { userId: req.user.id } });
    if (c.payoutsFrozen) return reply.code(403).send({ error: 'payouts_frozen' });
    if (!c.payoutAddress || !isAddress(c.payoutAddress)) return reply.code(400).send({ error: 'no_payout_address' });
    // USDG only (decided): an older row still set to ETH must change it first.
    if (c.payoutAsset !== 'STABLE') return reply.code(400).send({ error: 'payout_asset_unsupported' });

    // Instant/on-demand payout costs an extra 2% on top of the normal withdrawal
    // fee, for every creator. It used to be waived whenever the token-lock
    // perk was switched on -- but that perk is a free, instant toggle
    // (modules/stake.ts PATCH /me/perk) with no fan required, so any creator
    // could flip it on, cash out fee-free and flip it off again. Until the
    // owner picks a waiver rule that costs something or reflects real use
    // (e.g. an ACTIVE TokenLock at payout time, or the perk enabled for N
    // days), the fee is charged unconditionally.
    const instantBps = instant ? FEES.INSTANT_PAYOUT_BPS : 0;

    const p = await money(prisma, async (tx) => {
      // Closed loop: only EARNED credits are payable. Deposited (bought)
      // credits are spendable here and never withdrawn -- otherwise a
      // "creator" could deposit ETH or stablecoin and cash it straight back
      // out, turning the platform into an exchange desk. This reserves the
      // amount out of withdrawableCents under the row lock.
      await reserveWithdrawable(tx, req.user.id, amountCents);
      const fee = FEES.WITHDRAWAL_FLAT_CENTS + Math.floor((amountCents * (FEES.WITHDRAWAL_BPS + instantBps)) / 10_000);
      const net = amountCents - fee;
      if (net <= 0) throw Object.assign(new Error('amount_too_small'), { statusCode: 400 });
      const payout = await tx.payout.create({ data: { creatorId: req.user.id, asset: 'STABLE', address: c.payoutAddress!, instant, amountCents: BigInt(net), feeCents: BigInt(fee) } });
      await post(tx, req.user.id, -amountCents, 'PAYOUT', payout.id, { fee, net, instant });
      await postPlatformRevenue(tx, fee, payout.id, { source: 'withdrawal' });
      return payout;
    });
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
    return { ...p, amountCents: Number(p.amountCents), feeCents: Number(p.feeCents), queued };
  });

  app.get('/', { preHandler: app.creatorOk }, async (req) => {
    const rows = await prisma.payout.findMany({ where: { creatorId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(r => ({ ...r, amountCents: Number(r.amountCents), feeCents: Number(r.feeCents) }));
  });

  app.get('/earnings', { preHandler: app.creatorOk }, async (req) => {
    const rows = await prisma.$queryRaw<{ type: string; total: bigint }[]>`
      SELECT type, SUM("amountCents") AS total FROM "LedgerEntry"
      WHERE "userId"=${req.user.id} AND "amountCents">0 AND "createdAt" > now() - interval '30 days' GROUP BY type`;
    return Object.fromEntries(rows.map(r => [r.type, Number(r.total)]));
  });
};
