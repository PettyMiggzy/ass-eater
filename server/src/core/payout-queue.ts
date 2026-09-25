/**
 * One deterministic BullMQ job id per payout. BullMQ ignores an add() for an
 * id that is still waiting or active, so the reconciler can re-queue a
 * PENDING payout whose original enqueue failed without ever stacking a
 * second job for it. Completed/failed jobs are NOT retained (removeOn*:
 * true): a retained job would keep the id burned and silently swallow a
 * later re-queue, e.g. after an admin releases a HELD payout. The durable
 * record of how a payout ended is the Payout row, not the queue.
 */
export const payoutJobId = (payoutId: string) => `payout-${payoutId}`;

export const payoutJobOptions = (payoutId: string, instant: boolean) => ({
  jobId: payoutJobId(payoutId),
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
  priority: instant ? 1 : 10,
});

/**
 * BullMQ job states in which the job may still run (or is running). Every
 * payout job is added with a `priority`, and BullMQ 5 keeps a prioritized
 * job in its own 'prioritized' set -- Job.isWaiting() only checks the
 * 'wait'/'paused' lists, so the old isActive()||isWaiting()||isDelayed()
 * check reported a queued payout as NOT queued, and the admin "payout in
 * flight" guard could never fire. Ask for the state instead.
 */
export const JOB_IN_FLIGHT_STATES = new Set(['active', 'waiting', 'prioritized', 'delayed', 'waiting-children', 'paused']);

/** Is this job queued or running? A missing job is not; an unreadable state is treated as in flight (doubt blocks). */
export async function jobInFlight(job: { getState(): Promise<string> } | null | undefined): Promise<boolean> {
  if (!job) return false;
  try {
    return JOB_IN_FLIGHT_STATES.has(await job.getState());
  } catch {
    return true;
  }
}
