import { Worker } from 'bullmq';
import { encodeFunctionData, keccak256, parseUnits, TransactionNotFoundError } from 'viem';
import { prisma } from '../lib/prisma.js';
import { publicClient, treasuryAccount, treasuryWallet, withTreasuryLock, TOKENS, DECIMALS, HEDGE_STABLE, erc20Abi, envInt } from '../lib/chain.js';
import { getUsdPrice } from '../lib/price.js';
import { money, post, PLATFORM_ID } from '../core/ledger.js';
import { publish, connection } from '../lib/redis.js';

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

new Worker('payout', async (job) => {
  const p = await prisma.payout.findUniqueOrThrow({ where: { id: job.data.payoutId } });
  if (p.status !== 'PENDING') return;
  await prisma.payout.update({ where: { id: p.id }, data: { status: 'PROCESSING' } });

  // Set once the transaction is SIGNED, before it is broadcast -- the hash of
  // a signed transaction is known locally, so it is persisted first and a
  // crash at any later point leaves a hash an admin can look up on-chain.
  let hash: `0x${string}` | undefined;
  let nonce: number | undefined;
  let reverted = false;
  try {
    const px = await getUsdPrice(p.asset);
    // A STABLE payout goes out in the chain's primary dollar. Which stablecoin
    // a creator happened to deposit in has nothing to do with what they are
    // paid -- the ledger owes them cents, and this is the token those cents
    // are settled in.
    const token = p.asset === 'ONLYONE' ? TOKENS.ONLYONE : HEDGE_STABLE;
    const decimals = p.asset === 'ETH' ? DECIMALS.ETH : token.decimals;
    const units = Number(p.amountCents) / 100 / px;
    const raw = parseUnits(units.toFixed(decimals), decimals);
    const to = p.address as `0x${string}`;

    // Sign, persist the hash, then broadcast -- all under the treasury lock so
    // no other sender (sweep gas top-ups, hedge, burn) takes the same nonce.
    await withTreasuryLock(async () => {
      const wallet = treasuryWallet();
      const request = await wallet.prepareTransactionRequest(p.asset === 'ETH'
        ? { to, value: raw }
        : { to: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, raw] }) });
      const serialized = await wallet.signTransaction(request as any);
      hash = keccak256(serialized);
      nonce = request.nonce;
      await prisma.payout.update({ where: { id: p.id }, data: { txHash: hash, assetAmount: raw.toString(), priceUsed: px } });
      await wallet.sendRawTransaction({ serializedTransaction: serialized });
    });

    const rcpt = await publicClient.waitForTransactionReceipt({ hash: hash!, confirmations: 2 });
    if (rcpt.status !== 'success') { reverted = true; throw new Error('tx_reverted'); }

    await prisma.payout.update({ where: { id: p.id }, data: { status: 'SENT', txHash: hash, assetAmount: raw.toString(), priceUsed: px } });
    await publish(p.creatorId, { type: 'payout', status: 'SENT', txHash: hash, asset: p.asset, amount: units });
  } catch (e: any) {
    // Refund automatically only when no money can have moved: nothing was
    // ever signed, the receipt shows a revert (a reverted transfer moves no
    // tokens), or the signed tx provably never reached the chain. Everything
    // else -- a lost broadcast response, a receipt wait that timed out -- is
    // held FAILED with its hash for an admin to check on-chain. Never
    // double-pay.
    const refund = !hash || reverted || (nonce !== undefined && await provablyNeverSent(hash, nonce));
    if (refund) {
      await money(prisma, async (tx) => {
        const gross = p.amountCents + p.feeCents;
        await post(tx, p.creatorId, gross, 'PAYOUT_REVERSAL', p.id, { error: e.message });
        await post(tx, PLATFORM_ID, -p.feeCents, 'PAYOUT_REVERSAL', p.id);
        // The withdrawal fee's postPlatformRevenue() call (payouts.ts) wrote a
        // TokenBurn obligation with refId=p.id in the same transaction that
        // charged the fee. Reversing the fee without also cancelling that
        // obligation leaves a phantom burn on the books for revenue the
        // platform no longer has -- pendingBurnCents()/GET /admin/token-burns
        // would overstate what's actually owed, and a manual burn would be
        // burning against money that was given back. Guarded on
        // executedAt: null so an obligation the burn worker already executed
        // (already turned into a real on-chain burn) is correctly left alone.
        await tx.tokenBurn.deleteMany({ where: { refId: p.id, executedAt: null } });
      });
    }
    await prisma.payout.update({ where: { id: p.id }, data: { status: 'FAILED', txHash: hash ?? null, error: String(e.message).slice(0, 500) } });
    await publish(p.creatorId, { type: 'payout', status: 'FAILED', refunded: refund });
  }
}, { ...connection, concurrency: 1 });
