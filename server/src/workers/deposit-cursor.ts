/**
 * Where the deposit indexer's cursor starts the FIRST time it runs on a
 * chain. Pure and side-effect free (like indexer-chunks.ts) so it is
 * testable without starting the indexer loop.
 *
 * It used to start at the chain head unconditionally. The API hands out
 * deposit addresses whenever DEPOSIT_XPUB is set, with no regard for whether
 * the indexer has ever run -- and it may not have: waitForTokenCheck()
 * retrying against a placeholder RPC_URL, or a TokenDecimalsMismatchError
 * disabling it. When it finally ran, every deposit sent to an address issued
 * before that block was skipped for good (and a returning depositor's was
 * later swept into the treasury by reconcileSweeps with no ledger entry).
 *
 * So a head start is taken only while no address exists. Otherwise the scan
 * starts no later than the earliest issuance block recorded on an address
 * (DepositAddress.issuedBlock) and no later than DEPOSIT_START_BLOCK when set;
 * if some address has no recorded block and no DEPOSIT_START_BLOCK is set,
 * there is no safe start and the answer is null -- the caller must refuse to
 * create the cursor (and say so loudly) rather than guess.
 *
 * Returns the cursor's `lastBlock`: one before the first block to scan.
 */
export function initialCursorBlock(p: {
  safe: bigint;
  addressCount: number;
  minIssuedBlock: bigint | null;
  unstampedAddresses: number;
  envStartBlock: bigint | null;
}): bigint | null {
  if (p.addressCount === 0) return p.safe - 1n;
  const candidates: bigint[] = [];
  if (p.envStartBlock != null) candidates.push(p.envStartBlock);
  if (p.minIssuedBlock != null) candidates.push(p.minIssuedBlock);
  if (p.unstampedAddresses > 0 && p.envStartBlock == null) return null;
  if (!candidates.length) return null;
  let start = candidates.reduce((a, b) => (b < a ? b : a));
  if (start < 0n) start = 0n;
  if (start > p.safe + 1n) start = p.safe + 1n;
  return start - 1n;
}

/** DEPOSIT_START_BLOCK as a bigint, or null when unset. Throws on garbage rather than guessing. */
export function parseStartBlock(raw: string | undefined): bigint | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (!/^\d+$/.test(v)) throw new Error(`DEPOSIT_START_BLOCK must be a block number, got "${v}"`);
  return BigInt(v);
}
