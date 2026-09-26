-- Round 10 server fixes: a moderator's listing takedown recorded apart from a
-- creator's own unlist, and cash-out idempotency.

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN "moderatedAt" TIMESTAMP(3);

-- Listings already taken down by a moderator before the column existed: a
-- REMOVED listing with an ACTIONED report on it, or a REMOVED listing whose
-- seller is BANNED (the ban removes every listing it can).
UPDATE "Listing" l SET "moderatedAt" = CURRENT_TIMESTAMP
WHERE l.status = 'REMOVED' AND (
  EXISTS (SELECT 1 FROM "Report" r WHERE r."targetType" = 'listing' AND r."targetId" = l.id AND r.status = 'ACTIONED')
  OR EXISTS (SELECT 1 FROM "User" u WHERE u.id = l."creatorId" AND u.status = 'BANNED')
);

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN "requestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payout_creatorId_requestId_key" ON "Payout"("creatorId", "requestId");
