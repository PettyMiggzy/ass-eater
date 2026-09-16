import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test hits one shared Postgres DB, including shared pseudo-accounts
    // (PLATFORM_ID, ESCROW_ID) with no per-test transactional rollback --
    // running test files in parallel races on those accounts' balances across
    // files (surfaced when escrow.test.ts and ledger.test.ts both touch
    // PLATFORM_ID concurrently). Serialize file execution instead.
    fileParallelism: false,
  },
});
