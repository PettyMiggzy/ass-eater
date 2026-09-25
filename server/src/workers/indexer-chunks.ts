/**
 * Splits a list into chunks of at most `size` items (size >= 1).
 *
 * Used by the deposit indexer (workers/deposit-indexer.ts) to query Transfer
 * logs for its deposit addresses a few hundred at a time: geth-based nodes
 * (Nitro included) and hosted RPCs cap how many addresses one filter
 * position may OR together (geth: 1000), and past that cap every getLogs
 * call fails -- which used to stop ALL deposit crediting once the platform
 * had issued enough deposit addresses. Kept in its own module, free of
 * side effects, so it is testable without starting the indexer loop.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
