import { Worker } from 'bullmq';
import { encodeFunctionData, keccak256, parseUnits, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import { prisma } from '../lib/prisma.js';
import { publicClient, treasuryAccount, treasuryWallet, withTreasuryLock, HEDGE_STABLE, erc20Abi, envInt } from '../lib/chain.js';
import { getUsdPrice } from '../lib/price.js';
import { money } from '../core/ledger.js';
import { refundPayout, markPayoutSent } from '../core/payouts.js';
import { payoutJobId, payoutJobOptions } from '../core/payout-queue.js';
import { publish, connection, payoutQueue } from '../lib/redis.js';
import { registerWorker, onStop, isStopping } from './process-guards.js';

// How long to wait before concluding that a transaction whose broadcast
// errored never reached the chain. Long enough for a slow sequencer to have
// surfaced it; the nonce check below is what actually decides.
const BROADCAST_SETTLE_MS = envInt('PAYOUT_BROADCAST_SETTLE_MS', 20_000, 1000);

/** Does any node we can reach know this transaction (pending or mined)? */
async function nodeKnows(hash: `0x${string}`): Promise<boolean> {
  try {
    await publicClient.getTransaction({ hash });
    return true;
  } catch (e) {
    if (e instanceof TransactionNotFoundError) return false;
    throw e;   // an RPC error is doubt, not an answer
  }
}

/**
 * Is it PROVABLE that the signed transaction `hash` (nonce `nonce`) was never
 * accepted and never can be?
 *
 * Only then is an automatic refund safe. A broadcast call throwing proves
 * nothing: viem retries eth_sendRawTransaction on timeouts and 5xx, so the
 * first attempt can be accepted while its response is lost, and the retry
 * then fails with "already known" / "nonce too low". Refunding on that error
 * paid the creator twice -- once on-chain, once back into their balance.
 *
 * "Not found right now" is not enough either: the signed transaction stays
 * valid for its nonce, and a node that did receive it could still include it
 * later. So the nonce is CONSUMED first -- a zero-value self-transfer at the
 * same nonce with bumped fees, under the treasury lock -- and the refund is
 * only safe once the CONFIRMED nonce has moved past ours while the original
 * hash is still unknown. Exactly one transaction can hold a nonce, so the
 * original can then never land. Any doubt (an RPC error included) answers
 * false, and the payout is held FAILED with its hash for an admin.
 */
async function provablyNeverSent(hash: `0x${string}`, nonce: number): Promise<boolean> {
  try {
    await new Promise(r => setTimeout(r, BROADCAST_SETTLE_MS));
    if (await nodeKnows(hash)) return false;   // it went out
    const me = treasuryAccount().address;
    const consumed = async () => (await publicClient.getTransactionCount({ address: me, blockTag: 'latest' })) > nonce;
    if (!(await consumed())) {
      const cancel = await withTreasuryLock(async () => {
        if (await consumed()) return null;
        const wallet = treasuryWallet();
        const fees = await publicClient.estimateFeesPerGas();
        try {
          return await wallet.sendTransaction({
            to: me, value: 0n, nonce,
            // A replacement must outbid whatever may sit in a mempool at this nonce.
            maxFeePerGas: (fees.maxFeePerGas ?? 0n) * 2n + 1n,
            maxPriorityFeePerGas: (fees.maxPriorityFeePerGas ?? 0n) * 2n + 1n,
          } as any);
        } catch {
          return null;   // e.g. "nonce too low": something took it -- decided below
        }
      });
      if (cancel) await publicClient.waitForTransactionReceipt({ hash: cancel, timeout: 180_000 }).catch(() => {});
    }
    return (await consumed()) && !(await nodeKnows(hash));
  } catch {
    return false;
  }
}

/**
 * Claims PENDING -> PROCESSING with a guarded update (only one run can own a
 * payout) and then checks the creator may still be paid. A creator frozen,
 * suspended or banned after requesting -- a moderation action while the
 * queue was busy with another payout's receipt wait -- is NOT paid: the
 * payout is HELD, money still reserved, for an admin to release or refund.
 * Refunding automatically would hand a banned creator their balance back.
 */
async function claimPayout(payoutId: string) {
  const claimed = await prisma.payout.updateMany({ where: { id: payoutId, status: 'PENDING' }, data: { status: 'PROCESSING' } });
  if (!claimed.count) return null;
  const p = await prisma.payout.findUniqueOrThrow({
    where: { id: payoutId },
    include: { creator: { select: { payoutsFrozen: true, user: { select: { status: true } } } } },
  });
  if (p.creator.payoutsFrozen || p.creator.user.status !== 'ACTIVE' || p.asset !== 'STABLE') {
    const why = p.asset !== 'STABLE' ? 'held: payouts are USDG only' : 'held: creator frozen or not active';
    await prisma.payout.updateMany({ where: { id: p.id, status: 'PROCESSING', txHash: null }, data: { status: 'HELD', error: why } });
    await publish(p.creatorId, { type: 'payout', status: 'HELD' });
    return null;
  }
  return p;
}

registerWorker(new Worker('payout', async (job) => {
  const p = await claimPayout(job.data.payoutId);
  if (!p) return;

  // Set once the transaction is SIGNED, before it is broadcast -- the hash of
  // a signed transaction is known locally, so it is persisted first (with its
  // nonce) and a crash at any later point leaves a hash the reconciler below
  // can settle.
  let hash: `0x${string}` | undefined;
  let nonce: number | undefined;
  let reverted = false;
  try {
    const px = await getUsdPrice(p.asset);
    // Payouts go out in the chain's primary dollar (USDG) and nothing else:
    // the ledger owes the creator cents, and which stablecoin a fan happened
    // to deposit has nothing to do with what they are paid.
    const token = HEDGE_STABLE;
    const decimals = token.decimals;
    const units = Number(p.amountCents) / 100 / px;
    const raw = parseUnits(units.toFixed(decimals), decimals);
    const to = p.address as `0x${string}`;

    // Sign, persist the hash, then broadcast -- all under the treasury lock so
    // no other sender (sweep gas top-ups, hedge, burn) takes the same nonce.
    await withTreasuryLock(async () => {
      const wallet = treasuryWallet();
      const request = await wallet.prepareTransactionRequest({ to: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, raw] }) });
      const serialized = await wallet.signTransaction(request as any);
      hash = keccak256(serialized);
      nonce = request.nonce;
      await prisma.payout.update({ where: { id: p.id }, data: { txHash: hash, nonce, assetAmount: raw.toString(), priceUsed: px } });
      await wallet.sendRawTransaction({ serializedTransaction: serialized });
    });

    const rcpt = await publicClient.waitForTransactionReceipt({ hash: hash!, confirmations: 2 });
    if (rcpt.status !== 'success') { reverted = true; throw new Error('tx_reverted'); }

    await prisma.payout.updateMany({ where: { id: p.id, status: 'PROCESSING' }, data: { status: 'SENT', txHash: hash, assetAmount: raw.toString(), priceUsed: px } });
    await publish(p.creatorId, { type: 'payout', status: 'SENT', txHash: hash, asset: p.asset, amount: units });
  } catch (e: any) {
    // Refund automatically only when no money can have moved: nothing was
    // ever signed, the receipt shows a revert (a reverted transfer moves no
    // tokens), or the signed tx provably never reached the chain. Everything
    // else -- a lost broadcast response, a receipt wait that timed out -- is
    // held FAILED with its hash for the reconciler or an admin. Never
    // double-pay.
    const refund = !hash || reverted || (nonce !== undefined && await provablyNeverSent(hash, nonce));
    let refunded = false;
    if (refund) {
      refunded = await money(prisma, (tx) => refundPayout(tx, p.id, ['PROCESSING'], String(e.message), { txHash: hash ?? null }));
    } else {
      await prisma.payout.updateMany({ where: { id: p.id, status: 'PROCESSING' }, data: { status: 'FAILED', txHash: hash ?? null, error: String(e.message).slice(0, 500) } });
    }
    await publish(p.creatorId, { type: 'payout', status: refunded ? 'REFUNDED' : 'FAILED', refunded });
  }
}, { ...connection, concurrency: 1 }));

/**
 * Settles payouts nothing else will ever touch again.
 *
 *  - PENDING for longer than PENDING_STALE_MS: its enqueue failed after the
 *    money transaction committed (Redis down), or its job was lost. Re-queued
 *    under the same deterministic jobId, so a payout still sitting in the
 *    queue is not added twice, and the worker's guarded claim means it can
 *    never run twice either.
 *  - PROCESSING / FAILED whose job is not running: interrupted mid-flight (a
 *    redeploy restarted this process during a receipt wait) or held for
 *    doubt. With no txHash nothing was ever broadcast (the hash is persisted
 *    before broadcasting), so it is refunded. With a hash, the chain decides:
 *    a successful receipt marks it SENT, a revert refunds, and a tx no node
 *    knows is refunded only once provablyNeverSent() shows its nonce was
 *    consumed by something else. Anything still in doubt stays FAILED for an
 *    admin (POST /admin/payouts/:id/resolve). FAILED rows older than
 *    FAILED_AUTO_WINDOW_MS (7 days) are no longer touched automatically.
 */
const PENDING_STALE_MS = envInt('PAYOUT_PENDING_STALE_MS', 5 * 60_000, 60_000);
// FAILED payouts older than this are left for an admin. An RPC node that
// prunes its tx-lookup index (Nitro/geth drop old lookups) would report an
// old, genuinely landed transfer as unknown, and provablyNeverSent() would
// then refund money that was in fact paid. Bounding the window also stops
// the loop re-examining (and re-sleeping on) the same rows forever.
const FAILED_AUTO_WINDOW_MS = envInt('PAYOUT_FAILED_AUTO_WINDOW_MS', 7 * 24 * 60 * 60_000, 60 * 60_000);
const RECONCILE_EVERY_MS = envInt('PAYOUT_RECONCILE_INTERVAL_MS', 5 * 60_000, 30_000);

export async function reconcilePayouts() {
  const cutoff = new Date(Date.now() - PENDING_STALE_MS);
  const pending = await prisma.payout.findMany({ where: { status: 'PENDING', createdAt: { lt: cutoff } }, select: { id: true, instant: true }, take: 200 });
  for (const p of pending) {
    await payoutQueue.add('send', { payoutId: p.id }, payoutJobOptions(p.id, p.instant)).catch((e) => console.error('payout reconcile: enqueue', p.id, e));
  }

  const failedSince = new Date(Date.now() - FAILED_AUTO_WINDOW_MS);
  const stuck = await prisma.payout.findMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [{ status: 'PROCESSING' }, { status: 'FAILED', createdAt: { gte: failedSince } }],
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  for (const p of stuck) {
    if (isStopping()) return;
    const job = await payoutQueue.getJob(payoutJobId(p.id));
    if (job && (await job.isActive() || await job.isWaiting() || await job.isDelayed())) continue;
    try {
      if (!p.txHash) {
        if (p.status === 'PROCESSING') {
          await money(prisma, (tx) => refundPayout(tx, p.id, ['PROCESSING'], 'interrupted before signing'));
        }
        continue;
      }
      const hash = p.txHash as `0x${string}`;
      const rcpt = await publicClient.getTransactionReceipt({ hash }).catch((e) => {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      });
      if (rcpt) {
        if (rcpt.status === 'success') {
          await money(prisma, (tx) => markPayoutSent(tx, p.id, ['PROCESSING', 'FAILED'], hash));
          await publish(p.creatorId, { type: 'payout', status: 'SENT', txHash: hash });
        } else {
          await money(prisma, (tx) => refundPayout(tx, p.id, ['PROCESSING', 'FAILED'], 'tx_reverted'));
        }
        continue;
      }
      if (p.nonce != null && p.createdAt >= failedSince && await provablyNeverSent(hash, p.nonce)) {
        await money(prisma, (tx) => refundPayout(tx, p.id, ['PROCESSING', 'FAILED'], 'never broadcast'));
        continue;
      }
      if (p.status === 'PROCESSING') {
        await prisma.payout.updateMany({ where: { id: p.id, status: 'PROCESSING' }, data: { status: 'FAILED', error: 'interrupted; tx not found -- admin must check on-chain' } });
      }
    } catch (e) {
      console.error('payout reconcile', p.id, e);
    }
  }
}

let reconciling = false;
const tick = async () => {
  if (reconciling || isStopping()) return;
  reconciling = true;
  try { await reconcilePayouts(); } catch (e) { console.error('payout reconcile', e); } finally { reconciling = false; }
};
const timer = setInterval(tick, RECONCILE_EVERY_MS);
onStop(() => clearInterval(timer));
setTimeout(tick, 30_000);
