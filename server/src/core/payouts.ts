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

/**
 * Claims a payout for settlement BY HAND (POST /admin/payouts/:id/resolve
 * {action:'hold'}), BEFORE the admin sends anything from the treasury.
 *
 * PENDING -> HELD: the worker's claim (PENDING -> PROCESSING) then no-ops,
 * so it can never broadcast its own transfer alongside the admin's.
 * FAILED -> HELD: the reconciler only ever looks at PROCESSING / FAILED, so
 * it can no longer "prove" the payout never sent -- a hand-sent treasury
 * transfer takes the same nonce the failed one held -- and refund it on top
 * of the manual payment.
 *
 * Guarded update; false (nothing changed) when the payout is no longer in
 * one of those states.
 */
export async function holdForManualSettlement(tx: Tx, payoutId: string, by: string): Promise<boolean> {
  const r = await tx.payout.updateMany({
    where: { id: payoutId, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'HELD', error: `held for manual settlement by admin ${by}`.slice(0, 500) },
  });
  return r.count > 0;
}

/**
 * Is `tx` the worker's own nonce-cancel for a payout at `nonce`: a
 * zero-value transfer from the treasury to itself at exactly that nonce?
 * Only then does "the nonce is consumed and the original is unknown" prove
 * that no money moved (workers/payout-worker.ts provablyNeverSent).
 */
export function isOwnNonceCancel(
  tx: { from: string; to: string | null; value: bigint; nonce: number } | null,
  treasury: string,
  nonce: number,
): boolean {
  if (!tx) return false;
  const me = treasury.toLowerCase();
  return tx.from.toLowerCase() === me && (tx.to ?? '').toLowerCase() === me && tx.value === 0n && tx.nonce === nonce;
}

/**
 * The addresses (lowercased) a USDG transfer settling a payout by admin
 * mark_sent may come FROM: always the current treasury, and -- only when
 * the hash is the payout's OWN signed transaction -- the key recorded as
 * having signed it. After a treasury key rotation the payout's own transfer
 * came from the old wallet, which is no longer TREASURY_ADDRESS; without
 * this such a payout, once its transfer landed, could never be closed. A
 * hash the payout did not record is never matched against signerAddress.
 */
export function payoutTransferSenders(
  p: { ownTx: boolean; signerAddress: string | null },
  treasury: string | null | undefined,
): string[] {
  const out = new Set<string>();
  if (treasury) out.add(treasury.toLowerCase());
  if (p.ownTx && p.signerAddress && /^0x[0-9a-fA-F]{40}$/.test(p.signerAddress)) out.add(p.signerAddress.toLowerCase());
  return [...out];
}
