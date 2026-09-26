import { prisma } from '../lib/prisma.js';
import { envInt } from '../lib/chain.js';
import type { OutflowJournal } from '../lib/outflow-journal.js';

/**
 * Bounds on the one treasury-signed outflow the deposit sweep makes: the ETH
 * gas top-up a deposit address needs before it can move an ERC-20 to the
 * treasury (workers/deposit-indexer.ts, the 'sweep' worker).
 *
 * Sweep jobs come off a BullMQ queue in a localhost Redis, and the rows they
 * are checked against (DepositAddress) live in Postgres -- both writable by
 * every process on the box, including the media workers that run
 * ffmpeg/libvips over untrusted uploads. DEPOSIT_XPUB is in every unit's
 * environment, so such a writer can derive the real address for any index,
 * insert matching DepositAddress rows, dust each with one raw token unit and
 * queue a sweep per address: the key-holding worker then sent 0.00005 ETH of
 * treasury gas to every one of them, counted nowhere and capped by nothing,
 * until the treasury could not pay gas for payouts, burns or hedges.
 *
 * So a top-up is now:
 *  - refused unless the address has a CREDITED deposit of that asset on
 *    record (depositCreditedFor) -- the job's own data is never enough;
 *  - counted in the restart-proof outflow journal (kind 'gas', in gwei)
 *    once it is SIGNED and before it is broadcast, under the treasury lock,
 *    like every payout, burn and hedge. Recording it before the transaction
 *    was even prepared let every failed attempt (a treasury with no ETH, an
 *    RPC error -- 8 retries per job, re-queued hourly) use up the cap with
 *    nothing sent, so sweeps stayed refused for up to 24h after the treasury
 *    was refilled;
 *  - refused once SWEEP_GAS_DAILY_MAX_GWEI (default 0.005 ETH, i.e. 100
 *    top-ups) has been signed in the rolling 24h window, or when the journal
 *    is unavailable;
 *  - refused past SWEEP_GAS_PER_ADDRESS_DAILY top-ups (default 3) for one
 *    deposit address in that window, so one fan's address cannot use up the
 *    platform-wide cap; and
 *  - only worth making for a balance of at least a dollar (sweepWorthTopUp):
 *    a 1-cent deposit is credited in full (the 2% fee floors to 0) and used
 *    to buy a treasury-funded sweep of its own.
 * A refused sweep fails its job and is retried with backoff (or, below the
 * dollar floor, simply waits); the hourly reconciler re-queues any
 * stablecoin of a dollar or more left behind, so the funds wait at the
 * deposit address rather than being lost.
 */
export const SWEEP_GAS_TOPUP_GWEI = 50_000; // 0.00005 ETH
export const SWEEP_GAS_DAILY_MAX_GWEI = envInt('SWEEP_GAS_DAILY_MAX_GWEI', 5_000_000, SWEEP_GAS_TOPUP_GWEI);
export const SWEEP_GAS_PER_ADDRESS_DAILY = envInt('SWEEP_GAS_PER_ADDRESS_DAILY', 3, 1);
const DAY_MS = 24 * 60 * 60_000;

export class SweepGasDeferred extends Error {}

/** The journal ref of a top-up to one deposit address -- also the per-address key. */
export const gasTopUpRef = (chainId: number, derivationIndex: number) => `sweep-${chainId}-${derivationIndex}`;

/**
 * Why a top-up may not be signed right now, or null. Throws nothing: an
 * unusable journal is a refusal. With `ref`, also refused once that deposit
 * address has had `perAddressMax` top-ups in the window.
 */
export function gasTopUpRefusal(
  journal: OutflowJournal, dailyMaxGwei = SWEEP_GAS_DAILY_MAX_GWEI, amountGwei = SWEEP_GAS_TOPUP_GWEI,
  ref?: string, perAddressMax = SWEEP_GAS_PER_ADDRESS_DAILY,
): string | null {
  let used: number, usedHere = 0;
  try {
    used = journal.sumSince('gas', DAY_MS);
    if (ref !== undefined) usedHere = journal.sumSince('gas', DAY_MS, ref);
  } catch (e) {
    return `outflow journal unavailable (${(e as Error).message}) -- no gas top-ups until it is fixed`;
  }
  if (used + amountGwei > dailyMaxGwei) return `daily sweep-gas limit reached (SWEEP_GAS_DAILY_MAX_GWEI=${dailyMaxGwei}, ${used} used)`;
  if (ref !== undefined && usedHere + amountGwei > perAddressMax * amountGwei) {
    return `per-address sweep-gas limit reached for ${ref} (SWEEP_GAS_PER_ADDRESS_DAILY=${perAddressMax})`;
  }
  return null;
}

/**
 * Checks the caps and records the top-up in the journal, in that order.
 * Call it inside withTreasuryLock, AFTER the top-up is signed and before it
 * is broadcast: a top-up can never be sent without being counted (one
 * recorded and then not broadcast is over-counted -- the safe direction),
 * and one that failed to prepare or sign is never counted.
 */
export function claimGasTopUp(journal: OutflowJournal, ref: string, dailyMaxGwei = SWEEP_GAS_DAILY_MAX_GWEI, perAddressMax = SWEEP_GAS_PER_ADDRESS_DAILY): void {
  const why = gasTopUpRefusal(journal, dailyMaxGwei, SWEEP_GAS_TOPUP_GWEI, ref, perAddressMax);
  if (why) throw new SweepGasDeferred(`sweep gas top-up deferred: ${why}`);
  try {
    journal.record('gas', SWEEP_GAS_TOPUP_GWEI, ref);
  } catch (e) {
    throw new SweepGasDeferred(`sweep gas top-up deferred: outflow journal not writable (${(e as Error).message})`);
  }
}

/**
 * Has the deposit address at this index actually been credited a deposit of
 * this asset? The sweep job names only an index and an asset; the rows it
 * points at are what a database writer can forge cheaply, so the top-up
 * additionally needs a real, credited (priced) Deposit for that address's
 * owner on this chain. A deposit address has exactly one owner per chain
 * (DepositAddress @@unique([userId, chainId])). By asset, not by stablecoin
 * symbol: the hourly reconciler sweeps every accepted stablecoin at an
 * address that has ever received a STABLE deposit.
 */
export async function depositCreditedFor(chainId: number, derivationIndex: number, asset: 'STABLE' | 'ONLYONE'): Promise<boolean> {
  const addr = await prisma.depositAddress.findFirst({ where: { chainId, derivationIndex }, select: { userId: true } });
  if (!addr) return false;
  const d = await prisma.deposit.findFirst({ where: { userId: addr.userId, chainId, asset, pricePending: false, usdCents: { gt: 0n } }, select: { id: true } });
  return !!d;
}

/**
 * Is a token balance worth a treasury-funded gas top-up to sweep it? Only
 * at a dollar or more (the hourly reconciler's own floor, for stablecoins:
 * 10**decimals). `usdPx` is the token's dollar price (1 for a stablecoin);
 * a missing or non-positive price is never worth it.
 */
export function sweepWorthTopUp(raw: bigint, decimals: number, usdPx: number): boolean {
  if (!(usdPx > 0) || !Number.isFinite(usdPx)) return false;
  const unit = 10n ** BigInt(decimals);
  if (usdPx === 1) return raw >= unit;
  return raw * BigInt(Math.round(usdPx * 1e8)) >= unit * 100_000_000n;
}

/**
 * A native-ETH transfer INTO a deposit address from the platform itself --
 * the treasury's own gas top-up, or another deposit address -- is not a
 * fan's deposit. With TRACK_NATIVE_ETH on, each sweep top-up used to be
 * credited to the address owner as an ETH deposit, minting credits out of
 * treasury gas once per sweep.
 */
export function isPlatformSender(from: string | null | undefined, treasury: string | null, depositAddrs: { has(a: string): boolean }): boolean {
  if (!from) return false;
  const f = from.toLowerCase();
  return (!!treasury && f === treasury.toLowerCase()) || depositAddrs.has(f);
}
