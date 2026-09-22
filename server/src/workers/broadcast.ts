import { Worker } from 'bullmq';
import { prisma } from '../lib/prisma.js';
import { publish, connection } from '../lib/redis.js';

const pair = (x: string, y: string) => (x < y ? { aId: x, bId: y } : { aId: y, bId: x });

/** Mass PPV drop: one message + its media, fanned out to every active subscriber. */
new Worker('broadcast', async (job) => {
  const { creatorId, text, mediaIds, priceCents } = job.data as {
    creatorId: string; text: string; mediaIds: string[]; priceCents: number;
  };

  const sourceMedia = mediaIds.length
    ? await prisma.media.findMany({ where: { id: { in: mediaIds }, ownerId: creatorId, status: 'READY' } })
    : [];

  const subs = await prisma.subscription.findMany({
    where: { creatorId, status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } },
    select: { fanId: true },
  });

  for (const { fanId } of subs) {
    const conv = await prisma.conversation.upsert({
      where: { aId_bId: pair(creatorId, fanId) },
      create: pair(creatorId, fanId),
      update: { updatedAt: new Date() },
    });
    const msg = await prisma.message.create({ data: { conversationId: conv.id, senderId: creatorId, text, priceCents } });
    if (sourceMedia.length) {
      await prisma.media.createMany({
        data: sourceMedia.map((m) => ({
          ownerId: creatorId, key: m.key, hlsKey: m.hlsKey, previewKey: m.previewKey,
          mime: m.mime, bytes: m.bytes, status: m.status, messageId: msg.id,
        })),
      });
    }
    // Same redaction as the single-DM path (modules/messages.ts) -- a priced
    // broadcast's text is paywalled content, not a free teaser, so it can't
    // go out over the realtime push before the fan has unlocked it.
    const locked = msg.priceCents > 0;
    await publish(fanId, { type: 'message', message: { ...msg, text: locked ? '' : msg.text, locked } });
  }
}, { ...connection, concurrency: 1 });
