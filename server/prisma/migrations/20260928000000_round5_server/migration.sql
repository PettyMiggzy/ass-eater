-- Round 5 server fixes: DM idempotency row claimed before the message exists,
-- tip idempotency keys remember what they were used for, site suspensions
-- carry their lapse time, deposit addresses record their issuance block.
-- AlterTable
ALTER TABLE "DepositAddress" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "issuedBlock" BIGINT;

-- AlterTable
ALTER TABLE "DmSendRequest" ALTER COLUMN "messageId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "TipRequest" ADD COLUMN     "amountCents" INTEGER,
ADD COLUMN     "creatorId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "siteAccountSuspendedUntil" TIMESTAMP(3),
ADD COLUMN     "siteSuspendedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_siteSuspendedUntil_idx" ON "User"("siteSuspendedUntil");

-- CreateIndex
CREATE INDEX "User_siteAccountSuspendedUntil_idx" ON "User"("siteAccountSuspendedUntil");

