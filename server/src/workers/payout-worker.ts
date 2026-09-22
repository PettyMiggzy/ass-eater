import { Worker } from 'bullmq';
import { parseUnits } from 'viem';
import { prisma } from '../lib/prisma.js';
import { publicClient, treasuryClient, TOKENS, DECIMALS, HEDGE_STABLE, erc20Abi } from '../lib/chain.js';
import { getUsdPrice } from '../lib/price.js';
import { money, post, PLATFORM_ID } from '../core/ledger.js';
import { publish, connection } from '../lib/redis.js';

new Worker('payout', async (job) => {
  const p = await prisma.payout.findUniqueOrThrow({ where: { id: job.data.payoutId } });
  if (p.status !== 'PENDING') return;
  await prisma.payout.update({ where: { id: p.id }, data: { status: 'PROCESSING' } });

  let hash: `0x${string}` | undefined;
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

    hash = p.asset === 'ETH'
      ? await treasuryClient.sendTransaction({ to, value: raw })
      : await treasuryClient.writeContract({ address: token.address, abi: erc20Abi, functionName: 'transfer', args: [to, raw] });

    const rcpt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
    if (rcpt.status !== 'success') throw new Error('tx_reverted');

    await prisma.payout.update({ where: { id: p.id }, data: { status: 'SENT', txHash: hash, assetAmount: raw.toString(), priceUsed: px } });
    await publish(p.creatorId, { type: 'payout', status: 'SENT', txHash: hash, asset: p.asset, amount: units });
  } catch (e: any) {
    // Not broadcast → safe to auto-refund. Broadcast but failed/unknown → hold for admin (never double-pay).
    if (!hash) {
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
    await prisma.payout.update({ where: { id: p.id }, data: { status: 'FAILED', txHash: hash, error: String(e.message).slice(0, 500) } });
    await publish(p.creatorId, { type: 'payout', status: 'FAILED', refunded: !hash });
  }
}, { ...connection, concurrency: 1 });   // concurrency 1 = sane nonce handling on the treasury key
