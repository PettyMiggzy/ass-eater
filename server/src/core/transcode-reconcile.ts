import { prisma } from '../lib/prisma.js';
import { jobInFlight } from './payout-queue.js';

/**
 * Recovery for media stuck in PROCESSING.
 *
 * POST /media/:id/complete moves a row UPLOADING -> PROCESSING and then
 * enqueues its transcode job. Before this, nothing else ever moved a row out
 * of PROCESSING except the worker's own last-attempt catch, so two ordinary
 * events stranded an upload forever -- the post or DM it belonged to never
 * got its content, and /complete refused to run again (the row was no longer
 * UPLOADING):
 *
 *  - the enqueue itself failing (a Redis blip) after the row was switched;
 *  - the job being lost without its catch running: a worker SIGKILLed twice
 *    mid-transcode (a redeploy past TimeoutStopSec, the MemoryMax OOM killer)
 *    exceeds BullMQ's maxStalledCount, and removeOnFail deletes it.
 *
 * Every PROCESSING row older than `staleMs` whose `transcode-<id>` job is not
 * queued or running is re-queued under that same deterministic jobId (so a
 * job that does still exist is never doubled), at most MAX_REQUEUES times;
 * past that it is REJECTED, so a file that kills the worker every time
 * cannot loop forever. Each claim is a guarded update on the row's own
 * snapshot, so two reconcilers cannot both re-queue one row.
 */
export const TRANSCODE_STALE_MS = 20 * 60_000;
export const MAX_TRANSCODE_REQUEUES = 3;

type QueueLike = {
  getJob(id: string): Promise<{ getState(): Promise<string> } | null | undefined>;
  add(name: string, data: unknown, opts: object): Promise<unknown>;
};

export const transcodeJobId = (mediaId: string) => `transcode-${mediaId}`;

/** The options every transcode job is added with (see modules/media.ts for why the removeOn* are true). */
export const transcodeJobOptions = (mediaId: string) => ({
  jobId: transcodeJobId(mediaId), attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: true, removeOnFail: true,
});

export async function reconcileProcessingMedia(queue: QueueLike, now = Date.now(), staleMs = TRANSCODE_STALE_MS) {
  const cutoff = new Date(now - staleMs);
  const stuck = await prisma.media.findMany({
    where: { status: 'PROCESSING', OR: [{ processingSince: { lt: cutoff } }, { processingSince: null, createdAt: { lt: cutoff } }] },
    select: { id: true, processingSince: true, transcodeRequeues: true },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  let requeued = 0, rejected = 0;
  for (const m of stuck) {
    if (await jobInFlight(await queue.getJob(transcodeJobId(m.id)))) continue;
    const snapshot = { id: m.id, status: 'PROCESSING' as const, processingSince: m.processingSince, transcodeRequeues: m.transcodeRequeues };
    if (m.transcodeRequeues >= MAX_TRANSCODE_REQUEUES) {
      const r = await prisma.media.updateMany({ where: snapshot, data: { status: 'REJECTED' } });
      rejected += r.count;
      continue;
    }
    const claimed = await prisma.media.updateMany({ where: snapshot, data: { transcodeRequeues: { increment: 1 }, processingSince: new Date(now) } });
    if (!claimed.count) continue;
    try {
      await queue.add('transcode', { mediaId: m.id }, transcodeJobOptions(m.id));
      requeued++;
    } catch (e) {
      // Left PROCESSING with a fresh processingSince: the next pass retries.
      console.error('transcode reconcile: enqueue', m.id, e);
    }
  }
  return { requeued, rejected };
}
