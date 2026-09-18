import { Worker } from 'bullmq';
import { formatUnits, parseEther } from 'viem';
import { prisma } from '../lib/prisma';
import { publicClient, CHAIN_ID, CONFIRMATIONS, TOKENS, ADDR_TO_ASSET, TRANSFER_EVENT, DECIMALS, depositWalletClient, treasury, treasuryClient, erc20Abi } from '../lib/chain';
import { getUsdPrice, rawToUsdCents } from '../lib/price';
import { money, post } from '../core/ledger';
import { publish, sweepQueue, connection } from '../lib/redis';

const BATCH = 1000n;
const TRACK_NATIVE_ETH = process.env.TRACK_NATIVE_ETH === 'true';
const ONLYASS_BONUS_BPS = Number(process.env.ONLYASS_DEPOSIT_BONUS_BPS ?? 0);

async function addressMap() {
  const rows = await prisma.depositAddress.findMany({ where: { chainId: CHAIN_ID } });
  return new Map(rows.map(r => [r.address.toLowerCase(), r]));
}

async function credit(d: { userId: string; txHash: string; logIndex: number; asset: 'USDC' | 'ETH' | 'ONLYASS'; raw: bigint; derivationIndex: number }) {
  const px = await getUsdPrice(d.asset);
  let cents = rawToUsdCents(d.raw, DECIMALS[d.asset], px);
  if (d.asset === 'ONLYASS' && ONLYASS_BONUS_BPS) cents += (cents * BigInt(ONLYASS_BONUS_BPS)) / 10_000n;   // token deposit bonus
  if (cents <= 0n) return;
  try {
    await money(prisma, async (tx) => {
      const dep = await tx.deposit.create({ data: { userId: d.userId, chainId: CHAIN_ID, txHash: d.txHash, logIndex: d.logIndex, asset: d.asset, rawAmount: d.raw.toString(), usdCents: cents, priceUsed: px } });
      // $ONLYONE deposits land in their own pool, which is NOT spendable:
      // the only thing that can be done with it is a VIP burn (core/vip.ts).
      // USDC/ETH deposits become credits, which is what actually pays for
      // things. See the Balance type in core/ledger.ts.
      await post(tx, d.userId, cents, 'DEPOSIT', dep.id, { asset: d.asset, raw: d.raw.toString(), px }, d.asset === 'ONLYASS' ? 'ONLYASS' : 'CREDITS');
    });
  } catch (e: any) { if (e.code === 'P2002') return; throw e; }   // already credited
  await publish(d.userId, { type: 'deposit', asset: d.asset, amount: formatUnits(d.raw, DECIMALS[d.asset]), usdCents: Number(cents) });
  await sweepQueue.add('sweep', { derivationIndex: d.derivationIndex, asset: d.asset }, { delay: 60_000, removeOnComplete: true });
}

async function scan() {
  const head = await publicClient.getBlockNumber();
  const safe = head - BigInt(CONFIRMATIONS);
  const cursor = await prisma.chainCursor.upsert({ where: { chainId: CHAIN_ID }, create: { chainId: CHAIN_ID, lastBlock: safe - 1n }, update: {} });
  let from = cursor.lastBlock + 1n;
  if (from > safe) return;
  const addrs = await addressMap();
  if (!addrs.size) { await prisma.chainCursor.update({ where: { chainId: CHAIN_ID }, data: { lastBlock: safe } }); return; }

  while (from <= safe) {
    const to = from + BATCH - 1n > safe ? safe : from + BATCH - 1n;

    // ERC20: USDC + $ONLYASS transfers to any of our addresses
    const logs = await publicClient.getLogs({ address: [TOKENS.USDC.address, TOKENS.ONLYASS.address], event: TRANSFER_EVENT, args: { to: [...addrs.values()].map(a => a.address as `0x${string}`) }, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const row = addrs.get(l.args.to!.toLowerCase()); const asset = ADDR_TO_ASSET.get(l.address.toLowerCase());
      if (!row || !asset || !l.args.value) continue;
      await credit({ userId: row.userId, txHash: l.transactionHash, logIndex: l.logIndex, asset, raw: l.args.value, derivationIndex: row.derivationIndex });
    }

    // Native ETH: scan block txs (only catches direct transfers, not internal calls — document this to users)
    if (TRACK_NATIVE_ETH) {
      for (let b = from; b <= to; b++) {
        const block = await publicClient.getBlock({ blockNumber: b, includeTransactions: true });
        for (const t of block.transactions) {
          const row = t.to && addrs.get(t.to.toLowerCase());
          if (row && t.value > 0n) await credit({ userId: row.userId, txHash: t.hash, logIndex: -1, asset: 'ETH', raw: t.value, derivationIndex: row.derivationIndex });
        }
      }
    }
    await prisma.chainCursor.update({ where: { chainId: CHAIN_ID }, data: { lastBlock: to } });
    from = to + 1n;
  }
}

(async function loop() {
  for (;;) {
    try { await scan(); } catch (e) { console.error('indexer', e); }
    await new Promise(r => setTimeout(r, Number(process.env.INDEXER_INTERVAL_MS ?? 6000)));
  }
})();

/** Move funds from deposit address → treasury. ERC20 sweeps need gas first. */
new Worker('sweep', async (job) => {
  const { derivationIndex, asset } = job.data as { derivationIndex: number; asset: 'USDC' | 'ETH' | 'ONLYASS' };
  const wc = depositWalletClient(derivationIndex); const me = wc.account.address;
  if (asset === 'ETH') {
    const bal = await publicClient.getBalance({ address: me });
    const gas = await publicClient.estimateFeesPerGas(); const cost = 21_000n * (gas.maxFeePerGas ?? 0n) * 2n;
    if (bal > cost) await wc.sendTransaction({ to: treasury.address, value: bal - cost });
    return;
  }
  const tok = TOKENS[asset];
  const bal = await publicClient.readContract({ address: tok.address, abi: erc20Abi, functionName: 'balanceOf', args: [me] });
  if (bal === 0n) return;
  const gasBal = await publicClient.getBalance({ address: me });
  if (gasBal < parseEther('0.00002')) {
    const h = await treasuryClient.sendTransaction({ to: me, value: parseEther('0.00005') });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  const h = await wc.writeContract({ address: tok.address, abi: erc20Abi, functionName: 'transfer', args: [treasury.address, bal] });
  await publicClient.waitForTransactionReceipt({ hash: h });
}, { ...connection, concurrency: 1 });
