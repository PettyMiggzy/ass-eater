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
 *    BEFORE it is signed, under the treasury lock, like every payout, burn
 *    and hedge; and
 *  - refused once SWEEP_GAS_DAILY_MAX_GWEI (default 0.005 ETH, i.e. 100
 *    top-ups) has been signed in the rolling 24h window, or when the journal
 *    is unavailable. A refused sweep fails its job and is retried with
 *    backoff; the hourly reconciler re-queues any stablecoin left behind, so
 *    the funds wait at the deposit address rather than being lost.
 */
export const SWEEP_GAS_TOPUP_GWEI = 50_000; // 0.00005 ETH
export const SWEEP_GAS_DAILY_MAX_GWEI = envInt('SWEEP_GAS_DAILY_MAX_GWEI', 5_000_000, SWEEP_GAS_TOPUP_GWEI);
const DAY_MS = 24 * 60 * 60_000;

export class SweepGasDeferred extends Error {}

/** Why a top-up may not be signed right now, or null. Throws nothing: an unusable journal is a refusal. */
export function gasTopUpRefusal(journal: OutflowJournal, dailyMaxGwei = SWEEP_GAS_DAILY_MAX_GWEI, amountGwei = SWEEP_GAS_TOPUP_GWEI): string | null {
  let used: number;
  try {
    used = journal.sumSince('gas', DAY_MS);
  } catch (e) {
    return `outflow journal unavailable (${(e as Error).message}) -- no gas top-ups until it is fixed`;
  }
  if (used + amountGwei > dailyMaxGwei) return `daily sweep-gas limit reached (SWEEP_GAS_DAILY_MAX_GWEI=${dailyMaxGwei}, ${used} used)`;
  return null;
}

/**
 * Checks the cap and records the top-up in the journal, in that order. Call
 * it inside withTreasuryLock, immediately before signing: the journal write
 * happens first, so a top-up can never be sent without being counted (one
 * recorded and then not sent is over-counted -- the safe direction).
 */
export function claimGasTopUp(journal: OutflowJournal, ref: string, dailyMaxGwei = SWEEP_GAS_DAILY_MAX_GWEI): void {
  const why = gasTopUpRefusal(journal, dailyMaxGwei);
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
