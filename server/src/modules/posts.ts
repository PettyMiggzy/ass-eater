import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { charge, money, isVip, type Tx } from '../core/ledger.js';
import { canViewPost, creatorIsActive, inVipWindow, type ViewMemo } from '../core/access.js';
import { page } from '../plugins/pagination.js';
import { fileReport } from '../core/reports.js';
import type { MediaStatus } from '@prisma/client';
import { withProfileImageUrls, assertNotPublicImages } from '../core/public-images.js';

// strip locked media down to preview thumbnails, and locked text down to a
// teaser that can never be the whole thing
const TEASER_CHARS = 80;

const redact = async (userId: string | null, posts: any[]) => {
  const memo: ViewMemo = new Map();
  return Promise.all(posts.map(async (p) => {
    const ok = await canViewPost(userId, p, memo);
    // A PPV post's own text is a paywalled good in its own right, exactly
    // like a priced DM's (see modules/messages.ts) -- blank it outright, not
    // tease it. And truncating only redacts when there's genuinely more text
    // behind the cut: a locked post at or under TEASER_CHARS was being handed
    // over in full, for free.
    const teaser = p.visibility === 'PPV' || p.text.length <= TEASER_CHARS ? '' : p.text.slice(0, TEASER_CHARS);
    return { ...p, locked: !ok, text: ok ? p.text : teaser,
      media: p.media.map((m: any) => ok ? { id: m.id, mime: m.mime, status: m.status, previewKey: m.previewKey } : { id: m.id, mime: m.mime, previewKey: m.previewKey, locked: true }) };
  }));
};

/**
 * Keeps a post inside its VIP early-access window out of a non-VIP's list
 * entirely, rather than returning it redacted.
 *
 * Filtered in the query on purpose: a redacted row still tells a non-member
 * that something exists, when it dropped and roughly how big it is, which is
 * most of what the window is selling. The creator always sees their own.
 */
export async function earlyAccessFilter(viewerId: string | null) {
  const vip = viewerId ? await isVip(prisma, viewerId) : false;
  if (vip) return {};
  const now = new Date();
  return {
    OR: [
      { vipEarlyUntil: null },
      { vipEarlyUntil: { lte: now } },
      ...(viewerId ? [{ creatorId: viewerId }] : []),
    ],
  };
}

/**
 * Charges a fan for a PPV post and records the unlock. Exported (not inlined
 * in the route) so the double-click race below is directly testable against
 * a real Postgres connection, with no Fastify harness needed.
 *
 * Caller must already have confirmed `post.visibility === 'PPV'` and that
 * the fan hasn't already unlocked it -- that pre-check is a cheap, common
 * path, but it does NOT close the race: two concurrent requests can both
 * pass it before either commits.
 */
export async function unlockPost(fanId: string, post: { id: string; creatorId: string; priceCents: number }) {
  try {
    return await money(prisma, async (tx) => {
      // Nothing is sold unless something viewable is behind the paywall --
      // the same rule as a listing's hasDeliverable (core/auctions.ts).
      // Re-read inside the charge's transaction: media can be taken down
      // (REJECTED) after the post was created, and the creator can delete
      // the post after the route read it.
      if (!(await postHasDeliverable(tx, post.id))) throw Object.assign(new Error('no_deliverable'), { statusCode: 409 });
      await tx.postUnlock.create({ data: { fanId, postId: post.id } });
      const r = await charge(tx, { fanId, creatorId: post.creatorId, grossCents: post.priceCents, type: 'PPV', refId: post.id });
      return { ok: true, ...r };
    });
  } catch (e: any) {
    // A genuine double-click: two concurrent requests both passed the
    // caller's pre-check before either had created its row. The loser hits
    // the unique constraint on (fanId, postId), which rolls its whole
    // transaction back -- same P2002 race live.ts already handles for
    // ticket/minute purchases.
    //
    // The re-read below MUST run on the plain `prisma` client, never on
    // `tx`: Postgres aborts an entire transaction after any statement error
    // until it's rolled back, so a second query against the same `tx` here
    // would itself throw 25P02 ("current transaction is aborted") instead
    // of returning the row -- the first version of this fix made exactly
    // that mistake and never actually closed the race, it just traded a
    // raw P2002 for a raw 25P02. `money()` has already rolled the
    // transaction back by the time this catch runs, so `prisma` is a fresh
    // connection and free to query normally. See
    // posts.unlock-race.test.ts for a real-Postgres regression proving
    // this against the wrong (tx-based) version.
    if (e.code !== 'P2002') throw e;
    const bought = await prisma.postUnlock.findUnique({ where: { fanId_postId: { fanId, postId: post.id } } });
    if (!bought) throw e;
    return { ok: true, already: true };
  }
}

/**
 * Is there something a buyer of this PPV post would actually get? It must
 * still be a PPV post that is not removed (canViewPost shows a removed post
 * to nobody, and the route's own check runs on a row read BEFORE the charge's
 * transaction -- a creator's DELETE committing in between used to be sold
 * anyway), every attached media item must be READY (canViewMedia refuses
 * anything else, so a buyer of a post with a still-uploading or REJECTED item
 * gets a 403 for it), and a post with no media must have text. A post with
 * neither is refused.
 */
export async function postHasDeliverable(tx: Tx, postId: string) {
  const post = await tx.post.findUnique({ where: { id: postId }, select: { text: true, removed: true, visibility: true, media: { select: { status: true } } } });
  if (!post || post.removed || post.visibility !== 'PPV') return false;
  if (post.media.some((m) => m.status !== 'READY')) return false;
  return post.media.length > 0 || post.text.trim().length > 0;
}

export const posts: FastifyPluginAsync = async (app) => {
  app.post('/', { preHandler: app.creatorOk }, async (req) => {
    const b = z.object({
      text: z.string().max(5000).default(''), visibility: z.enum(['PUBLIC', 'SUBSCRIBERS', 'PPV']).default('SUBSCRIBERS'),
      priceCents: z.number().int().min(0).max(50_000).default(0), mediaIds: z.array(z.string().uuid()).max(20).default([]),
      // Hours this post is VIP-only before everyone else sees it. Capped at
      // 72: past that it stops being early access and starts being a second
      // paywall on content subscribers already paid for.
      earlyAccessHours: z.number().int().min(0).max(72).default(0),
    }).parse(req.body);
    if (b.visibility === 'PPV' && b.priceCents < 100) throw Object.assign(new Error('ppv_min_price'), { statusCode: 400 });
    const ids = [...new Set(b.mediaIds)];
    if (ids.length !== b.mediaIds.length) throw Object.assign(new Error('bad_media'), { statusCode: 400 });
    // A PPV post is a paid good: it must have something in it. Mirrors the
    // priced-broadcast rule (modules/messages.ts POST /broadcast).
    if (b.visibility === 'PPV' && !ids.length && !b.text.trim()) throw Object.assign(new Error('empty_post'), { statusCode: 400 });
    return prisma.$transaction(async (tx) => {
      const p = await tx.post.create({ data: { creatorId: req.user.id, text: b.text, visibility: b.visibility, priceCents: b.visibility === 'PPV' ? b.priceCents : 0, vipEarlyUntil: b.earlyAccessHours ? new Date(Date.now() + b.earlyAccessHours * 3600_000) : null } });
      if (ids.length) {
        // Unattached originals only: media already sold as a marketplace
        // listing's product (listingId) or a mass-DM copy (sourceMediaId) is
        // never re-homed onto a post -- see core/access.ts canViewMedia.
        //
        // REJECTED media is never attached (it can never be viewed). A PPV
        // post additionally needs every item READY, exactly like a priced DM:
        // an UPLOADING item may never complete (and is swept after 24h by
        // workers/transcode.ts) and a PROCESSING one may still be REJECTED,
        // so fans would pay for media they can never open. Free/subscriber
        // posts may attach an item still transcoding; it appears once READY.
        const found = await tx.media.findMany({ where: { id: { in: ids }, ownerId: req.user.id, postId: null, messageId: null, listingId: null, sourceMediaId: null }, select: { status: true } });
        if (found.length !== ids.length) throw Object.assign(new Error('bad_media'), { statusCode: 400 });
        const okStatuses: MediaStatus[] = b.visibility === 'PPV' ? ['READY'] : ['UPLOADING', 'PROCESSING', 'READY'];
        if (found.some((m) => !okStatuses.includes(m.status))) throw Object.assign(new Error('media_not_ready'), { statusCode: 400 });
        // Never an avatar, banner or listing preview photo: those are free
        // to everyone, unwatermarked (core/public-images.ts).
        await assertNotPublicImages(tx, ids);
        const r = await tx.media.updateMany({ where: { id: { in: ids }, ownerId: req.user.id, postId: null, messageId: null, listingId: null, sourceMediaId: null, status: { in: okStatuses } }, data: { postId: p.id } });
        if (r.count !== ids.length) throw Object.assign(new Error('bad_media'), { statusCode: 400 });
      }
      return tx.post.findUnique({ where: { id: p.id }, include: { media: true } });
    });
  });

  app.get('/creator/:creatorId', async (req: any) => {
    let userId: string | null = null;
    try { await req.jwtVerify(); userId = req.user.id; } catch {}
    // A suspended or banned creator's posts are gone for everyone but them.
    if (req.params.creatorId !== userId && !(await creatorIsActive(String(req.params.creatorId ?? '')))) return [];
    const rows = await prisma.post.findMany({
      where: { creatorId: req.params.creatorId, removed: false, ...(await earlyAccessFilter(userId)) },
      include: { media: true, _count: { select: { unlocks: true } } },
      orderBy: { createdAt: 'desc' }, take: 20, skip: page(req.query).offset,
    });
    return redact(userId, rows);
  });

  app.get('/feed', { preHandler: app.auth }, async (req: any) => {
    const subs = await prisma.subscription.findMany({ where: { fanId: req.user.id, currentPeriodEnd: { gt: new Date() } }, select: { creatorId: true } });
    const rows = await prisma.post.findMany({
      where: { creatorId: { in: subs.map(s => s.creatorId) }, removed: false, creator: { user: { status: 'ACTIVE' } }, ...(await earlyAccessFilter(req.user.id)) },
      include: { media: true, creator: { select: { displayName: true, avatarKey: true, user: { select: { username: true } } } } },
      orderBy: { createdAt: 'desc' }, take: 30, skip: page(req.query).offset,
    });
    return redact(req.user.id, rows.map((r) => ({ ...r, creator: withProfileImageUrls(r.creator) })));
  });

  app.post('/:id/unlock', { preHandler: app.auth }, async (req: any, reply) => {
    const p = await prisma.post.findUniqueOrThrow({ where: { id: req.params.id } });
    if (p.visibility !== 'PPV' || p.removed) return reply.code(400).send({ error: 'not_ppv' });
    // The list hides a post inside its VIP window; this is the gate for a
    // non-VIP who was handed the id.
    if (await inVipWindow(p, req.user.id)) return reply.code(403).send({ error: 'vip_early_access' });
    if (await prisma.postUnlock.findUnique({ where: { fanId_postId: { fanId: req.user.id, postId: p.id } } })) return { ok: true, already: true };
    return unlockPost(req.user.id, p);
  });

  app.delete('/:id', { preHandler: app.auth }, async (req: any) => {
    await prisma.post.updateMany({ where: { id: req.params.id, creatorId: req.user.id }, data: { removed: true } });
    return { ok: true };
  });

  app.post('/:id/report', { preHandler: app.auth, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req: any, reply) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    const p = await prisma.post.findUnique({ where: { id: String(req.params.id ?? '') }, select: { id: true, creatorId: true } });
    if (!p) return reply.code(404).send({ error: 'not_found' });
    return fileReport(req.user.id, 'post', p.id, reason);
  });
};
