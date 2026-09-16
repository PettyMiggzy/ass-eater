-- CreateEnum
CREATE TYPE "SaleType" AS ENUM ('FIXED', 'AUCTION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TxType" ADD VALUE 'AUCTION_BID_HOLD';
ALTER TYPE "TxType" ADD VALUE 'AUCTION_BID_RELEASE';

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "auctionEndsAt" TIMESTAMP(3),
ADD COLUMN     "currentBidCents" INTEGER,
ADD COLUMN     "currentBidderId" TEXT,
ADD COLUMN     "minBidIncrementCents" INTEGER,
ADD COLUMN     "reserveCents" INTEGER,
ADD COLUMN     "saleType" "SaleType" NOT NULL DEFAULT 'FIXED';

-- CreateTable
CREATE TABLE "Bid" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "bidderId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bid_listingId_amountCents_idx" ON "Bid"("listingId", "amountCents");

-- CreateIndex
CREATE INDEX "Listing_saleType_status_auctionEndsAt_idx" ON "Listing"("saleType", "status", "auctionEndsAt");

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_bidderId_fkey" FOREIGN KEY ("bidderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
