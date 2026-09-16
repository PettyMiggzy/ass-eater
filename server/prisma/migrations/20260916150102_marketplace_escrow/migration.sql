-- CreateEnum
CREATE TYPE "ListingKind" AS ENUM ('DIGITAL', 'PHYSICAL');

-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('DIGITAL', 'AWAITING_SHIPMENT', 'SHIPPED', 'DELIVERED_CONFIRMED', 'DISPUTED', 'AUTO_RELEASED', 'REFUNDED');

-- AlterEnum
ALTER TYPE "TxType" ADD VALUE 'REFUND';

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "kind" "ListingKind" NOT NULL DEFAULT 'DIGITAL',
ADD COLUMN     "shippingCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ListingOrder" ADD COLUMN     "autoReleaseAt" TIMESTAMP(3),
ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "disputedAt" TIMESTAMP(3),
ADD COLUMN     "fulfillmentStatus" "FulfillmentStatus" NOT NULL DEFAULT 'DIGITAL',
ADD COLUMN     "netCentsHeld" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "releasedAt" TIMESTAMP(3),
ADD COLUMN     "shippedAt" TIMESTAMP(3),
ADD COLUMN     "shippingCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trackingNumber" TEXT;

-- CreateIndex
CREATE INDEX "ListingOrder_fulfillmentStatus_autoReleaseAt_idx" ON "ListingOrder"("fulfillmentStatus", "autoReleaseAt");
