import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { money, post, PLATFORM_ID, FEES } from '../core/ledger.js';
import { deleteObject, deletePrefix, purgeCdnPrefix, cdnSignedUrl } from '../lib/s3.js';
import { wmPrefix } from '../lib/watermark.js';
import { recordManualBurn } from '../core/vip.js';
import { applyUserStatus, restoreBanTakedowns } from '../core/moderation.js';
import { refundPayout, markPayoutSent, holdForManualSettlement } from '../core/payouts.js';
import { payoutJobOptions, payoutJobId, jobInFlight } from '../core/payout-queue.js';
import { payoutQueue } from '../lib/redis.js';
import { publicClient, HEDGE_STABLE, TRANSFER_EVENT, treasuryAddress, TOKENS, DECIMALS, onlyOneBurnedIn, burnSenders } from '../lib/chain.js';
import { decodeEventLog, formatUnits, parseUnits, TransactionReceiptNotFoundError } from 'viem';
import { Prisma } from '@prisma/client';
import { storageKeyOf } from '../core/media-key.js';
import { cancelAuction } from '../core/auctions.js';
import { CREATOR_STANDING_SELECT, creatorMayBePaid } from '../core/creator-standing.js';
import { REPORT_TARGETS, messageAndBroadcastSiblings, listReports } from '../core/reports.js';

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
      // The floor on paid inbound DMs (modules/messages.ts). Never zero:
      // messaging a creator is never free (decided 2026-09-20). And never
      // below FEES.MIN_DM_FLOOR_CENTS, where the 10% fee would floor to 0
      // and the platform would keep nothing on the message.
      minDmPriceCents: z.number().int().min(FEES.MIN_DM_FLOOR_CENTS).max(50_000).optional(),
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
  app.post('/token-burns/record', async (req: any, reply) => {
    const b = z.object({
      txHash: z.string(),
      tokensBurned: z.string().max(80).optional(),
      note: z.string().max(200).optional(),
    }).parse(req.body);
    // When the chain can actually be asked (token configured and an RPC set),
    // the hash must be a SUCCESSFUL transaction in which the platform's own
    // burn wallet -- the treasury (TREASURY_ADDRESS / the treasury key) or
    // an address listed in BURN_SENDER_ADDRESSES -- sent $ONLYONE to a burn
    // sink (0x…dEaD or address(0)). Any holder's public burn, even of 1
    // wei, used to pass. The on-chain amount replaces the admin's free-text
    // tokensBurned and is returned next to the USD value closed, so a
    // token burn far smaller than what it settles is visible at once. Not
    // checked while RPC_URL is still a placeholder on the droplet (then the
    // hash is admin-trusted; the reuse check in recordManualBurn applies
    // either way).
    let onChainBurnedRaw: bigint | null = null;
    if (/^0x[0-9a-fA-F]{64}$/.test(String(b.txHash).trim()) && TOKENS.ONLYONE.address && process.env.RPC_URL) {
      let rcpt: any;
      try {
        rcpt = await publicClient.getTransactionReceipt({ hash: String(b.txHash).trim() as `0x${string}` });
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return reply.code(409).send({ error: 'tx_not_found' });
        req.log.error({ err: e }, 'token-burns/record: receipt lookup failed');
        return reply.code(503).send({ error: 'chain_unreachable' });
      }
      if (rcpt.status !== 'success') return reply.code(409).send({ error: 'tx_not_successful' });
      const senders = burnSenders();
      if (!senders.length) return reply.code(409).send({ error: 'burn_sender_not_configured' });
      onChainBurnedRaw = onlyOneBurnedIn(rcpt.logs, { includeZero: true, from: senders });
      if (onChainBurnedRaw <= 0n) return reply.code(409).send({ error: 'not_a_burn' });
    }
    try {
      const tokensBurned = onChainBurnedRaw != null ? formatUnits(onChainBurnedRaw, DECIMALS.ONLYONE) : b.tokensBurned;
      // usdCents is a BigInt, which JSON.stringify refuses: returned raw, the
      // burn was recorded and the admin got a 500 saying it failed.
      const r = await money(prisma, (tx) => recordManualBurn(tx, { ...b, tokensBurned }));
      return { ...r, usdCents: r.usdCents.toString(), tokensBurned: tokensBurned ?? null, verifiedOnChain: onChainBurnedRaw != null };
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

  // The takedown itself (see the comment on DELETE /media/:id below); shared with
  // /reports/:id/resolve, which takes down a reported post's, message's or
  // listing's media the same way.
  //
  // Cost is bounded per ROOT, not per copy: a mass DM writes one media copy
  // row per subscriber, and this used to list and CDN-purge the watermark
  // prefix of every copy one after another (and the report route called it
  // once per copy on top), so a drop to 1,000 fans meant ~1M sequential
  // storage and CDN calls and the resolve never finished. Watermarked copies
  // are now cached under the ROOT's id (media.ts / lib/watermark.ts), so one
  // prefix covers every viewer of every copy; per-copy prefixes can only
  // hold caches written before that change, and are cleaned in the
  // background with bounded concurrency (the rows are already REJECTED, so
  // nothing is served from them meanwhile).
  const takedownMedia = async (mediaId: string, log: { error: (o: unknown, m?: string) => void }) => {
    const target = await prisma.media.findUniqueOrThrow({ where: { id: mediaId } });
    const root = target.sourceMediaId
      ? (await prisma.media.findUnique({ where: { id: target.sourceMediaId } })) ?? target
      : target;
    const REJECT = { status: 'REJECTED' as const, hlsKey: null, previewKey: null };
    // The root first, in its own statement, THEN every copy in a second one.
    // A mass DM still delivering writes each new copy in a transaction that
    // holds the source row locked (FOR UPDATE + a no-op touch, see
    // workers/broadcast.ts claimSourcesForCopy) and refuses a source that is
    // no longer READY. So either that copy committed before the
    // root's update could take its row lock -- and the second statement,
    // started after, sees it -- or the worker sees the root REJECTED and
    // stops. One combined statement could miss a copy committed while it
    // waited on the lock (its snapshot predates it).
    const first = [...new Set([root.id, target.id])];
    const rootRejected = await prisma.media.updateMany({ where: { id: { in: first } }, data: REJECT });
    const copiesRejected = await prisma.media.updateMany({ where: { sourceMediaId: root.id, id: { notIn: first } }, data: REJECT });
    const copies = await prisma.media.findMany({ where: { sourceMediaId: root.id }, select: { id: true } });

    // Every message carrying this content goes too: its text blanked and its
    // price zeroed -- nothing is left to sell, and for a mass DM the copies
    // are one row per subscriber (core/reports.ts). A message has no
    // "removed" flag. Copies the broadcast worker would write later are
    // refused by it (the source is no longer READY) and it blanks the whole
    // drop itself.
    await prisma.message.updateMany({
      where: { media: { some: { OR: [{ id: root.id }, { sourceMediaId: root.id }] } } },
      data: { text: '', priceCents: 0 },
    });

    const errors: string[] = [];
    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      try { await fn(); } catch (e) { log.error({ err: e, mediaId: root.id }, `takedown: ${label} failed`); errors.push(label); }
    };
    const outputPrefix = `media/${root.ownerId}/${root.id}/`;
    await attempt('raw object', () => deleteObject(storageKeyOf(root.key)));
    await attempt('transcode output', () => deletePrefix(outputPrefix));
    await attempt('watermarked copies', () => deletePrefix(wmPrefix(root.id)));

    const purged: boolean[] = [];
    purged.push(await purgeCdnPrefix(`/${storageKeyOf(root.key)}`));
    purged.push(await purgeCdnPrefix(`/${outputPrefix}`));
    purged.push(await purgeCdnPrefix(`/${wmPrefix(root.id)}`));

    const legacy = [...new Set([target.id, ...copies.map((c) => c.id)])].filter((id) => id !== root.id);
    if (legacy.length) void cleanupLegacyWatermarks(root.id, legacy, log);

    return {
      ok: errors.length === 0, rootMediaId: root.id, rejected: rootRejected.count + copiesRejected.count,
      storageErrors: errors, cdnPurged: purged.every(Boolean),
      legacyCopyCachesCleanedInBackground: legacy.length,
    };
  };

  /**
   * Deletes (and CDN-purges) per-copy watermark prefixes left by the old
   * per-copy cache layout. Background, bounded to a few calls in flight, and
   * logged per failure: it must not hold up the takedown's response (nginx
   * times out at 75s), and every row it concerns is already REJECTED.
   */
  const cleanupLegacyWatermarks = async (rootId: string, ids: string[], log: { error: (o: unknown, m?: string) => void }) => {
    const queue = [...ids];
    const workerLoop = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try { await deletePrefix(wmPrefix(id)); } catch (e) { log.error({ err: e, mediaId: id, rootMediaId: rootId }, 'takedown: legacy watermarked copies failed'); }
        try { await purgeCdnPrefix(`/${wmPrefix(id)}`); } catch (e) { log.error({ err: e, mediaId: id, rootMediaId: rootId }, 'takedown: legacy watermark purge failed'); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, workerLoop)).catch(() => {});
  };

  /**
   * Takes down the given media rows, once per distinct ROOT: one
   * takedownMedia call already covers a root and every copy of it, so
   * calling it per copy row repeated all of that work for every subscriber.
   */
  const takedownRoots = async (mediaIds: string[], log: { error: (o: unknown, m?: string) => void }) => {
    if (!mediaIds.length) return [];
    const rows = await prisma.media.findMany({ where: { id: { in: mediaIds } }, select: { id: true, sourceMediaId: true } });
    const seen = new Set<string>();
    const out: Awaited<ReturnType<typeof takedownMedia>>[] = [];
    for (const r of rows) {
      const rootId = r.sourceMediaId ?? r.id;
      if (seen.has(rootId)) continue;
      seen.add(rootId);
      out.push(await takedownMedia(r.id, log));
    }
    return out;
  };

  // The moderation queue, PAGED (core/reports.ts listReports). It used to be
  // the 100 oldest rows and nothing else: a widely reported drop (one OPEN
  // report per fan's copy) filled that window and hid every newer report --
  // an NCII report on someone else included. Now `limit`/`offset` walk the
  // whole queue, `total` says how deep it is, reports on content that is
  // still up come first, and each row says whether its content is already
  // down (`contentRemoved`, also a filter). `targetType` narrows it.
  app.get('/reports', async (req: any) => {
    const q = z.object({
      status: z.enum(['OPEN', 'ACTIONED', 'DISMISSED']).default('OPEN'),
      targetType: z.enum(['post', 'message', 'listing', 'user']).optional(),
      contentRemoved: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query ?? {});
    const { reports, total } = await listReports({
      status: q.status, targetType: q.targetType, limit: q.limit, offset: q.offset,
      contentRemoved: q.contentRemoved === undefined ? undefined : q.contentRemoved === 'true',
    });
    return { reports, total, limit: q.limit, offset: q.offset };
  });

  /**
   * What was reported, for the admin deciding on it. Moderation used to be
   * blind: GET /reports returns only the report row, and every content read
   * path deliberately excludes admins (canViewPost / canViewMessage /
   * canViewListing / canViewMedia have no ADMIN branch -- and must not get
   * one, since that would widen access on every fan route). So an admin
   * chose between an irreversible takedown and leaving possible NCII up
   * without seeing it. This returns the item, and short-lived signed URLs
   * for its media generated directly for this admin-only route.
   *
   * Every view is logged (admin, report, target) as the audit trail: this
   * route shows paywalled and private content.
   */
  app.get('/reports/:id/target', async (req: any, reply) => {
    const r = await prisma.report.findUnique({ where: { id: String(req.params.id ?? '') } });
    if (!r) return reply.code(404).send({ error: 'not_found' });
    req.log.info({ audit: 'admin_viewed_reported_content', adminId: req.user.id, reportId: r.id, targetType: r.targetType, targetId: r.targetId, at: new Date().toISOString() }, 'admin viewed reported content');

    const MEDIA_TTL = 300;
    const mediaView = (m: { id: string; key: string; mime: string; status: string; hlsKey: string | null; previewKey: string | null }) => {
      let url: string | null = null, type: 'hls' | 'image' | null = null;
      try {
        if (m.status === 'READY' && m.hlsKey) {
          const dir = m.hlsKey.slice(0, m.hlsKey.lastIndexOf('/') + 1);
          url = cdnSignedUrl(`/${m.hlsKey}`, MEDIA_TTL, `/${dir}`); type = 'hls';
        } else if (m.status === 'READY') {
          url = cdnSignedUrl(`/${storageKeyOf(m.key)}`, MEDIA_TTL); type = 'image';
        }
      } catch { url = null; /* no CDN configured */ }
      return { id: m.id, mime: m.mime, status: m.status, type, url, expiresIn: url ? MEDIA_TTL : null };
    };
    const MEDIA_SELECT = { id: true, key: true, mime: true, status: true, hlsKey: true, previewKey: true } as const;

    let target: unknown = null;
    if (r.targetType === 'post') {
      const p = await prisma.post.findUnique({ where: { id: r.targetId }, include: { media: { select: MEDIA_SELECT } } });
      if (p) {
        // Who owns it, and their standing: the queue lists a banned creator's
        // other reports as live content, and the admin deciding one needs to
        // see the ban before choosing suspend_user.
        const owner = await prisma.user.findUnique({ where: { id: p.creatorId }, select: { id: true, username: true, role: true, status: true } });
        target = { id: p.id, creatorId: p.creatorId, owner, text: p.text, visibility: p.visibility, priceCents: p.priceCents, removed: p.removed, createdAt: p.createdAt, media: p.media.map(mediaView) };
      }
    } else if (r.targetType === 'message') {
      const m = await prisma.message.findUnique({ where: { id: r.targetId }, include: { media: { select: MEDIA_SELECT } } });
      if (m) {
        const sender = await prisma.user.findUnique({ where: { id: m.senderId }, select: { id: true, username: true, role: true, status: true } });
        const copies = m.broadcastId ? await prisma.message.count({ where: { senderId: m.senderId, broadcastId: m.broadcastId } }) : 1;
        target = { id: m.id, text: m.text, priceCents: m.priceCents, sender, broadcastId: m.broadcastId, broadcastCopies: copies, createdAt: m.createdAt, media: m.media.map(mediaView) };
      }
    } else if (r.targetType === 'listing') {
      const l = await prisma.listing.findUnique({ where: { id: r.targetId }, include: { media: { select: MEDIA_SELECT } } });
      if (l) {
        const keys = l.images.filter((k) => k.startsWith('raw/'));
        const images = keys.length ? await prisma.media.findMany({ where: { key: { in: keys } }, select: MEDIA_SELECT }) : [];
        const { media: product, ...fields } = l;
        const owner = await prisma.user.findUnique({ where: { id: l.creatorId }, select: { id: true, username: true, role: true, status: true } });
        target = { ...fields, owner, media: product.map(mediaView), images: images.map(mediaView) };
      }
    } else if (r.targetType === 'user') {
      const u = await prisma.user.findUnique({
        where: { id: r.targetId },
        select: { id: true, username: true, role: true, status: true, statusBySite: true, kycStatus: true, createdAt: true, creator: { select: { displayName: true, bio: true, avatarKey: true, bannerKey: true, tags: true } } },
      });
      if (u) {
        const imgKeys = [u.creator?.avatarKey, u.creator?.bannerKey].filter((k): k is string => !!k && k.startsWith('raw/'));
        const images = imgKeys.length ? await prisma.media.findMany({ where: { key: { in: imgKeys } }, select: MEDIA_SELECT }) : [];
        target = { ...u, images: images.map(mediaView) };
      }
    }
    return { report: r, target, targetFound: target != null };
  });

  app.post('/reports/:id/resolve', async (req: any, reply) => {
    const { action } = z.object({ action: z.enum(['dismiss', 'remove_content', 'suspend_user', 'ban_user']) }).parse(req.body);
    const r = await prisma.report.findUniqueOrThrow({ where: { id: req.params.id } });
    if (r.status !== 'OPEN') return reply.code(409).send({ error: 'already_resolved', status: r.status });

    // Refusals that need no claim (nothing is changed by them).
    let owner: string | undefined;
    if (action !== 'dismiss') {
      if (!(REPORT_TARGETS as string[]).includes(r.targetType)) return reply.code(409).send({ error: 'unsupported_target', targetType: r.targetType });
      // A report on a USER has no single item to remove: 'remove_content' is
      // refused rather than marked ACTIONED with nothing done.
      if (r.targetType === 'user' && action === 'remove_content') return reply.code(409).send({ error: 'nothing_to_remove_for_target', targetType: r.targetType });
      // Who the reported content belongs to (for suspend/ban), per type.
      owner = r.targetType === 'user' ? (await prisma.user.findUnique({ where: { id: r.targetId }, select: { id: true } }))?.id
        : r.targetType === 'post' ? (await prisma.post.findUnique({ where: { id: r.targetId } }))?.creatorId
        : r.targetType === 'message' ? (await prisma.message.findUnique({ where: { id: r.targetId } }))?.senderId
        : (await prisma.listing.findUnique({ where: { id: r.targetId } }))?.creatorId;
      if (!owner) return reply.code(409).send({ error: 'target_not_found' });
      // Never LOWER an owner's standing from the queue. A ban settles only
      // the reports on the item it was decided on; the banned account's
      // other reports stay OPEN, and suspend_user on one of them used to
      // rewrite BANNED to SUSPENDED with no warning -- one routine
      // reactivation away from restoring a banned account. Refused before
      // the claim, so the report stays OPEN for a remove_content or ban
      // decision instead. (setStatus below also carries the guard, for a
      // ban landing between this read and that write.)
      if (action === 'suspend_user') {
        const st = await prisma.user.findUnique({ where: { id: owner }, select: { status: true } });
        if (st?.status === 'BANNED') return reply.code(409).send({ error: 'owner_already_banned', ownerId: owner, ownerStatus: 'BANNED' });
      }
    }

    // CLAIM the report before acting: a guarded OPEN -> final update, so of
    // two concurrent resolves exactly one runs the takedown and the
    // suspend/ban, and the other gets already_resolved. A failure while
    // acting puts it back to OPEN so it can be retried.
    const finalStatus = action === 'dismiss' ? 'DISMISSED' : 'ACTIONED';
    const claimed = await prisma.report.updateMany({ where: { id: r.id, status: 'OPEN' }, data: { status: finalStatus, resolvedBy: req.user.id } });
    if (claimed.count === 0) {
      const now = await prisma.report.findUnique({ where: { id: r.id }, select: { status: true } });
      return reply.code(409).send({ error: 'already_resolved', status: now?.status ?? null });
    }

    const takedowns: Awaited<ReturnType<typeof takedownMedia>>[] = [];
    // The same content's OTHER open reports (by other reporters; for a mass
    // DM, on ANY subscriber's copy). They are NOT closed by this decision --
    // the admin chose on this one report and never read theirs, and one of
    // them may say more than this one did (a possible minor, NCII), which
    // needs a suspension, a ban or a legal report rather than a takedown
    // alone. They stay OPEN and are returned below with their reasons;
    // GET /reports sorts them after live content (contentRemoved) so they
    // do not bury newer reports. Only a BAN -- the maximum action there is
    // on this account -- settles them, and then every settled report is
    // returned with its reason so nothing is closed unseen.
    let settledTargetIds: string[] = [];
    type Related = { id: string; reporterId: string; targetId: string; reason: string; createdAt: Date };
    let settledReports: Related[] = [], openRelatedReports: Related[] = [];
    try {
      if (action !== 'dismiss') {
        // Content comes down for every action but dismiss -- a suspension or
        // ban over a report is not a reason to leave the reported item up.
        if (r.targetType === 'post') {
          // Flagging the post removed only hid it: its media stayed READY, so
          // the raw upload, HLS and preview stayed in storage and at the CDN
          // edge, and GET /media/:id/url handed out the preview URL to anyone
          // holding the id. Taken down like the message and listing branches.
          await prisma.post.update({ where: { id: r.targetId }, data: { removed: true } });
          settledTargetIds = [r.targetId];
          const media = await prisma.media.findMany({ where: { postId: r.targetId }, select: { id: true } });
          takedowns.push(...(await takedownRoots(media.map((m) => m.id), req.log)));
        } else if (r.targetType === 'message') {
          // The message's media is taken down like any NCII takedown (storage,
          // copies, CDN), and its text blanked -- a message has no "removed"
          // flag, and its text is paid content in its own right. Its price
          // goes too: there is nothing left to sell (unlockMessage also
          // refuses an empty or taken-down message, which covers the other
          // broadcast copies of taken-down media).
          //
          // A mass DM is one row PER SUBSCRIBER (workers/broadcast.ts), all
          // sharing the sender and broadcastId. Blanking only the reported
          // copy left every other subscriber's copy with the removed text --
          // still readable by everyone who had unlocked it, and a text-only
          // one still on sale (messageHasDeliverable saw non-empty text).
          // Every copy of the broadcast goes (core/reports.ts). Copies the
          // worker writes AFTER this (a large drop still delivering, or a
          // re-queued failed job) are caught by the worker itself: it sees
          // this report ACTIONED, blanks every copy and stops
          // (core/reports.ts broadcastTakenDown), and the route refuses to
          // queue the same requestId again.
          //
          // Blanked FIRST, with every copy's media rejected in the same
          // transaction, so the removed text and media stop being served
          // before any storage/CDN work starts; then one takedown per
          // distinct root (a drop to N subscribers is N copies of ONE root).
          const ids = await messageAndBroadcastSiblings(r.targetId);
          await prisma.$transaction([
            prisma.message.updateMany({ where: { id: { in: ids } }, data: { text: '', priceCents: 0 } }),
            prisma.media.updateMany({ where: { messageId: { in: ids } }, data: { status: 'REJECTED', hlsKey: null, previewKey: null } }),
          ]);
          const media = await prisma.media.findMany({ where: { messageId: { in: ids } }, select: { id: true } });
          takedowns.push(...(await takedownRoots(media.map((m) => m.id), req.log)));
          settledTargetIds = ids;
        } else if (r.targetType === 'listing') {
          const l = await prisma.listing.findUniqueOrThrow({ where: { id: r.targetId }, select: { saleType: true, status: true } });
          // A live auction is cancelled with the leader's hold returned; a
          // fixed-price listing just leaves sale. Its media comes down too, so
          // it stops being served to past buyers as well.
          //
          // Either way it is stamped moderatedAt, in the same transaction as
          // the removal, and whatever its status (a listing the creator had
          // unlisted themselves before the takedown included). REMOVED alone
          // is also what a creator's own unlist writes, so one PATCH
          // {status:'ACTIVE'} used to undo the takedown; the marketplace
          // PATCH refuses a moderated listing (modules/marketplace.ts).
          // The reason is REPORT whatever was there before -- one the
          // seller's ban had already stamped included: the item itself has
          // now been judged, so it stays hidden from past buyers and an
          // admin's ban restore cannot clear it (core/moderation.ts).
          const moderatedAt = new Date();
          await money(prisma, async (tx) => {
            if (l.saleType === 'AUCTION' && l.status === 'ACTIVE') await cancelAuction(tx, r.targetId, 'removed_by_admin');
            else await tx.listing.updateMany({ where: { id: r.targetId, status: 'ACTIVE' }, data: { status: 'REMOVED' } });
            await tx.listing.updateMany({ where: { id: r.targetId, moderatedAt: null }, data: { moderatedAt } });
            await tx.listing.updateMany({ where: { id: r.targetId }, data: { moderatedReason: 'REPORT' } });
          });
          settledTargetIds = [r.targetId];
          const media = await prisma.media.findMany({ where: { listingId: r.targetId }, select: { id: true } });
          takedowns.push(...(await takedownRoots(media.map((m) => m.id), req.log)));
          // Its free preview photos too: past buyers can still open the
          // listing page (GET /marketplace/listings/:id), which returns them.
          // They are storage keys of the creator's own uploaded images
          // (core/public-images.ts) -- free, public, and quite possibly the
          // reported content itself -- so they are cleared AND taken down
          // like the product media. A legacy value that is still a URL is
          // just purged from the edge.
          const imgs = await prisma.listing.findUnique({ where: { id: r.targetId }, select: { images: true } });
          await prisma.listing.update({ where: { id: r.targetId }, data: { images: [] } });
          const keys = (imgs?.images ?? []).filter((k) => k.startsWith('raw/'));
          const imageMedia = keys.length ? await prisma.media.findMany({ where: { key: { in: keys } }, select: { id: true } }) : [];
          takedowns.push(...(await takedownRoots(imageMedia.map((m) => m.id), req.log)));
          for (const u of (imgs?.images ?? []).filter((k) => !k.startsWith('raw/'))) {
            try { await purgeCdnPrefix(new URL(u).pathname); } catch { /* not a URL: nothing cached under it */ }
          }
        }
        if (action !== 'remove_content') {
          await applyUserStatus(owner!, action === 'ban_user' ? 'BANNED' : 'SUSPENDED', { log: app.log, noDowngrade: true });
        }
        // Last, so a failure above reopens this report with the others
        // still OPEN, and the retry settles them all.
        if (settledTargetIds.length) {
          const others = await prisma.report.findMany({
            where: { targetType: r.targetType, targetId: { in: settledTargetIds }, status: 'OPEN', id: { not: r.id } },
            select: { id: true, reporterId: true, targetId: true, reason: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          });
          if (action === 'ban_user' && others.length) {
            await prisma.report.updateMany({ where: { id: { in: others.map((o) => o.id) }, status: 'OPEN' }, data: { status: 'ACTIONED', resolvedBy: req.user.id } });
            settledReports = others;
          } else {
            openRelatedReports = others;
          }
        }
      }
    } catch (err) {
      // Every step above is safe to repeat (takedowns re-reject, status
      // updates are idempotent), so reopening for a retry is the safe side.
      await prisma.report.updateMany({ where: { id: r.id, status: finalStatus }, data: { status: 'OPEN', resolvedBy: null } });
      throw err;
    }
    const updated = await prisma.report.findUniqueOrThrow({ where: { id: r.id } });
    const ownerStatus = owner ? (await prisma.user.findUnique({ where: { id: owner }, select: { status: true } }))?.status ?? null : null;
    return { ...updated, takedowns, takedownOk: takedowns.every((t) => t.ok), settledReports, openRelatedReports, ownerId: owner ?? null, ownerStatus };
  });

  // Suspend/ban/reactivate, with everything that implies (payout freeze,
  // cancelled subscriptions, delisting, ending a live stream): see
  // core/moderation.ts, shared with the site's status push over the bridge.
  // An admin's decision is never marked as the site's, so the site coming
  // back 'active' cannot lift it.
  const setStatus = (userId: string, status: 'ACTIVE' | 'SUSPENDED' | 'BANNED') =>
    applyUserStatus(userId, status, { log: app.log });
  //
  // A ban takes the creator's listings down with a BAN stamp
  // (core/moderation.ts); reactivating does not clear it by itself. Pass
  // restoreListings: true with status ACTIVE (reversing a mistaken ban, an
  // appeal) to clear every BAN stamp of that creator in the same call, or
  // restore one listing with POST /admin/listings/:id/restore. Either way
  // the listings stay REMOVED until the creator relists them, and a REPORT
  // takedown is never restored. Reactivating a BANNED account also gives
  // its subscribers back what is left of the period they paid for (the ban
  // cancelled those subscriptions), without auto-renew.
  app.post('/users/:id/status', async (req: any, reply) => {
    const { status, restoreListings } = z.object({
      status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']), restoreListings: z.boolean().optional(),
    }).parse(req.body);
    if (restoreListings && status !== 'ACTIVE') return reply.code(400).send({ error: 'restore_needs_active' });
    await setStatus(req.params.id, status);
    if (!restoreListings) return { ok: true };
    return { ok: true, restoredListings: await restoreBanTakedowns({ creatorId: String(req.params.id) }) };
  });

  app.post('/listings/:id/restore', async (req: any, reply) => {
    const id = String(req.params.id ?? '');
    const l = await prisma.listing.findUnique({ where: { id }, select: { moderatedReason: true, creator: { select: { user: { select: { status: true } } } } } });
    if (!l) return reply.code(404).send({ error: 'not_found' });
    if (l.moderatedReason === 'REPORT') return reply.code(409).send({ error: 'report_takedown' });
    if (l.moderatedReason !== 'BAN') return reply.code(409).send({ error: 'not_moderated' });
    if (l.creator.user.status !== 'ACTIVE') return reply.code(409).send({ error: 'seller_not_active' });
    if (!(await restoreBanTakedowns({ listingId: id }))) return reply.code(409).send({ error: 'not_restorable' });
    return { ok: true };
  });

  app.post('/users/:id/kyc', async (req: any) => {
    const { status } = z.object({ status: z.enum(['APPROVED', 'REJECTED', 'PENDING']) }).parse(req.body);
    return prisma.user.update({ where: { id: req.params.id }, data: { kycStatus: status } });
  });

  /**
   * Creators whose payouts are frozen. Reactivation deliberately never lifts
   * a freeze (core/moderation.ts) -- but a frozen creator's POST /payouts is
   * refused before any Payout row exists, so nothing reached the HELD queue
   * and no admin view showed them: a site suspension that lapsed by itself
   * left the creator earning again with their balance unwithdrawable and
   * nobody aware. `activeButFrozen` marks the ones to look at first.
   */
  app.get('/creators/frozen', async (req: any) => {
    const { limit: take, offset: skip } = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query ?? {});
    const rows = await prisma.creatorProfile.findMany({
      where: { payoutsFrozen: true },
      orderBy: { userId: 'asc' }, take, skip,
      select: {
        userId: true, displayName: true,
        user: { select: {
          username: true, status: true, statusBySite: true, siteCreatorStatus: true, siteAccountStatus: true,
          siteSuspendedUntil: true, siteAccountSuspendedUntil: true, siteStatusAt: true, siteAccountStatusAt: true,
          account: { select: { balanceCents: true, withdrawableCents: true } },
        } },
      },
    });
    return rows.map(({ user: { account, ...u }, ...c }) => ({
      ...c, user: u,
      balanceCents: Number(account?.balanceCents ?? 0n),
      withdrawableCents: Number(account?.withdrawableCents ?? 0n),
      activeButFrozen: u.status === 'ACTIVE',
    }));
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
   *    copy (watermarks are cached under the root's id; per-copy prefixes
   *    from the older layout are cleaned in the background). Previously only
   *    the raw object went.
   *  - The CDN edge is purged for the same paths (needs BUNNY_API_KEY); the
   *    response says whether that happened.
   *  - Every message carrying the content (each subscriber's copy of a mass
   *    DM included) has its text blanked and its price zeroed, and a mass DM
   *    still DELIVERING stops: the broadcast worker refuses to write a copy
   *    of a source that is no longer READY and blanks the whole drop. No
   *    Report row is needed for that -- this route writes none.
   *
   * Rows are rejected first, so nothing is served while storage is cleaned.
   * Storage failures are reported, not swallowed: a takedown that silently
   * left files behind is the failure this exists to prevent.
   */
  app.delete('/media/:id', async (req: any) => takedownMedia(String(req.params.id ?? ''), req.log));

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
   *  - hold: PENDING / FAILED -> HELD. RUN THIS BEFORE SENDING ANYTHING BY
   *    HAND. A PENDING payout's queued job would otherwise broadcast its own
   *    transfer alongside the admin's, and a FAILED one stays in the
   *    reconciler's reach, which can refund it on top of a manual payment
   *    (a hand-sent treasury transfer takes the nonce its failed tx held).
   *    HELD is touched by neither. Guarded on status, so a job that already
   *    claimed the payout (now PROCESSING) is never held under it; the
   *    queued job of a held PENDING payout is removed (or no-ops on claim).
   *  - mark_sent {txHash}: from HELD, against the admin's own settlement
   *    transaction; from FAILED / PROCESSING only with the payout's OWN
   *    signed txHash (the worker's transfer that landed). Never from
   *    PENDING -- hold it first. Only against a SUCCESSFUL on-chain
   *    transaction containing a USDG Transfer FROM the treasury
   *    (TREASURY_ADDRESS) TO this payout's address for the payout's amount
   *    (its recorded assetAmount when the worker got that far, else at
   *    least the net amount at $1), and only a hash no other payout already
   *    records (also a unique index). Refused while the payout's worker job
   *    is still queued or running, and when the payout's own signed tx
   *    already succeeded (mark it with that hash instead).
   *  - refund {reason}: PENDING / HELD / FAILED only. A FAILED payout with a
   *    txHash is refused while its receipt shows success; when no receipt
   *    exists the admin must pass acknowledgeUnconfirmed after checking the
   *    explorer, because the tx could still land later.
   *  - release: HELD -> PENDING and re-queued. Refused while the creator is
   *    still frozen or not ACTIVE -- lifting a freeze (POST
   *    /creators/:id/freeze) is its own explicit step -- and refused for a
   *    HELD payout that carries a txHash (held out of FAILED: a signed
   *    transfer may still land, so only mark_sent or refund may settle it).
   *    A payout HELD for a treasury outflow limit (PAYOUT_MAX_CENTS /
   *    PAYOUT_DAILY_MAX_CENTS, workers/payout-worker.ts) is held again by the
   *    worker until it fits; over the per-payout cap, settle it by hand.
   */
  app.post('/payouts/:id/resolve', async (req: any, reply) => {
    const b = z.discriminatedUnion('action', [
      z.object({ action: z.literal('mark_sent'), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
      z.object({ action: z.literal('refund'), reason: z.string().min(3).max(200), acknowledgeUnconfirmed: z.boolean().optional() }),
      z.object({ action: z.literal('release') }),
      z.object({ action: z.literal('hold') }),
    ]).parse(req.body);
    const p = await prisma.payout.findUniqueOrThrow({ where: { id: req.params.id }, include: { creator: { select: { payoutsFrozen: true, user: { select: CREATOR_STANDING_SELECT } } } } });
    const by = { by: req.user.id };

    if (b.action === 'hold') {
      if (!['PENDING', 'FAILED'].includes(p.status)) return reply.code(409).send({ error: 'wrong_status', status: p.status });
      // No queued-job check: every PENDING payout's job sits in BullMQ's
      // 'prioritized' set, so refusing on "queued" made hold impossible. The
      // guarded PENDING/FAILED -> HELD update is what makes this safe -- the
      // worker's claim is itself a guarded PENDING -> PROCESSING update and
      // matches nothing once the row is HELD. A job that already claimed has
      // moved the row to PROCESSING, which the status check above refuses.
      const job = await payoutQueue.getJob(payoutJobId(p.id));
      const ok = await money(prisma, (tx) => holdForManualSettlement(tx, p.id, req.user.id));
      if (!ok) return reply.code(409).send({ error: 'status_changed' });
      // Best effort: drop the now-pointless queued job so a later release can
      // queue a fresh one. If it is already running, remove() fails and the
      // job's claim no-ops on the HELD row.
      if (job) await job.remove().catch(() => {});
      req.log.info({ payoutId: p.id, ...by }, 'payout held for manual settlement');
      return { ok: true, status: 'HELD' };
    }

    if (b.action === 'mark_sent') {
      const hash = b.txHash.toLowerCase() as `0x${string}`;
      const ownTx = !!p.txHash && p.txHash.toLowerCase() === hash;
      if (p.status === 'PENDING') return reply.code(409).send({ error: 'hold_first', status: p.status });
      if (!['PROCESSING', 'FAILED', 'HELD'].includes(p.status)) return reply.code(409).send({ error: 'wrong_status', status: p.status });
      // Settling a PROCESSING / FAILED payout with a transfer the admin sent
      // by hand is exactly the double-pay the hold step exists to prevent:
      // only the payout's own transaction may close it from those states.
      if (p.status !== 'HELD' && !ownTx) return reply.code(409).send({ error: 'hold_first', status: p.status });
      if (p.status === 'PROCESSING' && (await jobInFlight(await payoutQueue.getJob(payoutJobId(p.id))))) {
        return reply.code(409).send({ error: 'payout_in_flight' });
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
    // A HELD payout that carries a txHash was held out of FAILED: a transfer
    // was signed and its outcome is unknown -- it may still land. Releasing
    // it would let the worker sign a SECOND transfer at a new nonce and
    // overwrite the first hash, paying the creator twice. Such a payout is
    // settled only by mark_sent or refund, where the receipt checks apply.
    if (p.txHash) return reply.code(409).send({ error: 'signed_use_mark_sent_or_refund', txHash: p.txHash });
    if (p.creator.payoutsFrozen || p.creator.user.status !== 'ACTIVE') return reply.code(409).send({ error: 'creator_frozen' });
    // Same gate as the worker's claim (workers/payout-worker.ts): a creator
    // whose approval was withdrawn (KYC, or site standing no longer
    // 'active') is not paid by releasing a held payout either.
    if (!creatorMayBePaid(p.creator.user)) return reply.code(409).send({ error: 'creator_not_approved' });
    const r = await prisma.payout.updateMany({ where: { id: p.id, status: 'HELD', txHash: null }, data: { status: 'PENDING', error: null } });
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
    // Only settled swaps count; a PENDING batch may still revert, a FAILED one sold nothing.
    const done = batches.filter((b) => b.status === 'DONE');
    const swappedRaw = done.reduce((s, b) => s + BigInt(b.onlyOneRawIn), 0n);
    const usdcRaw = done.reduce((s, b) => s + BigInt(b.usdcRawOut), 0n);
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
