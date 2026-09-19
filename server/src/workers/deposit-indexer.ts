import { Worker } from 'bullmq';
import { formatUnits, parseEther } from 'viem';
import { prisma } from '../lib/prisma';
import { publicClient, CHAIN_ID, CONFIRMATIONS, TOKENS, ACCEPTED_STABLES, ADDR_TO_ASSET, TRANSFER_EVENT, DECIMALS, WATCHED_TOKENS, depositWalletClient, treasury, treasuryClient, erc20Abi, assertTokenDecimals } from '../lib/chain';
import { getUsdPrice, rawToUsdCents } from '../lib/price';
import { money, post, creditDeposit } from '../core/ledger';
import { publish, sweepQueue, connection } from '../lib/redis';

const BATCH = 1000n;
const TRACK_NATIVE_ETH = process.env.TRACK_NATIVE_ETH === 'true';
const ONLYONE_BONUS_BPS = Number(process.env.ONLYONE_DEPOSIT_BONUS_BPS ?? 0);

async function addressMap() {
  const rows = await prisma.depositAddress.findMany({ where: { chainId: CHAIN_ID } });
  return new Map(rows.map(r => [r.address.toLowerCase(), r]));
}

async function credit(d: { userId: string; txHash: string; logIndex: number; asset: 'STABLE' | 'ETH' | 'ONLYONE'; raw: bigint; derivationIndex: number; token?: { symbol: string; decimals: number }; tokenAddress?: `0x${string}` }) {
  const px = await getUsdPrice(d.asset);
  // A stablecoin's decimals come from its own allowlist entry (checked against
  // the contract at startup), not from a fixed table -- two dollar tokens on
  // the same chain do not have to agree on scale.
  const decimals = d.asset === 'STABLE' ? d.token!.decimals : DECIMALS[d.asset as 'ETH' | 'ONLYONE'];
  let cents = rawToUsdCents(d.raw, decimals, px);
  if (d.asset === 'ONLYONE' && ONLYONE_BONUS_BPS) cents += (cents * BigInt(ONLYONE_BONUS_BPS)) / 10_000n;   // token deposit bonus
  if (cents <= 0n) return;
  try {
    await money(prisma, async (tx) => {
      const dep = await tx.deposit.create({ data: { userId: d.userId, chainId: CHAIN_ID, txHash: d.txHash, logIndex: d.logIndex, asset: d.asset, stableSymbol: d.token?.symbol ?? null, rawAmount: d.raw.toString(), usdCents: cents, priceUsed: px } });
      if (d.asset === 'ONLYONE') {
        // Its own pool, and deliberately not credits -- see the Balance type
        // in core/ledger.ts. No buy-credits fee, because no credits are
        // bought. NOTE: nothing currently spends this balance; see MEMORY.md.
        await post(tx, d.userId, cents, 'DEPOSIT', dep.id, { asset: d.asset, raw: d.raw.toString(), px }, 'ONLYONE');
        return;
      }
      // Buying credits: the fan gets the deposit less FEES.DEPOSIT_BPS, the
      // platform keeps the rest.
      const { feeCents } = await creditDeposit(tx, d.userId, cents, dep.id, { asset: d.asset, raw: d.raw.toString(), px });
      await tx.deposit.update({ where: { id: dep.id }, data: { feeCents } });
    });
  } catch (e: any) { if (e.code === 'P2002') return; throw e; }   // already credited
  await publish(d.userId, { type: 'deposit', asset: d.token?.symbol ?? d.asset, amount: formatUnits(d.raw, decimals), usdCents: Number(cents) });
  // The contract address rides along: with several stablecoins accepted, the
  // asset alone no longer says which ERC-20 to sweep.
  await sweepQueue.add('sweep', { derivationIndex: d.derivationIndex, asset: d.asset, tokenAddress: d.tokenAddress }, { delay: 60_000, removeOnComplete: true });
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

    // ERC20: every accepted stablecoin plus $ONLYONE, to any of our addresses.
    // Filtering by contract address in the log query is what makes this an
    // allowlist rather than a ticker match -- a token that calls itself USDG
    // from a different contract is never even looked at.
    const logs = await publicClient.getLogs({ address: WATCHED_TOKENS.map(t => t.address), event: TRANSFER_EVENT, args: { to: [...addrs.values()].map(a => a.address as `0x${string}`) }, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const row = addrs.get(l.args.to!.toLowerCase()); const asset = ADDR_TO_ASSET.get(l.address.toLowerCase());
      if (!row || !asset || !l.args.value) continue;
      const token = ACCEPTED_STABLES.get(l.address.toLowerCase());
      await credit({ userId: row.userId, txHash: l.transactionHash, logIndex: l.logIndex, asset, raw: l.args.value, derivationIndex: row.derivationIndex, token, tokenAddress: l.address });
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
  // Before crediting anyone anything: confirm the configured token scales
  // match the contracts. Dying at startup on a mismatch is the correct
  // behaviour -- an indexer that runs with the wrong decimals mints balances.
  await assertTokenDecimals();

  for (;;) {
    try { await scan(); } catch (e) { console.error('indexer', e); }
    await new Promise(r => setTimeout(r, Number(process.env.INDEXER_INTERVAL_MS ?? 6000)));
  }
})();

/** Move funds from deposit address → treasury. ERC20 sweeps need gas first. */
new Worker('sweep', async (job) => {
  const { derivationIndex, asset, tokenAddress } = job.data as { derivationIndex: number; asset: 'STABLE' | 'ETH' | 'ONLYONE'; tokenAddress?: `0x${string}` };
  const wc = depositWalletClient(derivationIndex); const me = wc.account.address;
  if (asset === 'ETH') {
    const bal = await publicClient.getBalance({ address: me });
    const gas = await publicClient.estimateFeesPerGas(); const cost = 21_000n * (gas.maxFeePerGas ?? 0n) * 2n;
    if (bal > cost) await wc.sendTransaction({ to: treasury.address, value: bal - cost });
    return;
  }
  const tok = asset === 'ONLYONE' ? TOKENS.ONLYONE : ACCEPTED_STABLES.get((tokenAddress ?? '').toLowerCase());
  if (!tok) return; // unknown token in a sweep job -- never guess which contract to move

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
