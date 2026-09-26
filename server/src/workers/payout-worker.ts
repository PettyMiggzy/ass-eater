import { Worker } from 'bullmq';
import { encodeFunctionData, keccak256, parseUnits, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import { prisma } from '../lib/prisma.js';
import { publicClient, treasuryAccount, treasuryWallet, withTreasuryLock, HEDGE_STABLE, erc20Abi, envInt, assertStableDecimals, TokenDecimalsMismatchError } from '../lib/chain.js';
import { getUsdPrice } from '../lib/price.js';
import { money } from '../core/ledger.js';
import { refundPayout, markPayoutSent, isOwnNonceCancel } from '../core/payouts.js';
import { CREATOR_STANDING_SELECT, creatorMayBePaid } from '../core/creator-standing.js';
import { payoutJobId, payoutJobOptions, jobInFlight } from '../core/payout-queue.js';
import { publish, connection, payoutQueue } from '../lib/redis.js';
import { registerWorker, onStop, isStopping } from './process-guards.js';
import { treasuryOutflow, type OutflowJournal } from '../lib/outflow-journal.js';

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
 * original can then never land.
 *
 * And the nonce must have been consumed by THAT cancel, not by anything
 * else. "Consumed and unknown" proves the original can never land, not that
 * no money moved: an admin settling a failed payout by hand from the
 * treasury takes the very nonce the failed transaction held, and refunding
 * then paid the creator twice (USDG on-chain plus the credits back). The
 * cancel's hash is persisted on the payout before it is broadcast, so a later
 * reconciler run can still check it; a nonce consumed by any other
 * transaction answers false. Any doubt (an RPC error included) answers
 * false, and the payout is held FAILED with its hash for an admin.
 */
/** Is this payout still one the worker/reconciler may act on (not HELD/settled by an admin)? */
async function stillReconcilable(payoutId: string) {
  const row = await prisma.payout.findUnique({ where: { id: payoutId }, select: { status: true } });
  return !!row && (row.status === 'PROCESSING' || row.status === 'FAILED');
}

async function provablyNeverSent(p: { id: string; txHash: string; nonce: number; cancelTxHash: string | null }): Promise<boolean> {
  const hash = p.txHash as `0x${string}`;
  const nonce = p.nonce;
  try {
    await new Promise(r => setTimeout(r, BROADCAST_SETTLE_MS));
    // The settle sleep is exactly the window the runbook gives an admin to
    // hold a FAILED payout and send it by hand from the treasury -- at this
    // very nonce. Once the row has left PROCESSING/FAILED it is the admin's,
    // and no cancel may be broadcast over their transfer.
    if (!(await stillReconcilable(p.id))) return false;
    if (await nodeKnows(hash)) return false;   // it went out
    const me = treasuryAccount().address;
    const consumed = async () => (await publicClient.getTransactionCount({ address: me, blockTag: 'latest' })) > nonce;
    let cancelHash = p.cancelTxHash as `0x${string}` | null;
    if (!(await consumed())) {
      const sent = await withTreasuryLock(async () => {
        if (await consumed()) return null;
        const wallet = treasuryWallet();
        const fees = await publicClient.estimateFeesPerGas();
        try {
          const request = await wallet.prepareTransactionRequest({
            to: me, value: 0n, nonce,
            // A replacement must outbid whatever may sit in a mempool at this nonce.
            maxFeePerGas: (fees.maxFeePerGas ?? 0n) * 2n + 1n,
            maxPriorityFeePerGas: (fees.maxPriorityFeePerGas ?? 0n) * 2n + 1n,
          } as any);
          const serialized = await wallet.signTransaction(request as any);
          const h = keccak256(serialized);
          // Persisted before broadcast, like the payout's own hash -- and the
          // guarded update is also the last ownership check: if it matched no
          // row (an admin HELD it meanwhile), nothing is broadcast. A cancel
          // at this nonce with doubled fees would otherwise replace the
          // admin's own manual transfer sitting in the mempool.
          const owned = await prisma.payout.updateMany({ where: { id: p.id, status: { in: ['PROCESSING', 'FAILED'] } }, data: { cancelTxHash: h } });
          if (owned.count === 0) return null;
          await wallet.sendRawTransaction({ serializedTransaction: serialized });
          return h;
        } catch {
          return null;   // e.g. "nonce too low": something took it -- decided below
        }
      });
      if (sent) {
        cancelHash = sent;
        await publicClient.waitForTransactionReceipt({ hash: sent, timeout: 180_000 }).catch(() => {});
      }
    }
    if (!(await consumed()) || (await nodeKnows(hash))) return false;
    if (!cancelHash) return false;
    const rcpt = await publicClient.getTransactionReceipt({ hash: cancelHash }).catch(() => null);
    if (rcpt?.status !== 'success') return false;
    const cancelTx = await publicClient.getTransaction({ hash: cancelHash }).catch(() => null);
    return isOwnNonceCancel(cancelTx as any, me, nonce);
  } catch {
    return false;
  }
}

/**
 * Treasury outflow limits, read from THIS process's environment -- never from
 * the database. Every other check before signing (the payout row, the
 * creator's standing, the ledger) lives in Postgres, and Postgres is
 * writable by every process that loads .env -- including the media workers,
 * which run ffmpeg/libvips over untrusted uploads. A parser exploit there
 * could INSERT a PENDING payout to its own address for any approved creator
 * and this worker, the only process holding the key, would sign it (a ledger
 * cross-check would not help: the same access can forge the ledger). So
 * what DB access alone can move is bounded here:
 *  - PAYOUT_MAX_CENTS (default $5,000): a larger payout is HELD, to be
 *    settled by hand (hold + mark_sent, POST /admin/payouts/:id/resolve);
 *  - PAYOUT_DAILY_MAX_CENTS (default $20,000): rolling 24h outflow. A payout
 *    that would cross it is HELD; release it once the window has room.
 * The 24h total is the larger of what this key has signed according to the
 * outflow journal (lib/outflow-journal.ts: a file in the workers unit's own
 * 0700 state directory, appended and fsync'd before every broadcast, which a
 * database writer cannot touch and which survives restarts) and what the
 * Payout table records as signed. An attacker can only make the DB figure
 * smaller; the journal figure still counts, across any number of restarts.
 * It used to be an in-memory list, so every redeploy -- or a crash loop an
 * attacker could force from the database -- reopened the whole daily window.
 * If the journal cannot be read, nothing is signed automatically.
 */
const MAX_PAYOUT_CENTS = envInt('PAYOUT_MAX_CENTS', 500_000, 100);
const DAILY_MAX_CENTS = envInt('PAYOUT_DAILY_MAX_CENTS', 2_000_000, 100);
const DAY_MS = 24 * 60 * 60_000;

/** Why this payout may not be signed automatically, or null. Exported for tests. */
export async function outflowLimitReason(payoutId: string, amountCents: number, journal: OutflowJournal = treasuryOutflow): Promise<string | null> {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 'held: invalid amount';
  if (amountCents > MAX_PAYOUT_CENTS) return `held: over the per-payout limit (PAYOUT_MAX_CENTS) -- settle by hand`;
  let here: number;
  try {
    here = journal.sumSince('payout', DAY_MS);
  } catch (e) {
    console.error('payout: outflow journal unavailable -- holding payouts', (e as Error).message);
    return 'held: treasury outflow journal unavailable -- fix the workers state directory, then release';
  }
  const now = Date.now();
  const since = now - DAY_MS;
  // Bounded above as well: a row signed while the clock ran ahead would
  // otherwise count for as long as the jump. The journal is the binding
  // figure for such a row (outflow-journal.ts clamps future entries to now,
  // so they still count for one full window); the database figure is only
  // the second opinion here, and is writable by any DB writer anyway.
  const agg = await prisma.payout.aggregate({
    _sum: { amountCents: true },
    where: { id: { not: payoutId }, signedAt: { gte: new Date(since), lte: new Date(now) }, status: { in: ['PROCESSING', 'SENT', 'FAILED', 'HELD'] } },
  });
  const recorded = Number(agg._sum.amountCents ?? 0n);
  if (Math.max(here, recorded) + amountCents > DAILY_MAX_CENTS) return 'held: daily payout limit reached (PAYOUT_DAILY_MAX_CENTS) -- release it later';
  return null;
}

/**
 * Claims PENDING -> PROCESSING with a guarded update (only one run can own a
 * payout) and then checks the creator may still be paid. A creator frozen,
 * suspended, banned or no longer approved (KYC / site standing) after requesting -- a moderation action while the
 * queue was busy with another payout's receipt wait -- is NOT paid: the
 * payout is HELD, money still reserved, for an admin to release or refund.
 * Refunding automatically would hand a banned creator their balance back.
 * So is one over the treasury outflow limits (outflowLimitReason above).
 */
async function claimPayout(payoutId: string) {
  const claimed = await prisma.payout.updateMany({ where: { id: payoutId, status: 'PENDING' }, data: { status: 'PROCESSING' } });
  if (!claimed.count) return null;
  const p = await prisma.payout.findUniqueOrThrow({
    where: { id: payoutId },
    include: { creator: { select: { payoutsFrozen: true, user: { select: CREATOR_STANDING_SELECT } } } },
  });
  // creatorMayBePaid, not just status: withdrawing is something only an
  // APPROVED creator may do (core/creator-standing.ts), and approval can be
  // withdrawn without a suspension -- KYC set to REJECTED, or the site moving
  // the creator back to 'pending' -- while the payout sat in the queue.
  const approved = creatorMayBePaid(p.creator.user);
  const overLimit = approved && !p.creator.payoutsFrozen && p.asset === 'STABLE' ? await outflowLimitReason(p.id, Number(p.amountCents)) : null;
  if (p.creator.payoutsFrozen || !approved || p.asset !== 'STABLE' || overLimit) {
    const why = p.asset !== 'STABLE' ? 'held: payouts are USDG only'
      : p.creator.payoutsFrozen || p.creator.user.status !== 'ACTIVE' ? 'held: creator frozen or not active'
        : !approved ? 'held: creator not approved'
          : overLimit!;
    await prisma.payout.updateMany({ where: { id: p.id, status: 'PROCESSING', txHash: null }, data: { status: 'HELD', error: why } });
    await publish(p.creatorId, { type: 'payout', status: 'HELD' });
    return null;
  }
  return p;
}

async function processPayoutJob(job: { data: { payoutId: string } }) {
  // Never sign on an unverified scale. The payout amount is converted with
  // HEDGE_STABLE.decimals from configuration; a typo there (6 -> 2) sends a
  // ten-thousandth of what is owed, the transfer succeeds, and the row is
  // marked SENT. Checked against the contract BEFORE the payout is claimed,
  // so on a mismatch (or an RPC failure) it simply stays PENDING -- the job
  // fails, and the reconciler re-queues it once the config is fixed.
  try {
    await assertStableDecimals();
  } catch (e) {
    if (e instanceof TokenDecimalsMismatchError) console.error('payout: REFUSING to pay -- stablecoin decimals do not match the chain. Payouts stay PENDING until the configuration is fixed and the workers restarted.', e.message);
    throw e;
  }
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
      // Counted in the outflow journal once SIGNED and BEFORE the hash is
      // kept or anything is broadcast -- the order sendTreasuryTx and the
      // gas top-ups use. A prepare or sign failure (no ETH for gas, an RPC
      // error estimating it) is refunded below and never counted: recording
      // first let every such failed attempt eat PAYOUT_DAILY_MAX_CENTS and
      // hold every later payout for a day. If the write fails, hash is still
      // unset and nothing was broadcast, so the payout is refunded; a crash
      // after it over-counts, never under-counts.
      treasuryOutflow.record('payout', Number(p.amountCents), p.id);
      hash = keccak256(serialized);
      nonce = request.nonce;
      await prisma.payout.update({ where: { id: p.id }, data: { txHash: hash, nonce, signedAt: new Date(), assetAmount: raw.toString(), priceUsed: px } });
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
    const refund = !hash || reverted || (nonce !== undefined && await provablyNeverSent({ id: p.id, txHash: hash, nonce, cancelTxHash: null }));
    let refunded = false;
    if (refund) {
      refunded = await money(prisma, (tx) => refundPayout(tx, p.id, ['PROCESSING'], String(e.message), { txHash: hash ?? null }));
    } else {
      await prisma.payout.updateMany({ where: { id: p.id, status: 'PROCESSING' }, data: { status: 'FAILED', txHash: hash ?? null, error: String(e.message).slice(0, 500) } });
    }
    await publish(p.creatorId, { type: 'payout', status: refunded ? 'REFUNDED' : 'FAILED', refunded });
  }
}
// Not started under the test runner, which imports this module for
// outflowLimitReason only (the same guard as token-burn.ts).
if (process.env.NODE_ENV !== 'test') registerWorker(new Worker('payout', processPayoutJob, { ...connection, concurrency: 1 }));

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
 *    consumed by the worker's own cancel. Anything still in doubt stays
 *    FAILED for an admin (POST /admin/payouts/:id/resolve).
 *
 * The age limits are measured from when the transaction was SIGNED
 * (signedAt), never from the request (createdAt): a payout HELD for days and
 * then released used to be ignored the moment it failed. A receipt showing
 * success or revert settles a FAILED payout at any age up to
 * FAILED_RECEIPT_WINDOW_MS; only the refund-because-it-never-sent branch is
 * limited to FAILED_AUTO_WINDOW_MS (7 days).
 */
const PENDING_STALE_MS = envInt('PAYOUT_PENDING_STALE_MS', 5 * 60_000, 60_000);
// FAILED payouts older than this are left for an admin. An RPC node that
// prunes its tx-lookup index (Nitro/geth drop old lookups) would report an
// old, genuinely landed transfer as unknown, and provablyNeverSent() would
// then refund money that was in fact paid. Bounding the window also stops
// the loop re-examining (and re-sleeping on) the same rows forever.
const FAILED_AUTO_WINDOW_MS = envInt('PAYOUT_FAILED_AUTO_WINDOW_MS', 7 * 24 * 60 * 60_000, 60 * 60_000);
// How long a FAILED payout with a hash keeps being re-checked for a receipt.
// A receipt is an answer at any age (unlike "not found"); the bound only
// stops the loop rescanning the same rows forever.
const FAILED_RECEIPT_WINDOW_MS = envInt('PAYOUT_FAILED_RECEIPT_WINDOW_MS', 30 * 24 * 60 * 60_000, 60 * 60_000);
const RECONCILE_EVERY_MS = envInt('PAYOUT_RECONCILE_INTERVAL_MS', 5 * 60_000, 30_000);

// Rotating page cursor over old FAILED payouts (see reconcilePayouts).
let oldFailedCursor = '';

export async function reconcilePayouts() {
  const cutoff = new Date(Date.now() - PENDING_STALE_MS);
  const pending = await prisma.payout.findMany({ where: { status: 'PENDING', createdAt: { lt: cutoff } }, select: { id: true, instant: true }, take: 200 });
  for (const p of pending) {
    await payoutQueue.add('send', { payoutId: p.id }, payoutJobOptions(p.id, p.instant)).catch((e) => console.error('payout reconcile: enqueue', p.id, e));
  }

  const failedSince = new Date(Date.now() - FAILED_AUTO_WINDOW_MS);
  const receiptSince = new Date(Date.now() - FAILED_RECEIPT_WINDOW_MS);
  // Three separate, bounded queries. One `take: 50` over all of them, oldest
  // first, let 50 old FAILED rows that only an admin can settle (past the
  // 7-day auto window, no receipt) crowd out every newer PROCESSING or
  // FAILED row for up to 30 days -- those were never reconciled at all.
  const signedOrCreatedSince = (d: Date) => ({ OR: [{ signedAt: { gte: d } }, { signedAt: null, createdAt: { gte: d } }] });
  const signedOrCreatedBefore = (d: Date) => ({ OR: [{ signedAt: { lt: d } }, { signedAt: null, createdAt: { lt: d } }] });
  const [processing, failedRecent, failedOld] = await Promise.all([
    prisma.payout.findMany({ where: { status: 'PROCESSING', createdAt: { lt: cutoff } }, orderBy: { createdAt: 'asc' }, take: 50 }),
    // Only FAILED rows with a hash have anything left to settle: with no
    // hash nothing was signed and the worker already refunded it.
    prisma.payout.findMany({ where: { status: 'FAILED', txHash: { not: null }, ...signedOrCreatedSince(failedSince) }, orderBy: { createdAt: 'asc' }, take: 50 }),
    // Past the auto window only a receipt can still settle them; walk these
    // a page per cycle with a rotating cursor so every one is re-checked.
    prisma.payout.findMany({
      where: { status: 'FAILED', txHash: { not: null }, id: { gt: oldFailedCursor }, AND: [signedOrCreatedSince(receiptSince), signedOrCreatedBefore(failedSince)] },
      orderBy: { id: 'asc' }, take: 25,
    }),
  ]);
  oldFailedCursor = failedOld.length < 25 ? '' : failedOld[failedOld.length - 1].id;
  const stuck = [...processing, ...failedRecent, ...failedOld];
  for (const p of stuck) {
    if (isStopping()) return;
    if (await jobInFlight(await payoutQueue.getJob(payoutJobId(p.id)))) continue;
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
      if (p.nonce != null && (p.signedAt ?? p.createdAt) >= failedSince && await provablyNeverSent({ id: p.id, txHash: p.txHash, nonce: p.nonce, cancelTxHash: p.cancelTxHash })) {
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
if (process.env.NODE_ENV !== 'test') {
  const timer = setInterval(tick, RECONCILE_EVERY_MS);
  onStop(() => clearInterval(timer));
  setTimeout(tick, 30_000);
}
