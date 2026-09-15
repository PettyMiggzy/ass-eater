-- AlterEnum
ALTER TYPE "TxType" ADD VALUE 'TOKEN_LOCK';

-- AlterTable
ALTER TABLE "CreatorProfile" ADD COLUMN     "stakePerkDescription" TEXT,
ADD COLUMN     "stakePerkEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stakeUsdCents" INTEGER,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "instant" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TokenLock" (
    "id" TEXT NOT NULL,
    "fanId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "usdCents" INTEGER NOT NULL,
    "tokenAmountAtLock" TEXT NOT NULL,
    "status" "SubStatus" NOT NULL DEFAULT 'ACTIVE',
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TokenLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TokenLock_status_currentPeriodEnd_idx" ON "TokenLock"("status", "currentPeriodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "TokenLock_fanId_creatorId_key" ON "TokenLock"("fanId", "creatorId");

-- AddForeignKey
ALTER TABLE "TokenLock" ADD CONSTRAINT "TokenLock_fanId_fkey" FOREIGN KEY ("fanId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TokenLock" ADD CONSTRAINT "TokenLock_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
