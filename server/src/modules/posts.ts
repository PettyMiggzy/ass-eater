import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { charge, money } from '../core/ledger';
import { canViewPost } from '../core/access';

// strip locked media down to preview thumbnails, and locked text down to a
// teaser that can never be the whole thing
const TEASER_CHARS = 80;

const redact = async (userId: string | null, posts: any[]) =>
  Promise.all(posts.map(async (p) => {
    const ok = await canViewPost(userId, p);
    // A PPV post's own text is a paywalled good in its own right, exactly
    // like a priced DM's (see modules/messages.ts) -- blank it outright, not
    // tease it. And truncating only redacts when there's genuinely more text
    // behind the cut: a locked post at or under TEASER_CHARS was being handed
    // over in full, for free.
    const teaser = p.visibility === 'PPV' || p.text.length <= TEASER_CHARS ? '' : p.text.slice(0, TEASER_CHARS);
    return { ...p, locked: !ok, text: ok ? p.text : teaser,
      media: p.media.map((m: any) => ok ? { id: m.id, mime: m.mime, status: m.status, previewKey: m.previewKey } : { id: m.id, mime: m.mime, previewKey: m.previewKey, locked: true }) };
  }));

export const posts: FastifyPluginAsync = async (app) => {
  app.post('/', { preHandler: app.creatorOk }, async (req) => {
    const b = z.object({
      text: z.string().max(5000).default(''), visibility: z.enum(['PUBLIC', 'SUBSCRIBERS', 'PPV']).default('SUBSCRIBERS'),
      priceCents: z.number().int().min(0).max(50_000).default(0), mediaIds: z.array(z.string().uuid()).max(20).default([]),
    }).parse(req.body);
    if (b.visibility === 'PPV' && b.priceCents < 100) throw Object.assign(new Error('ppv_min_price'), { statusCode: 400 });
    return prisma.$transaction(async (tx) => {
      const p = await tx.post.create({ data: { creatorId: req.user.id, text: b.text, visibility: b.visibility, priceCents: b.visibility === 'PPV' ? b.priceCents : 0 } });
      if (b.mediaIds.length) {
        const r = await tx.media.updateMany({ where: { id: { in: b.mediaIds }, ownerId: req.user.id, postId: null, messageId: null }, data: { postId: p.id } });
        if (r.count !== b.mediaIds.length) throw Object.assign(new Error('bad_media'), { statusCode: 400 });
      }
      return tx.post.findUnique({ where: { id: p.id }, include: { media: true } });
    });
  });

  app.get('/creator/:creatorId', async (req: any) => {
    let userId: string | null = null;
    try { await req.jwtVerify(); userId = req.user.id; } catch {}
    const rows = await prisma.post.findMany({
      where: { creatorId: req.params.creatorId, removed: false },
      include: { media: true, _count: { select: { unlocks: true } } },
      orderBy: { createdAt: 'desc' }, take: 20, skip: Number(req.query.offset ?? 0),
    });
    return redact(userId, rows);
  });

  app.get('/feed', { preHandler: app.auth }, async (req: any) => {
    const subs = await prisma.subscription.findMany({ where: { fanId: req.user.id, currentPeriodEnd: { gt: new Date() } }, select: { creatorId: true } });
    const rows = await prisma.post.findMany({
      where: { creatorId: { in: subs.map(s => s.creatorId) }, removed: false },
      include: { media: true, creator: { select: { displayName: true, avatarKey: true, user: { select: { username: true } } } } },
      orderBy: { createdAt: 'desc' }, take: 30, skip: Number(req.query.offset ?? 0),
    });
    return redact(req.user.id, rows);
  });

  app.post('/:id/unlock', { preHandler: app.auth }, async (req: any, reply) => {
    return money(prisma, async (tx) => {
      const p = await tx.post.findUniqueOrThrow({ where: { id: req.params.id } });
      if (p.visibility !== 'PPV' || p.removed) return reply.code(400).send({ error: 'not_ppv' });
      const already = await tx.postUnlock.findUnique({ where: { fanId_postId: { fanId: req.user.id, postId: p.id } } });
      if (already) return { ok: true, already: true };
      await tx.postUnlock.create({ data: { fanId: req.user.id, postId: p.id } });
      const r = await charge(tx, { fanId: req.user.id, creatorId: p.creatorId, grossCents: p.priceCents, type: 'PPV', refId: p.id });
      return { ok: true, ...r };
    });
  });

  app.delete('/:id', { preHandler: app.auth }, async (req: any) => {
    await prisma.post.updateMany({ where: { id: req.params.id, creatorId: req.user.id }, data: { removed: true } });
    return { ok: true };
  });

  app.post('/:id/report', { preHandler: app.auth }, async (req: any) => {
    const { reason } = z.object({ reason: z.string().max(500) }).parse(req.body);
    return prisma.report.create({ data: { reporterId: req.user.id, targetType: 'post', targetId: req.params.id, reason } });
  });
};
