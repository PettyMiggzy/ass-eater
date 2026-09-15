import { Worker } from 'bullmq';
import { parseUnits } from 'viem';
import { prisma } from '../lib/prisma';
import { publicClient, treasuryClient, TOKENS, DECIMALS, erc20Abi } from '../lib/chain';
import { getUsdPrice } from '../lib/price';
import { money, post, PLATFORM_ID } from '../core/ledger';
import { publish, connection } from '../lib/redis';

new Worker('payout', async (job) => {
  const p = await prisma.payout.findUniqueOrThrow({ where: { id: job.data.payoutId } });
  if (p.status !== 'PENDING') return;
  await prisma.payout.update({ where: { id: p.id }, data: { status: 'PROCESSING' } });

  let hash: `0x${string}` | undefined;
  try {
    const px = await getUsdPrice(p.asset);
    const units = Number(p.amountCents) / 100 / px;
    const raw = parseUnits(units.toFixed(DECIMALS[p.asset]), DECIMALS[p.asset]);
    const to = p.address as `0x${string}`;

    hash = p.asset === 'ETH'
      ? await treasuryClient.sendTransaction({ to, value: raw })
      : await treasuryClient.writeContract({ address: TOKENS[p.asset].address, abi: erc20Abi, functionName: 'transfer', args: [to, raw] });

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
      });
    }
    await prisma.payout.update({ where: { id: p.id }, data: { status: 'FAILED', txHash: hash, error: String(e.message).slice(0, 500) } });
    await publish(p.creatorId, { type: 'payout', status: 'FAILED', refunded: !hash });
  }
}, { ...connection, concurrency: 1 });   // concurrency 1 = sane nonce handling on the treasury key
