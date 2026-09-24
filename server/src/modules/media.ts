import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { prisma } from '../lib/prisma.js';
import { presignPut, headObject, cdnSignedUrl, cdnPublicUrlOrNull } from '../lib/s3.js';
import { transcodeQueue } from '../lib/redis.js';
import { canViewMedia, creatorMayOperate } from '../core/access.js';
import { getOrCreateWatermarkedUrl, traceCode } from '../lib/watermark.js';
import { storageKeyOf } from '../core/media-key.js';
import { maxBytesFor, createUploadWithinQuota } from '../core/upload-limits.js';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm']);

export const media: FastifyPluginAsync = async (app) => {
  app.post('/upload-url', { preHandler: app.auth }, async (req, reply) => {
    const b = z.object({ mime: z.string(), bytes: z.number().int().positive() }).parse(req.body);
    if (!ALLOWED.has(b.mime)) return reply.code(400).send({ error: 'unsupported_type' });
    const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true, kycStatus: true, siteUid: true, siteCreatorStatus: true } });
    const isCreator = creatorMayOperate(me);
    if (b.bytes > maxBytesFor(b.mime, isCreator)) return reply.code(413).send({ error: 'too_large', maxBytes: maxBytesFor(b.mime, isCreator) });
    const id = nanoid(16);
    const key = `raw/${req.user.id}/${id}`;
    // Quota check and row insert are one serialized step per account.
    const r = await createUploadWithinQuota(req.user.id, isCreator, { key, mime: b.mime, bytes: b.bytes });
    if ('error' in r) return reply.code(429).send({ error: r.error });
    const m = r.media;
    return { mediaId: m.id, uploadUrl: await presignPut(key, b.mime, b.bytes), method: 'PUT', headers: { 'Content-Type': b.mime } };
  });

  app.post('/:id/complete', { preHandler: app.auth }, async (req: any, reply) => {
    const m = await prisma.media.findFirst({ where: { id: req.params.id, ownerId: req.user.id, status: 'UPLOADING' } });
    if (!m) return reply.code(404).send({ error: 'not_found' });
    const head = await headObject(m.key).catch(() => null);
    if (!head) return reply.code(400).send({ error: 'upload_missing' });
    // Claim the UPLOADING -> PROCESSING transition atomically. The findFirst
    // above is not a guard on its own: two /complete calls landing together
    // both saw UPLOADING, both updated, and both enqueued, so the same media
    // was transcoded twice with the two runs writing over each other's HLS
    // output. Only the request that actually flips the row enqueues.
    const claimed = await prisma.media.updateMany({
      where: { id: m.id, ownerId: req.user.id, status: 'UPLOADING' },
      data: { status: 'PROCESSING', bytes: Number(head.ContentLength ?? m.bytes) },
    });
    if (!claimed.count) {
      // Someone else already claimed it -- the caller's intent is satisfied
      // either way, so report where it actually got to rather than erroring.
      const cur = await prisma.media.findUniqueOrThrow({ where: { id: m.id }, select: { status: true } });
      return { ok: true, status: cur.status };
    }
    // Deterministic jobId: BullMQ ignores an add() for an id that already
    // exists, so even a re-queue by hand can't stack a second live job for the
    // same media. That dedup is only wanted while a job is still pending,
    // though -- BullMQ matches *retained* completed and failed jobs too, so any
    // retention here burns `transcode-<id>` and silently swallows every later
    // re-add for that media. A count (removeOnComplete: 500) is not a drop
    // either; it keeps the last 500. Both are therefore true, so a transcode
    // that failed all its attempts can actually be re-queued by hand. The
    // durable record of how one ended is the Media row (READY or REJECTED,
    // written by workers/transcode.ts), not BullMQ's job sets. No ':' in the id
    // -- BullMQ rejects custom ids containing one.
    await transcodeQueue.add('transcode', { mediaId: m.id }, { jobId: `transcode-${m.id}`, attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: true });
    return { ok: true, status: 'PROCESSING' };
  });

  /** Returns short-lived signed URL. Front end refreshes when it expires. */
  app.get('/:id/url', async (req: any, reply) => {
    let userId: string | null = null;
    try { await req.jwtVerify(); userId = req.user.id; } catch {}
    const { ok, m } = await canViewMedia(userId, req.params.id);
    if (!ok || !m) return reply.code(403).send({ error: 'locked', preview: m?.previewKey ? cdnPublicUrlOrNull(`/${m.previewKey}`) : null });

    const viewer = userId && userId !== m.ownerId
      ? await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
      : null;

    if (m.hlsKey) {
      const dir = m.hlsKey.slice(0, m.hlsKey.lastIndexOf('/') + 1);
      // No per-viewer mark baked into the HLS segments (that needs a per-viewer
      // transcode, which is a bigger project) -- the client renders `watermark`
      // as a repositioning on-screen overlay during playback as a deterrent.
      return {
        type: 'hls', url: cdnSignedUrl(`/${m.hlsKey}`, 900, `/${dir}`), expiresIn: 900,
        watermark: viewer ? { label: viewer.username, code: traceCode(m.id, userId!) } : null,
      };
    }

    // A mass-DM copy's key carries a '#<messageId>' suffix; the object is
    // the source's (core/media-key.ts).
    const objectKey = storageKeyOf(m.key);
    if (viewer) {
      const key = await getOrCreateWatermarkedUrl(m.id, objectKey, userId!, viewer.username);
      return { type: 'image', url: cdnSignedUrl(`/${key}`, 900), expiresIn: 900 };
    }
    return { type: 'image', url: cdnSignedUrl(`/${objectKey}`, 900), expiresIn: 900 };
  });

  app.get('/mine', { preHandler: app.auth }, async (req: any) =>
    prisma.media.findMany({ where: { ownerId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100 }));
};
