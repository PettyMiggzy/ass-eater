-- AlterEnum
ALTER TYPE "TxType" ADD VALUE 'TOKEN_BURN';

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "vipBurnedTokens" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PlatformConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "vipBurnThresholdTokens" DOUBLE PRECISION NOT NULL DEFAULT 10000000,

    CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id")
);
