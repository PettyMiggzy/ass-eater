-- CreateEnum
CREATE TYPE "PayAsset" AS ENUM ('USD', 'ONLYASS');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "onlyAssCents" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "payAsset" "PayAsset" NOT NULL DEFAULT 'USD';
