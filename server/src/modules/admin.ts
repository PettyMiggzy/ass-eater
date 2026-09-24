import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { money, post, PLATFORM_ID } from '../core/ledger.js';
import { deleteObject, deletePrefix, purgeCdnPrefix } from '../lib/s3.js';
import { wmPrefix } from '../lib/watermark.js';
import { recordManualBurn } from '../core/vip.js';
import { applyUserStatus } from '../core/moderation.js';
import { refundPayout, markPayoutSent } from '../core/payouts.js';
import { payoutJobOptions, payoutJobId } from '../core/payout-queue.js';
import { payoutQueue } from '../lib/redis.js';
import { publicClient, HEDGE_STABLE, TRANSFER_EVENT, treasuryAddress } from '../lib/chain.js';
import { decodeEventLog, parseUnits } from 'viem';
import { Prisma } from '@prisma/client';
import { storageKeyOf } from '../core/media-key.js';

export const admin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.role('ADMIN'));

  // The one platform-wide numeric knob that needs to move without a
  // redeploy: as $ONLYONE's price rises, lower how many tokens it takes to
  // reach VIP (see core/vip.ts) rather than letting the USD cost of VIP
  // status float upward indefinitely.
  // `vipBurnBps` was renamed to `burnBps` when the burn was widened to cover
  // all platform revenue, not just VIP (see core/ledger.ts's
  // postPlatformRevenue). This route was never updated -- `vipBurnBps` isn't
  // a real PlatformConfig field, so PATCH threw PrismaClientValidationError
  // on every call, and the GET fallback's 10_000 (100%) didn't match the
  // schema's real default of 2500 (25%) either. tsc doesn't catch a spread
  // like `{ id: 1, ...body }` carrying an unknown property, which is why
  // this stayed broken silently.
  app.get('/vip-config', async () =>
    (await prisma.platformConfig.findUnique({ where: { id: 1 } })) ?? { id: 1, vipPriceCents: 2000, minDmPriceCents: 99, burnBps: 2500 });

  app.patch('/vip-config', async (req: any) => {
    const body = z.object({
      // Upper bound: a fat-fingered extra zero must not become a real price.
      vipPriceCents: z.number().int().positive().max(100_000).optional(),
      // Capped at 100%: the platform cannot commit to burning more than the
      // revenue it took in, which would be spending money it does not have.
      burnBps: z.number().int().min(0).max(10_000).optional(),
      // The floor on paid inbound DMs (modules/messages.ts). min(1): messaging
      // a creator is never free (decided 2026-09-20).
      minDmPriceCents: z.number().int().min(1).max(50_000).optional(),
    }).parse(req.body);
    return prisma.platformConfig.upsert({ where: { id: 1 }, create: { id: 1, ...body }, update: body });
  });

  /**
   * Close the outstanding burn obligations against a real on-chain burn.
   *
   * The founder buys and burns from his own wallet monthly and pastes the
   * transaction hash here. The hash is required and format-checked: without
   * one this endpoint would let the platform mark supply destroyed that
   * nobody can verify.
   */
  app.post('/token-burns/record', async (req: any) => {
    const b = z.object({
      txHash: z.string(),
      tokensBurned: z.string().max(80).optional(),
      note: z.string().max(200).optional(),
    }).parse(req.body);
    try {
      // usdCents is a BigInt, which JSON.stringify refuses: returned raw, the
      // burn was recorded and the admin got a 500 saying it failed.
      const r = await money(prisma, (tx) => recordManualBurn(tx, b));
      return { ...r, usdCents: r.usdCents.toString() };
    } catch (e: any) {
      if (e.message === 'invalid_tx_hash') {
        throw Object.assign(new Error('txHash must be a 0x-prefixed 32-byte transaction hash'), { statusCode: 400 });
      }
      throw e;
    }
  });

  /** How much has actually been destroyed, and how much is still owed. */
  app.get('/token-burns', async () => {
    const [executed, pending] = await Promise.all([
      prisma.tokenBurn.findMany({ where: { NOT: { executedAt: null } }, orderBy: { executedAt: 'desc' }, take: 100 }),
      prisma.tokenBurn.findMany({ where: { executedAt: null }, orderBy: { createdAt: 'asc' }, take: 100 }),
    ]);
    const sum = (rows: { usdCents: bigint }[]) => rows.reduce((a, r) => a + r.usdCents, 0n).toString();
    // Row usdCents are BigInt too -- stringified, or the whole report 500s.
    const out = <T extends { usdCents: bigint }>(rows: T[]) => rows.map((r) => ({ ...r, usdCents: r.usdCents.toString() }));
    return { executed: out(executed), pending: out(pending), executedCents: sum(executed), pendingCents: sum(pending) };
  });

  app.get('/reports', async (req: any) =>
    prisma.report.findMany({ where: { status: (req.query.status ?? 'OPEN') as any }, orderBy: { createdAt: 'asc' }, take: 100 }));

  app.post('/reports/:id/resolve', async (req: any) => {
    const { action } = z.object({ action: z.enum(['dismiss', 'remove_content', 'suspend_user', 'ban_user']) }).parse(req.body);
    const r = await prisma.report.findUniqueOrThrow({ where: { id: req.params.id } });

    if (action !== 'dismiss') {
      if (r.targetType === 'post') await prisma.post.update({ where: { id: r.targetId }, data: { removed: true } });
      if (action !== 'remove_content') {
        const userId = r.targetType === 'user' ? r.targetId
          : r.targetType === 'post' ? (await prisma.post.findUnique({ where: { id: r.targetId } }))?.creatorId
          : (await prisma.message.findUnique({ where: { id: r.targetId } }))?.senderId;
        if (userId) await setStatus(userId, action === 'ban_user' ? 'BANNED' : 'SUSPENDED');
      }
    }
    return prisma.report.update({ where: { id: r.id }, data: { status: action === 'dismiss' ? 'DISMISSED' : 'ACTIONED', resolvedBy: req.user.id } });
  });

  // Suspend/ban/reactivate, with everything that implies (payout freeze,
  // cancelled subscriptions, delisting, ending a live stream): see
  // core/moderation.ts, shared with the site's status push over the bridge.
  // An admin's decision is never marked as the site's, so the site coming
  // back 'active' cannot lift it.
  const setStatus = (userId: string, status: 'ACTIVE' | 'SUSPENDED' | 'BANNED') =>
    applyUserStatus(userId, status, { log: app.log });
  app.post('/users/:id/status', async (req: any) => {
    const { status } = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']) }).parse(req.body);
    await setStatus(req.params.id, status); return { ok: true };
  });

  app.post('/users/:id/kyc', async (req: any) => {
    const { status } = z.object({ status: z.enum(['APPROVED', 'REJECTED', 'PENDING']) }).parse(req.body);
    return prisma.user.update({ where: { id: req.params.id }, data: { kycStatus: status } });
  });

  app.post('/creators/:id/freeze', async (req: any) => {
    const { frozen } = z.object({ frozen: z.boolean() }).parse(req.body);
    return prisma.creatorProfile.update({ where: { userId: req.params.id }, data: { payoutsFrozen: frozen } });
  });

  /**
   * Takedown (NCII / TAKE IT DOWN). The content has to actually be gone, not
   * just hidden on one row:
   *
   *  - A mass-DM copy (sourceMediaId set) is the same content as its source,
   *    so a takedown aimed at a copy takes down the source and every copy.
   *  - Every affected row goes REJECTED with hlsKey AND previewKey nulled.
   *    Nulling only the targeted row left every broadcast copy READY with the
   *    source's hlsKey, still streaming to everyone who had unlocked it.
   *  - Storage: the raw object, the whole transcode output prefix
   *    (media/<owner>/<id>/ -- HLS playlists, segments, preview.jpg) and every
   *    per-viewer watermarked copy (wm/<mediaId>/) of the source and of each
   *    copy. Previously only the raw object went.
   *  - The CDN edge is purged for the same paths (needs BUNNY_API_KEY); the
   *    response says whether that happened.
   *
   * Rows are rejected first, so nothing is served while storage is cleaned.
   * Storage failures are reported, not swallowed: a takedown that silently
   * left files behind is the failure this exists to prevent.
   */
  app.delete('/media/:id', async (req: any) => {
    const target = await prisma.media.findUniqueOrThrow({ where: { id: req.params.id } });
    const root = target.sourceMediaId
      ? (await prisma.media.findUnique({ where: { id: target.sourceMediaId } })) ?? target
      : target;
    const copies = await prisma.media.findMany({ where: { sourceMediaId: root.id }, select: { id: true } });
    const ids = [root.id, target.id, ...copies.map((c) => c.id)];
    const rejected = await prisma.media.updateMany({
      where: { id: { in: [...new Set(ids)] } },
      data: { status: 'REJECTED', hlsKey: null, previewKey: null },
    });

    const errors: string[] = [];
    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      try { await fn(); } catch (e) { req.log.error({ err: e, mediaId: root.id }, `takedown: ${label} failed`); errors.push(label); }
    };
    const outputPrefix = `media/${root.ownerId}/${root.id}/`;
    await attempt('raw object', () => deleteObject(storageKeyOf(root.key)));
    await attempt('transcode output', () => deletePrefix(outputPrefix));
    for (const id of new Set(ids)) await attempt(`watermarked copies of ${id}`, () => deletePrefix(wmPrefix(id)));

    const purged: boolean[] = [];
    purged.push(await purgeCdnPrefix(`/${storageKeyOf(root.key)}`));
    purged.push(await purgeCdnPrefix(`/${outputPrefix}`));
    for (const id of new Set(ids)) purged.push(await purgeCdnPrefix(`/${wmPrefix(id)}`));

    return { ok: errors.length === 0, rootMediaId: root.id, rejected: rejected.count, storageErrors: errors, cdnPurged: purged.every(Boolean) };
  });

  /** Manual credit/debit (refunds, goodwill, corrections). Counter-posted against treasury. */
  app.post('/users/:id/adjust', async (req: any) => {
    const { amountCents, reason } = z.object({ amountCents: z.number().int(), reason: z.string().max(200) }).parse(req.body);
    await money(prisma, async (tx) => {
      await post(tx, req.params.id, amountCents, 'ADJUSTMENT', undefined, { reason, by: req.user.id });
      await post(tx, PLATFORM_ID, -amountCents, 'ADJUSTMENT', undefined, { reason, target: req.params.id });
    });
    return { ok: true };
  });

  app.get('/payouts', async (req: any) => {
    const status = z.enum(['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'HELD', 'REFUNDED']).default('FAILED').parse(req.query.status || undefined);
    const rows = await prisma.payout.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: 100, include: { creator: { select: { displayName: true } } } });
    return rows.map(r => ({ ...r, amountCents: Number(r.amountCents), feeCents: Number(r.feeCents) }));
  });

  /**
   * Settle a payout the automatic paths could not (see the reconciler in
   * workers/payout-worker.ts). Every action is guarded on the payout's
   * current status, so it can never race the worker into paying or
   * refunding twice.
   *
   *  - mark_sent {txHash}: only against a SUCCESSFUL on-chain transaction
   *    containing a USDG Transfer FROM the treasury (TREASURY_ADDRESS) TO
   *    this payout's address for the payout's amount (its recorded
   *    assetAmount when the worker got that far, else at least the net
   *    amount at $1), and only a hash no other payout already records (also
   *    a unique index). Refused while the payout's worker job is still
   *    queued or running -- that job would broadcast its own transfer and
   *    pay the creator twice -- and when the payout's own signed tx already
   *    succeeded (mark it with that hash instead).
   *  - refund {reason}: PENDING / HELD / FAILED only. A FAILED payout with a
   *    txHash is refused while its receipt shows success; when no receipt
   *    exists the admin must pass acknowledgeUnconfirmed after checking the
   *    explorer, because the tx could still land later.
   *  - release: HELD -> PENDING and re-queued. Refused while the creator is
   *    still frozen or not ACTIVE -- lifting a freeze (POST
   *    /creators/:id/freeze) is its own explicit step.
   */
  app.post('/payouts/:id/resolve', async (req: any, reply) => {
    const b = z.discriminatedUnion('action', [
      z.object({ action: z.literal('mark_sent'), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      z.object({ action: z.literal('refund'), reason: z.string().min(3).max(200), acknowledgeUnconfirmed: z.boolean().optional() }),
      z.object({ action: z.literal('release') }),
    ]).parse(req.body);
    const p = await prisma.payout.findUniqueOrThrow({ where: { id: req.params.id }, include: { creator: { select: { payoutsFrozen: true, user: { select: { status: true } } } } } });
    const by = { by: req.user.id };

    if (b.action === 'mark_sent') {
      const hash = b.txHash.toLowerCase() as `0x${string}`;
      if (!['PENDING', 'PROCESSING', 'FAILED', 'HELD'].includes(p.status)) return reply.code(409).send({ error: 'wrong_status', status: p.status });
      if (p.status === 'PENDING' || p.status === 'PROCESSING') {
        const job = await payoutQueue.getJob(payoutJobId(p.id));
        if (job && (await job.isActive() || await job.isWaiting() || await job.isDelayed())) {
          return reply.code(409).send({ error: 'payout_in_flight' });
        }
      }
      if (p.txHash && p.txHash.toLowerCase() !== hash) {
        const own = await publicClient.getTransactionReceipt({ hash: p.txHash as `0x${string}` }).catch(() => null);
        if (own?.status === 'success') return reply.code(409).send({ error: 'own_tx_succeeded', txHash: p.txHash });
      }
      const treasury = treasuryAddress();
      if (!treasury) return reply.code(409).send({ error: 'treasury_address_not_configured' });
      const expectedRaw = p.assetAmount != null
        ? BigInt(p.assetAmount)
        : parseUnits((Number(p.amountCents) / 100).toFixed(HEDGE_STABLE.decimals), HEDGE_STABLE.decimals);
      const exact = p.assetAmount != null;
      const rcpt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
      if (!rcpt || rcpt.status !== 'success') return reply.code(409).send({ error: 'tx_not_successful' });
      const pays = rcpt.logs.some((l) => {
        if (l.address.toLowerCase() !== HEDGE_STABLE.address.toLowerCase()) return false;
        try {
          const ev = decodeEventLog({ abi: [TRANSFER_EVENT], data: l.data, topics: l.topics });
          if (String(ev.args.from).toLowerCase() !== treasury.toLowerCase()) return false;
          if (String(ev.args.to).toLowerCase() !== p.address.toLowerCase()) return false;
          const v = ev.args.value as bigint;
          return exact ? v === expectedRaw : v >= expectedRaw;
        } catch { return false; }
      });
      if (!pays) return reply.code(409).send({ error: 'tx_does_not_pay_this_payout' });
      try {
        const ok = await money(prisma, async (tx) => {
          const reused = await tx.payout.findFirst({ where: { id: { not: p.id }, txHash: { equals: hash, mode: 'insensitive' } }, select: { id: true } });
          if (reused) throw Object.assign(new Error('tx_already_used'), { statusCode: 409 });
          // Only from the status checked above: a PENDING payout the reconciler
          // re-queued meanwhile may now be PROCESSING with the worker's own
          // transfer on its way, and marking it SENT then would pay twice.
          return markPayoutSent(tx, p.id, [p.status], hash, `marked sent by admin ${req.user.id}`);
        });
        return ok ? { ok: true, status: 'SENT' } : reply.code(409).send({ error: 'status_changed' });
      } catch (err: any) {
        if (err?.message === 'tx_already_used' || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') || /Payout_txHash_lower_key/.test(String(err?.message ?? ''))) {
          return reply.code(409).send({ error: 'tx_already_used' });
        }
        throw err;
      }
    }

    if (b.action === 'refund') {
      if (!['PENDING', 'HELD', 'FAILED'].includes(p.status)) return reply.code(409).send({ error: 'not_refundable', status: p.status });
      if (p.txHash) {
        const rcpt = await publicClient.getTransactionReceipt({ hash: p.txHash as `0x${string}` }).catch(() => null);
        if (rcpt?.status === 'success') return reply.code(409).send({ error: 'tx_succeeded_use_mark_sent' });
        if (!rcpt && !b.acknowledgeUnconfirmed) return reply.code(409).send({ error: 'tx_unconfirmed_check_explorer' });
      }
      const ok = await money(prisma, (tx) => refundPayout(tx, p.id, ['PENDING', 'HELD', 'FAILED'], `admin refund: ${b.reason}`));
      req.log.info({ payoutId: p.id, ...by }, 'payout refunded by admin');
      return ok ? { ok: true, status: 'REFUNDED' } : reply.code(409).send({ error: 'status_changed' });
    }

    if (p.status !== 'HELD') return reply.code(409).send({ error: 'not_held', status: p.status });
    if (p.creator.payoutsFrozen || p.creator.user.status !== 'ACTIVE') return reply.code(409).send({ error: 'creator_frozen' });
    const r = await prisma.payout.updateMany({ where: { id: p.id, status: 'HELD' }, data: { status: 'PENDING', error: null } });
    if (!r.count) return reply.code(409).send({ error: 'status_changed' });
    await payoutQueue.add('send', { payoutId: p.id }, payoutJobOptions(p.id, p.instant)).catch((err) => {
      req.log.error({ err, payoutId: p.id }, 'release: enqueue failed; the reconciler will re-queue it');
    });
    return { ok: true, status: 'PENDING' };
  });

  app.get('/revenue', async (req: any) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) }).parse(req.query ?? {});
    const rows = await prisma.$queryRaw<{ day: Date; source: string; cents: bigint }[]>`
      SELECT date_trunc('day',"createdAt") AS day, meta->>'source' AS source, SUM("amountCents") AS cents
      FROM "LedgerEntry" WHERE "userId"=${PLATFORM_ID} AND type='PLATFORM_FEE' AND "createdAt" > now() - (${days} || ' days')::interval
      GROUP BY 1,2 ORDER BY 1`;
    const treasury = await prisma.account.findUnique({ where: { userId: PLATFORM_ID } });
    return { treasuryCents: Number(treasury?.balanceCents ?? 0), series: rows.map(r => ({ ...r, cents: Number(r.cents) })) };
  });

  /** Treasury's $ONLYONE hedge exposure: how much of what's come in is still unconverted risk vs already de-risked into stablecoin. */
  app.get('/treasury-hedge', async () => {
    const [pending, batches] = await Promise.all([
      prisma.deposit.findMany({ where: { asset: 'ONLYONE', hedgedAt: null }, select: { rawAmount: true, hedgedRaw: true } }),
      prisma.treasuryHedgeBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    // Minus what partial swaps already sold for these deposits (Deposit.hedgedRaw).
    const pendingRaw = pending.reduce((s, d) => s + BigInt(d.rawAmount) - BigInt(d.hedgedRaw ?? '0'), 0n);
    const swappedRaw = batches.reduce((s, b) => s + BigInt(b.onlyOneRawIn), 0n);
    const usdcRaw = batches.reduce((s, b) => s + BigInt(b.usdcRawOut), 0n);
    return {
      pendingOnlyOneRaw: pendingRaw.toString(), // not yet swept by the hedge worker (thin liquidity, or below its cycle)
      lifetimeOnlyOneSwappedRaw: swappedRaw.toString(),
      lifetimeUsdcReceivedRaw: usdcRaw.toString(),
      batches,
    };
  });

  app.get('/stats', async () => {
    const [users, creators, activeSubs, gmv] = await Promise.all([
      prisma.user.count(), prisma.creatorProfile.count({ where: { user: { kycStatus: 'APPROVED' } } }),
      prisma.subscription.count({ where: { status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } } }),
      prisma.ledgerEntry.aggregate({ _sum: { amountCents: true }, where: { amountCents: { lt: 0 }, type: { in: ['SUBSCRIPTION', 'PPV', 'TIP', 'MESSAGE_UNLOCK', 'LIVE_TICKET'] }, createdAt: { gt: new Date(Date.now() - 30 * 864e5) } } }),
    ]);
    return { users, creators, activeSubs, gmv30dCents: -Number(gmv._sum.amountCents ?? 0) };
  });
};
