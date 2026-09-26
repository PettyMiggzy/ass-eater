import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'crypto';
import { encodeAbiParameters, pad, TransactionReceiptNotFoundError, TransactionNotFoundError } from 'viem';
import { PrismaClient } from '@prisma/client';

// Round-3 regression tests for the chain-side fixes: the stablecoin decimals
// gate, settling a treasury transaction from the chain, the automatic burn
// never paying for the same obligations twice, and manual burn records.
process.env.ONLYONE_TOKEN_ADDRESS = '0x2c34ED86552076715272056D021cEab6080F1Ab5';
const chain = await import('../lib/chain.js');
const { settleInFlightBurn } = await import('./token-burn.js');
const { settleInFlightHedge } = await import('./treasury-hedge.js');

const prisma = new PrismaClient();
afterAll(() => prisma.$disconnect());

const TREASURY = '0x1111111111111111111111111111111111111111' as const;
const hash = () => `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const burnLog = (value: bigint) => ({
  address: process.env.ONLYONE_TOKEN_ADDRESS!, data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  topics: [TRANSFER, pad('0x3333333333333333333333333333333333333333'), pad(chain.DEAD_ADDRESS)] as `0x${string}`[],
});

/** A fake RPC: `receipts` / `known` by hash, and the treasury's confirmed nonce. */
function client(o: { receipts?: Record<string, any>; known?: string[]; nonce?: number; fail?: boolean }) {
  return {
    getTransactionReceipt: async ({ hash: h }: { hash: string }) => {
      if (o.fail) throw new Error('rpc down');
      if (o.receipts?.[h]) return o.receipts[h];
      throw new TransactionReceiptNotFoundError({ hash: h as `0x${string}` });
    },
    getTransaction: async ({ hash: h }: { hash: string }) => {
      if (o.known?.includes(h)) return {};
      throw new TransactionNotFoundError({ hash: h as `0x${string}` });
    },
    getTransactionCount: async () => o.nonce ?? 0,
  };
}

describe('assertStableDecimals', () => {
  it('refuses a configured scale the contract disagrees with, and remembers it', async () => {
    chain.resetStableDecimalsCheck();
    let calls = 0;
    const wrong = { readContract: async () => { calls++; return chain.HEDGE_STABLE.decimals + 4; } };
    await expect(chain.assertStableDecimals(wrong)).rejects.toBeInstanceOf(chain.TokenDecimalsMismatchError);
    await expect(chain.assertStableDecimals(wrong)).rejects.toBeInstanceOf(chain.TokenDecimalsMismatchError);
    expect(calls).toBe(1);
    chain.resetStableDecimalsCheck();
    await expect(chain.assertStableDecimals({ readContract: async () => chain.HEDGE_STABLE.decimals })).resolves.toBeUndefined();
    chain.resetStableDecimalsCheck();
  });

  it('does not cache an RPC failure', async () => {
    chain.resetStableDecimalsCheck();
    await expect(chain.assertStableDecimals({ readContract: async () => { throw new Error('rpc down'); } })).rejects.toThrow('rpc down');
    await expect(chain.assertStableDecimals({ readContract: async () => chain.HEDGE_STABLE.decimals })).resolves.toBeUndefined();
    chain.resetStableDecimalsCheck();
  });
});

describe('resolveTreasuryTx', () => {
  it('answers success/reverted from a receipt, dropped only when unknown AND the nonce moved past, else unknown', async () => {
    const h = hash();
    expect((await chain.resolveTreasuryTx(h, 5, client({ receipts: { [h]: { status: 'success', logs: [] } } }), TREASURY)).state).toBe('success');
    expect((await chain.resolveTreasuryTx(h, 5, client({ receipts: { [h]: { status: 'reverted', logs: [] } } }), TREASURY)).state).toBe('reverted');
    expect((await chain.resolveTreasuryTx(h, 5, client({ nonce: 6 }), TREASURY)).state).toBe('dropped');
    expect((await chain.resolveTreasuryTx(h, 5, client({ nonce: 5 }), TREASURY)).state).toBe('unknown');   // could still land
    expect((await chain.resolveTreasuryTx(h, 5, client({ nonce: 9, known: [h] }), TREASURY)).state).toBe('unknown'); // pending
    expect((await chain.resolveTreasuryTx(h, 5, client({ fail: true }), TREASURY)).state).toBe('unknown');
  });

  it('decides dropped only for a transaction the current key signed', async () => {
    const h = hash();
    expect((await chain.resolveTreasuryTx(h, 5, client({ nonce: 6 }), TREASURY, TREASURY.toUpperCase().replace('0X', '0x'))).state).toBe('dropped');
    expect((await chain.resolveTreasuryTx(h, 5, client({ nonce: 6 }), TREASURY, '0x2222222222222222222222222222222222222222')).state).toBe('unknown');
    expect((await chain.resolveTreasuryTx(h, 5, client({ nonce: 6 }), TREASURY, null)).state).toBe('unknown');
    // A receipt settles it whoever signed.
    expect((await chain.resolveTreasuryTx(h, 5, client({ receipts: { [h]: { status: 'reverted', logs: [] } } }), TREASURY, '0x2222222222222222222222222222222222222222')).state).toBe('reverted');
  });
});

describe('automatic burn: an in-flight swap is settled, never repeated', () => {
  // Signed by the CURRENT treasury key unless told otherwise (TokenBurn.pendingSigner).
  async function obligation(pendingTxHash: string | null, pendingNonce: number | null = 7, pendingSigner: string | null = chain.treasuryAccount().address) {
    return prisma.tokenBurn.create({ data: { usdCents: 5000n, reason: 'test', pendingTxHash, pendingNonce, pendingSince: pendingTxHash ? new Date() : null, pendingSigner } });
  }
  // Isolated from other rows in the shared table by settling one hash at a time.
  it('marks the obligations executed from a successful receipt', async () => {
    const h = hash();
    const row = await obligation(h);
    // settleInFlightBurn picks the OLDEST in-flight row; clear any strays from other runs first.
    await prisma.tokenBurn.updateMany({ where: { executedAt: null, pendingTxHash: { not: null }, NOT: { id: row.id } }, data: { pendingTxHash: null, pendingNonce: null } });
    expect(await settleInFlightBurn(client({ receipts: { [h]: { status: 'success', logs: [burnLog(123n)] } } }) as any)).toBe(true);
    const r = await prisma.tokenBurn.findUniqueOrThrow({ where: { id: row.id } });
    expect(r.executedAt).toBeInstanceOf(Date);
    expect(r.txHash).toBe(h.toLowerCase());
    expect(r.tokensBurned).toBe('123');
    expect(r.pendingTxHash).toBeNull();
  });

  it('leaves a still-unsettled swap alone and blocks a new one', async () => {
    const h = hash();
    const row = await obligation(h);
    await prisma.tokenBurn.updateMany({ where: { executedAt: null, pendingTxHash: { not: null }, NOT: { id: row.id } }, data: { pendingTxHash: null, pendingNonce: null } });
    expect(await settleInFlightBurn(client({ nonce: 7 }) as any)).toBe(false);
    expect((await prisma.tokenBurn.findUniqueOrThrow({ where: { id: row.id } })).pendingTxHash).toBe(h);
    // Dropped (nonce moved past, tx unknown): owed again, nothing marked burned.
    expect(await settleInFlightBurn(client({ nonce: 8 }) as any)).toBe(true);
    const r = await prisma.tokenBurn.findUniqueOrThrow({ where: { id: row.id } });
    expect(r.pendingTxHash).toBeNull();
    expect(r.executedAt).toBeNull();
    await prisma.tokenBurn.delete({ where: { id: row.id } });
  });

  it('never judges a swap signed by ANOTHER key (a rotated-out treasury) or an unknown signer dropped by the current wallet\'s nonce', async () => {
    for (const signer of ['0x9999999999999999999999999999999999999999', null]) {
      const h = hash();
      const row = await obligation(h, 7, signer);
      await prisma.tokenBurn.updateMany({ where: { executedAt: null, pendingTxHash: { not: null }, NOT: { id: row.id } }, data: { pendingTxHash: null, pendingNonce: null } });
      // The new wallet's count is well past 7, and the old-key tx is unknown:
      // that proves nothing about the OLD key's nonce 7, so it stays in flight.
      expect(await settleInFlightBurn(client({ nonce: 50 }) as any)).toBe(false);
      expect((await prisma.tokenBurn.findUniqueOrThrow({ where: { id: row.id } })).pendingTxHash).toBe(h);
      // A receipt is still an answer, whoever signed.
      expect(await settleInFlightBurn(client({ receipts: { [h]: { status: 'success', logs: [burnLog(1n)] } } }) as any)).toBe(true);
      expect((await prisma.tokenBurn.findUniqueOrThrow({ where: { id: row.id } })).executedAt).toBeInstanceOf(Date);
    }
  });

  it('counts address(0) as a burn sink only when asked', () => {
    const zeroLog = { ...burnLog(5n), topics: [TRANSFER, pad('0x3333333333333333333333333333333333333333'), pad('0x0000000000000000000000000000000000000000')] as `0x${string}`[] };
    expect(chain.onlyOneBurnedIn([zeroLog])).toBe(0n);
    expect(chain.onlyOneBurnedIn([zeroLog], { includeZero: true })).toBe(5n);
    expect(chain.onlyOneBurnedIn([burnLog(7n)])).toBe(7n);
  });
});

describe('manual burn record: only the platform\'s own burns count', () => {
  it('filters burn transfers by sender when asked', () => {
    const other = burnLog(9n); // from 0x3333…
    expect(chain.onlyOneBurnedIn([other], { from: [TREASURY] })).toBe(0n);
    expect(chain.onlyOneBurnedIn([other], { from: ['0x3333333333333333333333333333333333333333'] })).toBe(9n);
    expect(chain.onlyOneBurnedIn([other])).toBe(9n);
  });

  it('burnSenders takes BURN_SENDER_ADDRESSES and drops junk', () => {
    const prev = process.env.BURN_SENDER_ADDRESSES;
    process.env.BURN_SENDER_ADDRESSES = ' 0x4444444444444444444444444444444444444444 , nope,';
    try {
      expect(chain.burnSenders()).toContain('0x4444444444444444444444444444444444444444');
      expect(chain.burnSenders()).not.toContain('nope');
    } finally {
      if (prev === undefined) delete process.env.BURN_SENDER_ADDRESSES; else process.env.BURN_SENDER_ADDRESSES = prev;
    }
  });
});

describe('treasury hedge: a settled swap is applied exactly once', () => {
  it('two concurrent settlements of the same success advance hedgedRaw once', async () => {
    const uid = randomBytes(16).toString('hex');
    await prisma.user.create({ data: { id: uid, email: `${uid}@test.local`, username: `u_${uid.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01') } });
    // settleInFlightHedge takes the OLDEST pending batch and allocates over
    // every unhedged ONLYONE deposit; park any strays from other runs.
    await prisma.treasuryHedgeBatch.updateMany({ where: { status: 'PENDING' }, data: { status: 'FAILED' } });
    await prisma.deposit.updateMany({ where: { asset: 'ONLYONE', hedgedAt: null }, data: { hedgedAt: new Date() } });
    const dep = await prisma.deposit.create({ data: { userId: uid, chainId: 1, txHash: hash(), logIndex: 0, asset: 'ONLYONE', rawAmount: '10000', usdCents: 100n, priceUsed: 1 } });
    const h = hash();
    const batch = await prisma.treasuryHedgeBatch.create({ data: { depositCount: 0, onlyOneRawIn: '1000', usdcRawOut: '1', priceImpactBps: 0, txHash: h, nonce: 3, status: 'PENDING' } });
    const c = client({ receipts: { [h]: { status: 'success', logs: [] } } }) as any;
    const results = await Promise.allSettled([settleInFlightHedge(c), settleInFlightHedge(c)]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    // A retry after everything settled is a no-op too.
    await settleInFlightHedge(c);
    expect((await prisma.deposit.findUniqueOrThrow({ where: { id: dep.id } })).hedgedRaw).toBe('1000');
    expect((await prisma.treasuryHedgeBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe('DONE');
  });

  it('a swap signed by a rotated-out key is never failed by the new wallet\'s nonce; the current key\'s is', async () => {
    await prisma.treasuryHedgeBatch.updateMany({ where: { status: 'PENDING' }, data: { status: 'FAILED' } });
    const h = hash();
    const old = await prisma.treasuryHedgeBatch.create({ data: { depositCount: 0, onlyOneRawIn: '1', usdcRawOut: '1', priceImpactBps: 0, txHash: h, nonce: 3, status: 'PENDING', signerAddress: '0x9999999999999999999999999999999999999999' } });
    expect(await settleInFlightHedge(client({ nonce: 40 }) as any)).toBe(false);
    expect((await prisma.treasuryHedgeBatch.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('PENDING');
    await prisma.treasuryHedgeBatch.update({ where: { id: old.id }, data: { signerAddress: chain.treasuryAccount().address } });
    expect(await settleInFlightHedge(client({ nonce: 40 }) as any)).toBe(true);
    expect((await prisma.treasuryHedgeBatch.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('FAILED');
  });
});
