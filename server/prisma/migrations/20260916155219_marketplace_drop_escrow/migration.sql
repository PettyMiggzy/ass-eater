/*
  Warnings:

  - You are about to drop the column `autoReleaseAt` on the `ListingOrder` table. All the data in the column will be lost.
  - You are about to drop the column `disputedAt` on the `ListingOrder` table. All the data in the column will be lost.
  - You are about to drop the column `fulfillmentStatus` on the `ListingOrder` table. All the data in the column will be lost.
  - You are about to drop the column `netCentsHeld` on the `ListingOrder` table. All the data in the column will be lost.
  - You are about to drop the column `releasedAt` on the `ListingOrder` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "ShipStatus" AS ENUM ('DIGITAL', 'AWAITING_SHIPMENT', 'SHIPPED');

-- DropIndex
DROP INDEX "ListingOrder_fulfillmentStatus_autoReleaseAt_idx";

-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "signatureRequired" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ListingOrder" DROP COLUMN "autoReleaseAt",
DROP COLUMN "disputedAt",
DROP COLUMN "fulfillmentStatus",
DROP COLUMN "netCentsHeld",
DROP COLUMN "releasedAt",
ADD COLUMN     "shipStatus" "ShipStatus" NOT NULL DEFAULT 'DIGITAL';

-- DropEnum
DROP TYPE "FulfillmentStatus";

-- CreateIndex
CREATE INDEX "ListingOrder_shipStatus_idx" ON "ListingOrder"("shipStatus");
