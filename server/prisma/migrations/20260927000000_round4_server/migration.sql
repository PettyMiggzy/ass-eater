-- Round-4 audit fixes (server/). Additive except for notifyEmail, whose
-- existing (never confirmed) values move to notifyEmailPending.

-- Site standing ordering (lib/bridge.ts claimStanding).
ALTER TABLE "User" ADD COLUMN "siteStatusAt" TIMESTAMP(3);
-- A FAN-role (account) standing is stored and ordered separately from the
-- creator standing, so 'active' in one never lifts the other's suspension.
ALTER TABLE "User" ADD COLUMN "siteAccountStatus" TEXT,
ADD COLUMN "siteAccountStatusAt" TIMESTAMP(3);

-- Notification email: only a confirmed address is ever mailed.
ALTER TABLE "CreatorProfile" ADD COLUMN "notifyEmailVerifiedAt" TIMESTAMP(3),
ADD COLUMN "notifyEmailPending" TEXT,
ADD COLUMN "notifyEmailTokenHash" TEXT,
ADD COLUMN "notifyEmailTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN "notifyConfirmSentAt" TIMESTAMP(3),
ADD COLUMN "notifyMailedAt" TIMESTAMP(3);
-- Every existing override was typed, never confirmed: keep it as a pending
-- request (the creator re-submits it to get a confirmation link) and stop
-- mailing it.
UPDATE "CreatorProfile" SET "notifyEmailPending" = "notifyEmail", "notifyEmail" = NULL WHERE "notifyEmail" IS NOT NULL;
CREATE UNIQUE INDEX "CreatorProfile_notifyEmailTokenHash_key" ON "CreatorProfile"("notifyEmailTokenHash");

-- Paid-DM idempotency: one row per (sender, client key).
CREATE TABLE "DmSendRequest" (
    "senderId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmSendRequest_pkey" PRIMARY KEY ("senderId","key")
);

-- At most one OPEN report per (reporter, target) (core/reports.ts fileReport
-- re-reads on a collision). Partial, so a resolved report never blocks a new
-- one. Existing duplicates are left alone rather than failing the migration.
DO $$ BEGIN
  CREATE UNIQUE INDEX "Report_open_reporter_target_key" ON "Report" ("reporterId", "targetType", "targetId") WHERE "status" = 'OPEN';
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'Report_open_reporter_target_key not created: duplicate OPEN reports exist';
END $$;
