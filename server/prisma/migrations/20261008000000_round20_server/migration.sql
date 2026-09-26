-- Round 20 server fixes: admin manual credit/debit (POST /admin/users/:id/adjust)
-- takes a client requestId; the row is inserted in the same transaction as the
-- ADJUSTMENT postings so a retried request never posts the money twice.

-- CreateTable
CREATE TABLE "AdminAdjustRequest" (
    "key" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAdjustRequest_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "AdminAdjustRequest_targetId_createdAt_idx" ON "AdminAdjustRequest"("targetId", "createdAt");
