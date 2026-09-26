import type { Address } from 'viem';
import { prisma } from '../lib/prisma.js';
import { publicClient, resolveTreasuryTx, onlyOneBurnedIn, envInt } from '../lib/chain.js';
import { allocateHedge } from '../workers/treasury-hedge-math.js';

/**
 * Settling a treasury swap (automatic burn or hedge) that was signed,
 * persisted and maybe broadcast, shared by the workers (token-burn.ts,
 * treasury-hedge.ts) and the admin route that closes one they cannot
 * (POST /admin/treasury-tx/:kind/:id/resolve).
 *
 * Kept out of the worker modules on purpose: those start their polling
 * loops at import, and the API process must never run one.
 */

/** % of each $ONLYONE deposit the hedge converts to stablecoin (workers/treasury-hedge.ts). */
export const HEDGE_BPS = envInt('TREASURY_HEDGE_BPS', 7500, 0, 10_000);

const CLEAR_PENDING = { pendingTxHash: null, pendingNonce: null, pendingSince: null, pendingSigner: null } as const;

/** The burn swap `hash` succeeded: its obligations are executed, with what actually reached the sink. */
export async function markBurnExecuted(hash: `0x${string}`, logs: Parameters<typeof onlyOneBurnedIn>[0]) {
  const burned = onlyOneBurnedIn(logs);
  const done = await prisma.tokenBurn.updateMany({
    where: { executedAt: null, pendingTxHash: hash },
    data: { executedAt: new Date(), txHash: hash.toLowerCase(), tokensBurned: burned.toString(), ...CLEAR_PENDING },
  });
  return done.count;
}

/** The burn swap `hash` bought nothing: its obligations are owed again, as they were. */
export async function releaseBurn(hash: `0x${string}`) {
  const r = await prisma.tokenBurn.updateMany({ where: { executedAt: null, pendingTxHash: hash }, data: CLEAR_PENDING });
  return r.count;
}

/**
 * Applies a mined hedge swap to the deposits it hedged: the oldest unhedged
 * deposits absorb `amountIn`.
 *
 * Exactly once per batch. The PENDING -> DONE flip is a guarded update that
 * runs FIRST, in the same transaction as the allocation, so a second
 * settlement of the same success (a second worker process, a retry after a
 * partial failure, an admin resolve racing the worker) matches nothing and
 * allocates nothing.
 */
export async function applyHedge(batchId: string, amountIn: bigint) {
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const claimed = await tx.treasuryHedgeBatch.updateMany({ where: { id: batchId, status: 'PENDING' }, data: { status: 'DONE', resolvedAt: now } });
    if (claimed.count !== 1) return;
    const pending = await tx.deposit.findMany({ where: { asset: 'ONLYONE', hedgedAt: null }, orderBy: { createdAt: 'asc' } });
    const alloc = allocateHedge(pending, amountIn, HEDGE_BPS);
    for (const a of alloc) {
      await tx.deposit.update({ where: { id: a.id }, data: { hedgedRaw: a.hedgedRaw.toString(), ...(a.done ? { hedgedAt: now } : {}) } });
    }
    await tx.treasuryHedgeBatch.update({ where: { id: batchId }, data: { depositCount: alloc.filter((a) => a.done).length } });
  });
}

/** The hedge swap sold nothing (reverted, dropped, or closed by an admin). */
export async function failHedge(batchId: string) {
  const r = await prisma.treasuryHedgeBatch.updateMany({ where: { id: batchId, status: 'PENDING' }, data: { status: 'FAILED', resolvedAt: new Date() } });
  return r.count;
}

const NO_KEY = '0x0000000000000000000000000000000000000000' as Address;

export type AdminResolveResult =
  | { ok: true; kind: 'burn' | 'hedge'; outcome: 'executed' | 'released'; state: string; rows: number }
  | { ok: false; status: number; error: string; state?: string; signer?: string | null };

/**
 * An admin closing an in-flight treasury swap the worker leaves alone.
 *
 * The worker judges a swap's "dropped" only by the CURRENT key's nonce, so
 * after a treasury key rotation a swap the old key signed -- or a row with no
 * recorded signer -- stays 'unknown' for good, and the burn / hedge loop
 * refuses to start another while it is in flight: both stop permanently
 * (round-14 audit). This resolves it:
 *
 *  - Judged against the key RECORDED as having signed it, i.e. that key's
 *    own confirmed nonce: a transaction no node knows at a nonce its signer
 *    has already moved past can never land. A receipt settles it whoever
 *    signed (success = executed; reverted = nothing bought).
 *  - Still undecided (the tx may sit in a mempool; the signer is unknown):
 *    refused unless `acknowledgeNeverLands` -- the admin has checked the
 *    explorer (the old wallet's nonce moved past it, or it was emptied and
 *    holds no gas). Forced, a burn's obligations are owed again and a hedge
 *    batch is FAILED; if that transaction lands after all, the burn is
 *    bought a second time. That is why it is never automatic.
 *
 * Every write is guarded on the row still being in flight, so this cannot
 * double-settle against a worker settling the same row.
 */
export async function adminResolveInFlight(
  kind: 'burn' | 'hedge', id: string,
  opts: { acknowledgeNeverLands?: boolean } = {},
  client: Parameters<typeof resolveTreasuryTx>[2] = publicClient as any,
): Promise<AdminResolveResult> {
  let hash: `0x${string}`, nonce: number | null, signer: string | null, batch: { id: string; onlyOneRawIn: string } | null = null;
  if (kind === 'burn') {
    const h = String(id).trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(h)) return { ok: false, status: 400, error: 'invalid_tx_hash' };
    const row = await prisma.tokenBurn.findFirst({ where: { executedAt: null, pendingTxHash: { equals: h, mode: 'insensitive' } }, select: { pendingTxHash: true, pendingNonce: true, pendingSigner: true } });
    if (!row?.pendingTxHash) return { ok: false, status: 404, error: 'not_in_flight' };
    hash = row.pendingTxHash as `0x${string}`; nonce = row.pendingNonce; signer = row.pendingSigner;
  } else {
    const b = await prisma.treasuryHedgeBatch.findUnique({ where: { id: String(id) } });
    if (!b) return { ok: false, status: 404, error: 'not_found' };
    if (b.status !== 'PENDING') return { ok: false, status: 409, error: 'not_in_flight', state: b.status };
    hash = b.txHash as `0x${string}`; nonce = b.nonce; signer = b.signerAddress;
    batch = { id: b.id, onlyOneRawIn: b.onlyOneRawIn };
  }

  const validSigner = !!signer && /^0x[0-9a-fA-F]{40}$/.test(signer);
  // The signer's own nonce answers "can it still land" -- never the current
  // key's, and no private key is needed for it in the API process.
  const r = validSigner
    ? await resolveTreasuryTx(hash, nonce, client, signer as Address, signer)
    : await resolveTreasuryTx(hash, nonce, client, NO_KEY, null);

  const execute = async () => kind === 'burn' ? markBurnExecuted(hash, r.receipt?.logs ?? []) : (await applyHedge(batch!.id, BigInt(batch!.onlyOneRawIn)), 1);
  const release = async () => kind === 'burn' ? releaseBurn(hash) : failHedge(batch!.id);

  if (r.state === 'success') return { ok: true, kind, outcome: 'executed', state: r.state, rows: await execute() };
  if (r.state === 'reverted' || r.state === 'dropped') return { ok: true, kind, outcome: 'released', state: r.state, rows: await release() };
  if (!opts.acknowledgeNeverLands) return { ok: false, status: 409, error: 'still_unknown_check_explorer', state: r.state, signer };
  return { ok: true, kind, outcome: 'released', state: 'acknowledged_never_lands', rows: await release() };
}
