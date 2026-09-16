-- AlterTable
ALTER TABLE "Deposit" ADD COLUMN     "hedgedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TreasuryHedgeBatch" (
    "id" TEXT NOT NULL,
    "depositCount" INTEGER NOT NULL,
    "onlyAssRawIn" TEXT NOT NULL,
    "usdcRawOut" TEXT NOT NULL,
    "priceImpactBps" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasuryHedgeBatch_pkey" PRIMARY KEY ("id")
);
