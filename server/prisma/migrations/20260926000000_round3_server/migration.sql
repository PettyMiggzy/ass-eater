-- Round-3 audit fixes (server/). Additive only; safe on the live droplet DB.

-- Transcode recovery: when a media row entered PROCESSING, and how many
-- times the reconciler (core/transcode-reconcile.ts) re-queued a lost job.
ALTER TABLE "Media" ADD COLUMN "processingSince" TIMESTAMP(3),
ADD COLUMN "transcodeRequeues" INTEGER NOT NULL DEFAULT 0;
-- Rows already PROCESSING get their upload time, so the reconciler picks
-- up anything that has been stuck since before this existed.
UPDATE "Media" SET "processingSince" = "createdAt" WHERE "status" = 'PROCESSING' AND "processingSince" IS NULL;

-- Payouts: when the worker signed txHash (the auto-refund window runs from
-- here, not from the request), and the worker's own nonce-cancel tx.
ALTER TABLE "Payout" ADD COLUMN "cancelTxHash" TEXT,
ADD COLUMN "signedAt" TIMESTAMP(3);
-- Existing signed payouts: the request time is the earliest they can have
-- been signed, which only ever closes the refund window sooner (safe side).
UPDATE "Payout" SET "signedAt" = "createdAt" WHERE "txHash" IS NOT NULL AND "signedAt" IS NULL;

-- Automatic burn: the in-flight swap, persisted before broadcast.
ALTER TABLE "TokenBurn" ADD COLUMN "pendingNonce" INTEGER,
ADD COLUMN "pendingSince" TIMESTAMP(3),
ADD COLUMN "pendingTxHash" TEXT;
-- Manual burn hashes are compared case-insensitively; store them lowercased.
UPDATE "TokenBurn" SET "txHash" = lower("txHash") WHERE "txHash" IS NOT NULL AND "txHash" <> lower("txHash");

-- Treasury hedge: a batch row exists from signing (PENDING) until settled.
ALTER TABLE "TreasuryHedgeBatch" ADD COLUMN "nonce" INTEGER,
ADD COLUMN "resolvedAt" TIMESTAMP(3),
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DONE';

-- Tip idempotency: one row per (fan, client key).
CREATE TABLE "TipRequest" (
    "fanId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "tipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TipRequest_pkey" PRIMARY KEY ("fanId","key")
);

CREATE INDEX "Media_status_processingSince_idx" ON "Media"("status", "processingSince");
CREATE INDEX "TokenBurn_pendingTxHash_idx" ON "TokenBurn"("pendingTxHash");
CREATE INDEX "TreasuryHedgeBatch_status_idx" ON "TreasuryHedgeBatch"("status");
