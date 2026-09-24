-- Bridged accounts are keyed on the Next.js site's user id, never on email.
-- Nullable: native and system rows have no site identity.
ALTER TABLE "User" ADD COLUMN "siteUid" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_siteUid_key" ON "User"("siteUid");

-- The platform ledger account is a bookkeeping row, not a person. It was
-- seeded as role ADMIN, status ACTIVE with a joinable email; make it a
-- non-login, non-admin row. (seed-system-accounts.ts now enforces the same
-- values on every deploy; this covers a droplet whose seed already ran.)
UPDATE "User"
   SET "email" = 'platform@system.invalid', "role" = 'FAN', "status" = 'SUSPENDED'
 WHERE "id" = '00000000-0000-0000-0000-000000000000';
