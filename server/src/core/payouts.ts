import type { PayoutStatus } from '@prisma/client';
import { post, PLATFORM_ID, type Tx } from './ledger.js';

/**
 * Reverses a payout: the gross (net + fee) goes back to the creator as
 * WITHDRAWABLE earnings (it was reserved out of them), the fee comes back
 * out of platform revenue, and the fee's still-unexecuted burn obligation is
 * cancelled -- postPlatformRevenue wrote one with refId = payout id in the
 * same transaction that charged the fee, and leaving it would overstate what
 * the platform owes the supply. An obligation the burn worker already
 * executed is left alone.
 *
 * Guarded on the payout's CURRENT status (a conditional update, not a
 * read-then-write), so two paths racing to settle one payout -- the worker,
 * the reconciler, an admin -- can never refund it twice or refund one that
 * was just marked SENT. Returns false, changing nothing, when the payout is
 * no longer in one of `from`.
 *
 * Only call this when no money can have moved on-chain.
 */
export async function refundPayout(
  tx: Tx,
  payoutId: string,
  from: PayoutStatus[],
  reason: string,
  extra: { txHash?: string | null } = {},
): Promise<boolean> {
  const claimed = await tx.payout.updateMany({
    where: { id: payoutId, status: { in: from } },
    data: { status: 'REFUNDED', error: reason.slice(0, 500), ...(extra.txHash !== undefined ? { txHash: extra.txHash } : {}) },
  });
  if (!claimed.count) return false;
  const p = await tx.payout.findUniqueOrThrow({ where: { id: payoutId } });
  const gross = p.amountCents + p.feeCents;
  await post(tx, p.creatorId, gross, 'PAYOUT_REVERSAL', p.id, { reason: reason.slice(0, 200) }, 'CREDITS', { earned: true });
  if (p.feeCents > 0n) await post(tx, PLATFORM_ID, -p.feeCents, 'PAYOUT_REVERSAL', p.id);
  await tx.tokenBurn.deleteMany({ where: { refId: p.id, executedAt: null } });
  return true;
}

/** Marks a payout SENT against a transaction hash, guarded on its current status. */
export async function markPayoutSent(tx: Tx, payoutId: string, from: PayoutStatus[], txHash: string, note?: string): Promise<boolean> {
  const r = await tx.payout.updateMany({
    where: { id: payoutId, status: { in: from } },
    data: { status: 'SENT', txHash, error: note ? note.slice(0, 500) : null },
  });
  return r.count > 0;
}
