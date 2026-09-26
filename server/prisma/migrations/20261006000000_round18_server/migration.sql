-- Round 18 server fixes: referral cuts are settled once per ended UTC day
-- instead of landing in the referrer's balance on every charge (see the
-- PendingReferral model and core/referrals.ts). Rows written here are held
-- by the platform account until settleReferrals() credits them.

-- CreateTable
CREATE TABLE "PendingReferral" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "chargeRefId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "PendingReferral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingReferral_settledAt_createdAt_idx" ON "PendingReferral"("settledAt", "createdAt");

-- CreateIndex
CREATE INDEX "PendingReferral_referrerId_settledAt_idx" ON "PendingReferral"("referrerId", "settledAt");
