-- Round 11 server fixes: record WHY a moderator took a listing down, so a
-- ban (which judges the seller, not the item) can be reversed without
-- leaving past buyers locked out of what they paid for.

-- CreateEnum
CREATE TYPE "ListingModerationReason" AS ENUM ('BAN', 'REPORT');

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN "moderatedReason" "ListingModerationReason";

-- Backfill. A moderated listing with an ACTIONED report on it was a report
-- takedown. Every other moderated listing was stamped by a ban -- including
-- the round-10 backfill's REMOVED listings of a then-BANNED seller, some of
-- which the seller had unlisted themselves; as BAN they are visible again to
-- past buyers once the seller is reactivated and restorable by an admin,
-- never relistable by the creator alone.
UPDATE "Listing" l SET "moderatedReason" = 'REPORT'
WHERE l."moderatedAt" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "Report" r WHERE r."targetType" = 'listing' AND r."targetId" = l.id AND r.status = 'ACTIONED');

UPDATE "Listing" SET "moderatedReason" = 'BAN'
WHERE "moderatedAt" IS NOT NULL AND "moderatedReason" IS NULL;
