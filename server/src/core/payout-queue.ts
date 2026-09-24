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
