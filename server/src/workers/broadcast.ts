import { Worker } from 'bullmq';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { publish, connection } from '../lib/redis.js';
import { broadcastCopyKey } from '../core/media-key.js';

const pair = (x: string, y: string) => (x < y ? { aId: x, bId: y } : { aId: y, bId: x });

/**
 * Mass PPV drop: one message + its media, fanned out to every active subscriber.
 *
 * Each fan's message and its media copies are written in ONE transaction, so a
 * failure can never leave a fan holding a priced message with nothing in it.
 * Copies get their own unique key (`<source key>#<messageId>`, resolved back
 * to the real object by core/media-key.ts) -- reusing the source key hit the
 * Media.key unique index, so every media broadcast used to fail after the
 * first fan and reach nobody else.
 *
 * Resumable: every message carries the job's broadcastId, unique per
 * conversation, so a retried job skips fans it already reached.
 */
new Worker('broadcast', async (job) => {
  const { creatorId, text, mediaIds, priceCents } = job.data as {
    creatorId: string; text: string; mediaIds: string[]; priceCents: number; broadcastId?: string;
  };
  // Jobs queued before broadcastId existed fall back to the BullMQ job id,
  // which is stable across that job's retries.
  const broadcastId = (job.data as { broadcastId?: string }).broadcastId ?? `job:${job.id}`;

  // A creator suspended or banned between queueing and sending sends nothing.
  const creator = await prisma.user.findUnique({ where: { id: creatorId }, select: { status: true } });
  if (creator?.status !== 'ACTIVE') return;

  const sourceMedia = mediaIds.length
    ? await prisma.media.findMany({ where: { id: { in: mediaIds }, ownerId: creatorId, status: 'READY', sourceMediaId: null } })
    : [];

  const subs = await prisma.subscription.findMany({
    where: { creatorId, status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } },
    select: { fanId: true },
  });

  for (const { fanId } of subs) {
    let msg;
    try {
      msg = await prisma.$transaction(async (tx) => {
        const conv = await tx.conversation.upsert({
          where: { aId_bId: pair(creatorId, fanId) },
          create: pair(creatorId, fanId),
          update: { updatedAt: new Date() },
        });
        const m = await tx.message.create({ data: { conversationId: conv.id, senderId: creatorId, text, priceCents, broadcastId } });
        if (sourceMedia.length) {
          await tx.media.createMany({
            data: sourceMedia.map((s) => ({
              ownerId: creatorId, key: broadcastCopyKey(s.key, m.id), sourceMediaId: s.id, hlsKey: s.hlsKey, previewKey: s.previewKey,
              mime: s.mime, bytes: s.bytes, status: s.status, messageId: m.id,
            })),
          });
        }
        return m;
      });
    } catch (e) {
      // Already sent to this fan by an earlier attempt of this same job.
      // Only the (conversationId, broadcastId) index means that; any other
      // conflict is thrown so the job retries and resumes from here.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && String(e.meta?.target ?? '').includes('broadcastId')) continue;
      throw e;
    }
    // Same redaction as the single-DM path (modules/messages.ts) -- a priced
    // broadcast's text is paywalled content, not a free teaser, so it can't
    // go out over the realtime push before the fan has unlocked it.
    const locked = msg.priceCents > 0;
    await publish(fanId, { type: 'message', message: { ...msg, text: locked ? '' : msg.text, locked } });
  }
}, { ...connection, concurrency: 1 });
