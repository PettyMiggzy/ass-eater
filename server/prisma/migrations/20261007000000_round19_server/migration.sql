-- Round 19 server fixes: a settled price-pending deposit records that its
-- address's sweep still has to be re-queued, in the same transaction as the
-- settle, and keeps the flag until the enqueue succeeds
-- (workers/reprice-scan.ts, workers/deposit-indexer.ts repricePending).

-- AlterTable
ALTER TABLE "Deposit" ADD COLUMN "sweepRequeue" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Deposit_sweepRequeue_idx" ON "Deposit"("sweepRequeue");
