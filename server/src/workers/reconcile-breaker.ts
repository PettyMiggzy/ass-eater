/**
 * Circuit breaker for the hourly sweep reconciler (workers/deposit-indexer.ts
 * reconcileSweeps).
 *
 * Each address is checked in its own try/catch so one bad address does not
 * end the pass -- but with nothing else, an RPC that is down or answering 429
 * got one balance call per candidate address (times viem's retries), every
 * hour, on the same quota the deposit scan and the payout worker need: the
 * reconciler kept the outage going and logged one full error per address.
 *
 * The breaker trips after `limit` CONSECUTIVE failures (any success resets
 * it), shared across every asset walk in one pass, so once it trips the rest
 * of that walk and the later walks are skipped; the next hourly pass retries
 * everything. Scattered single-address failures never trip it.
 */
export class ConsecutiveFailureBreaker {
  private run = 0;
  failures = 0;
  tripped = false;
  constructor(readonly limit = 5) {}
  success() { this.run = 0; }
  /** Records a failure; true once the breaker has tripped. */
  failure() {
    this.failures++;
    this.run++;
    if (this.run >= this.limit) this.tripped = true;
    return this.tripped;
  }
}

/** A short, single-line description of an error (viem's shortMessage when it has one). */
export function shortError(e: unknown): string {
  const m = (e as { shortMessage?: unknown })?.shortMessage ?? (e as { message?: unknown })?.message ?? e;
  return String(m).split('\n')[0].slice(0, 200);
}

/**
 * Runs `fn` over `items` until the breaker trips. Per-item errors are logged
 * (one line each, only the first `maxLogged` of them per walk) and counted;
 * returns how many items were processed. Does nothing if the breaker has
 * already tripped earlier in the pass.
 */
export async function walkWithBreaker<T>(
  items: AsyncIterable<T> | Iterable<T>,
  fn: (item: T) => Promise<void>,
  breaker: ConsecutiveFailureBreaker,
  onItemError: (item: T, e: unknown, logged: boolean) => void,
  maxLogged = 5,
): Promise<number> {
  let processed = 0, logged = 0;
  if (breaker.tripped) return 0;
  for await (const item of items) {
    processed++;
    try { await fn(item); breaker.success(); }
    catch (e) {
      const log = logged < maxLogged;
      if (log) logged++;
      onItemError(item, e, log);
      if (breaker.failure()) break;
    }
  }
  return processed;
}
