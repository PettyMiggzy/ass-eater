import { Worker } from 'bullmq';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { publish, connection } from '../lib/redis.js';
import { broadcastCopyKey } from '../core/media-key.js';
import { registerWorker } from './process-guards.js';
import { broadcastTakenDown, blankBroadcast } from '../core/reports.js';
import { assertNotPublicImages, MediaIsPublicImage } from '../core/public-images.js';
import { CREATOR_STANDING_SELECT, creatorMayBePaid } from '../core/creator-standing.js';
import type { Tx } from '../core/ledger.js';

const pair = (x: string, y: string) => (x < y ? { aId: x, bId: y } : { aId: y, bId: x });

/** A source media row of this drop is no longer READY (taken down, or otherwise gone). */
class SourceTakenDown extends Error {}
/** A source became a listing's product since the job started (it is somebody's paid item now). */
class SourceAttached extends Error {}
/** A source became an avatar, banner or listing preview photo since the job started. */
class SourceBecamePublic extends Error {}
/** The creator lost approval (or was suspended/banned) part-way through the drop. */
class CreatorNotApproved extends Error {}

/**
 * Per-copy source check, run first in each copy's transaction: locks the
 * source rows (FOR UPDATE, in id order) and TOUCHES them (a no-op UPDATE),
 * holding both until the copy commits, and reports why they can no longer be
 * copied. Exported for the race tests.
 *
 * Why lock-and-touch rather than FOR SHARE: the listing and public-image
 * paths (modules/marketplace.ts assertNotDistributed, core/public-images.ts
 * assertOwnPublicImages) lock the same rows before counting copies. The lock
 * makes a read-committed checker wait for this copy and count it in its next
 * statement; the touch makes a SERIALIZABLE checker (money()) that waited on
 * it fail with a serialization error and retry, where a FOR SHARE alone would
 * let it continue on its old snapshot and count 0 copies. And a checker that
 * committed first is seen here: the UPDATE re-evaluates listingId on the
 * latest row version.
 */
export async function claimSourcesForCopy(tx: Pick<Tx, '$queryRaw'>, sourceIds: string[]) {
  if (!sourceIds.length) return;
  await tx.$queryRaw`SELECT id FROM "Media" WHERE id IN (${Prisma.join(sourceIds)}) ORDER BY id FOR UPDATE`;
  const live = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "Media" SET status = status
     WHERE id IN (${Prisma.join(sourceIds)}) AND status = 'READY' AND "listingId" IS NULL
     RETURNING id`;
  if (live.length === sourceIds.length) return;
  const rows = await tx.$queryRaw<{ status: string; listingId: string | null }[]>`
    SELECT status::text AS status, "listingId" FROM "Media" WHERE id IN (${Prisma.join(sourceIds)})`;
  if (rows.length !== sourceIds.length || rows.some((r) => r.status !== 'READY')) throw new SourceTakenDown();
  throw new SourceAttached();
}

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
 *
 * Stoppable: once an admin takes the drop down (a report on any copy,
 * resolved with any action but dismiss, or a direct media takedown), the job
 * stops sending and blanks whatever copies it had written -- see
 * core/reports.ts broadcastTakenDown and the per-copy source check below.
 */
export type BroadcastJobData = {
  creatorId: string; text: string; mediaIds: string[]; priceCents: number; broadcastId?: string; contentHash?: string;
};

/** One broadcast job (exported so the takedown interplay is testable without BullMQ). */
export async function processBroadcast(data: BroadcastJobData, jobId: string | undefined) {
  const { creatorId, text, mediaIds, priceCents } = data;
  // Jobs queued before broadcastId existed fall back to the BullMQ job id,
  // which is stable across that job's retries.
  const broadcastId = data.broadcastId ?? `job:${jobId}`;

  // A creator suspended, banned, or no longer APPROVED (KYC demoted, or the
  // site moved them back to 'pending' -- e.g. their §2257 record was
  // archived) between queueing and sending sends nothing. Same gate as every
  // other creator action (core/creator-standing.ts); status alone let a drop
  // queued while approved go out after approval was withdrawn.
  const creator = await prisma.user.findUnique({ where: { id: creatorId }, select: CREATOR_STANDING_SELECT });
  if (!creatorMayBePaid(creator)) return { skipped: 'creator_not_approved' };

  // An admin removed this drop (a report on any copy, actioned) before or
  // while an earlier attempt of it was delivering. Re-sending it -- a retry,
  // or the creator re-queueing the same requestId -- would put the removed
  // content back in front of the fans that attempt never reached.
  if (await broadcastTakenDown(creatorId, broadcastId)) {
    await blankBroadcast(creatorId, broadcastId);
    return { skipped: 'taken_down' };
  }

  const sourceMedia = mediaIds.length
    ? await prisma.media.findMany({ where: { id: { in: mediaIds }, ownerId: creatorId, status: 'READY', listingId: null, sourceMediaId: null } })
    : [];
  // All or nothing. The route checks this at queue time, but media can be
  // taken down (REJECTED) or attached to a listing between then and now; a priced message that went
  // out with part of its content missing would still be sold at full price
  // to every subscriber. Sends nothing rather than something partial. Not
  // thrown: a retry cannot make missing media reappear.
  if (sourceMedia.length !== new Set(mediaIds).size) {
    console.error('broadcast: skipped, requested media missing or not READY', { broadcastId, creatorId, requested: mediaIds.length, ready: sourceMedia.length });
    return { skipped: 'media_not_ready' };
  }
  // Nor media that became an avatar, banner or listing preview photo since
  // it was queued: free to everyone, so never sold as a priced drop
  // (core/public-images.ts; the route checks the same at queue time).
  try { await assertNotPublicImages(prisma, mediaIds); } catch {
    console.error('broadcast: skipped, media is now a public image', { broadcastId, creatorId });
    return { skipped: 'media_is_public_image' };
  }

  const subs = await prisma.subscription.findMany({
    where: { creatorId, status: 'ACTIVE', currentPeriodEnd: { gt: new Date() } },
    select: { fanId: true },
  });

  const sourceIds = sourceMedia.map((s) => s.id);
  for (const { fanId } of subs) {
    let msg;
    try {
      msg = await prisma.$transaction(async (tx) => {
        // The source is re-checked for EVERY copy, holding its rows locked
        // until this copy commits. sourceMedia above is a snapshot
        // from the start of the job, and a takedown with no Report (DELETE
        // /admin/media/:id) used to go unnoticed: every copy written after
        // it was created READY and priced, pointing at deleted objects, and
        // sold. The lock orders this against the takedown (modules/admin.ts
        // rejects the root first, then the copies in a later statement): a
        // copy committed first is caught by that later statement, and a
        // takedown committed first is seen here.
        //
        // It also catches a source that became a listing's product or a
        // public image after the start-of-job snapshot, and is serialized
        // against those paths (claimSourcesForCopy above): a one-of-a-kind
        // listing created in the gap before the first copy committed used to
        // pass its "no copies yet" check and then be copied to every
        // subscriber.
        await claimSourcesForCopy(tx, sourceIds);
        if (sourceIds.length) {
          try { await assertNotPublicImages(tx, sourceIds); } catch (e) {
            if (e instanceof MediaIsPublicImage) throw new SourceBecamePublic();
            throw e;
          }
        }
        // Approval re-checked for every copy, so a long fan-out stops once
        // it is lost (copies already delivered stay: see creator-standing.ts).
        if (!creatorMayBePaid(await tx.user.findUnique({ where: { id: creatorId }, select: CREATOR_STANDING_SELECT }))) throw new CreatorNotApproved();
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
      if (e instanceof SourceTakenDown) {
        await blankBroadcast(creatorId, broadcastId);
        return { stopped: 'source_taken_down' };
      }
      // Stopped, NOT blanked: nothing was taken down. The listing / public
      // image paths refuse media that already has copies, so if one of them
      // won the race no copy of it exists to blank; and fans already reached
      // keep what they were sent (and may have paid for).
      if (e instanceof SourceAttached) return { stopped: 'source_attached' };
      if (e instanceof SourceBecamePublic) return { stopped: 'media_is_public_image' };
      if (e instanceof CreatorNotApproved) return { stopped: 'creator_not_approved' };
      // Already sent to this fan by an earlier attempt of this same job.
      // Only the (conversationId, broadcastId) index means that; any other
      // conflict is thrown so the job retries and resumes from here.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && String(e.meta?.target ?? '').includes('broadcastId')) continue;
      throw e;
    }
    // Checked AFTER the copy commits, not before: the admin's resolve marks
    // the report ACTIONED and then blanks the copies that exist. If that
    // mark is visible now, this copy may have committed after the blanking
    // ran, so blank everything and stop; if it is not visible yet, the
    // blanking has not run yet either and will see this copy. Either way no
    // copy keeps the removed content, and nothing is pushed to the fan.
    if (await broadcastTakenDown(creatorId, broadcastId)) {
      await blankBroadcast(creatorId, broadcastId);
      return { stopped: 'taken_down' };
    }
    // Same redaction as the single-DM path (modules/messages.ts) -- a priced
    // broadcast's text is paywalled content, not a free teaser, so it can't
    // go out over the realtime push before the fan has unlocked it.
    const locked = msg.priceCents > 0;
    await publish(fanId, { type: 'message', message: { ...msg, text: locked ? '' : msg.text, locked } });
  }
  return { sent: true };
}

if (process.env.NODE_ENV !== 'test') {
  registerWorker(new Worker('broadcast', (job) => processBroadcast(job.data as BroadcastJobData, job.id), { ...connection, concurrency: 1 }));
}
