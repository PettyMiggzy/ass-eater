import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { money, post, PLATFORM_ID } from '../core/ledger.js';
import { deleteObject, deletePrefix, purgeCdnPrefix } from '../lib/s3.js';
import { wmPrefix } from '../lib/watermark.js';
import { recordManualBurn } from '../core/vip.js';
import { cancelAuction } from '../core/auctions.js';
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
      vipPriceCents: z.number().int().positive().optional(),
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

  // Suspending or banning freezes payouts; reactivating does NOT unfreeze
  // them. payoutsFrozen is also set by hand through POST
  // /creators/:id/freeze (e.g. a chargeback or fraud review), and the flag
  // can't tell the two reasons apart -- so writing `status !== 'ACTIVE'`
  // here silently lifted a deliberate manual freeze the moment an admin
  // reinstated the account. Lifting a freeze is always its own explicit step.
  async function setStatus(userId: string, status: 'ACTIVE' | 'SUSPENDED' | 'BANNED') {
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { status } }),
      prisma.refreshToken.deleteMany({ where: { userId } }),
      ...(status !== 'ACTIVE' ? [prisma.creatorProfile.updateMany({ where: { userId }, data: { payoutsFrozen: true } })] : []),
      ...(status === 'BANNED' ? [prisma.subscription.updateMany({ where: { creatorId: userId }, data: { autoRenew: false, status: 'CANCELLED' } })] : []),
    ]);
    // A ban takes the creator's marketplace down: fixed-price listings are
    // removed, and every live auction is cancelled with the leader's hold
    // returned in the same transaction (a removed auction is never closed by
    // the sweep, so a hold left on one was stranded). Suspension needs none
    // of this -- browsing, buying and bidding already refuse a non-ACTIVE
    // seller, and an auction ending during a suspension closes with no sale
    // and a full release (core/auctions.ts closeAuction).
    if (status === 'BANNED') {
      const auctions = await prisma.listing.findMany({ where: { creatorId: userId, saleType: 'AUCTION', status: 'ACTIVE' }, select: { id: true } });
      // One auction failing to cancel (the sweep can close it between this
      // read and its transaction; cancelAuction then no-ops) must never skip
      // the fixed-price removal below for a creator who is already BANNED.
      for (const a of auctions) {
        try {
          await money(prisma, (tx) => cancelAuction(tx, a.id, 'seller_banned'));
        } catch (err) {
          app.log.error({ err, listingId: a.id, userId }, 'ban: failed to cancel auction');
        }
      }
      await prisma.listing.updateMany({ where: { creatorId: userId, saleType: 'FIXED', status: 'ACTIVE' }, data: { status: 'REMOVED' } });
    }
  }
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
    const rows = await prisma.payout.findMany({ where: { status: (req.query.status ?? 'FAILED') as any }, orderBy: { createdAt: 'desc' }, take: 100, include: { creator: { select: { displayName: true } } } });
    return rows.map(r => ({ ...r, amountCents: Number(r.amountCents), feeCents: Number(r.feeCents) }));
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
      prisma.deposit.findMany({ where: { asset: 'ONLYONE', hedgedAt: null }, select: { rawAmount: true } }),
      prisma.treasuryHedgeBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    const pendingRaw = pending.reduce((s, d) => s + BigInt(d.rawAmount), 0n);
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
