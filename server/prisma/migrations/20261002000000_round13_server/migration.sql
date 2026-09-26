-- Round 13 server fixes: record which treasury key signed each in-flight
-- treasury transaction, so a key rotation can never make the reconcilers
-- judge an old-key transaction by the new wallet's nonce (and refund a
-- payout, or re-buy a burn, that can still land). Existing rows stay null,
-- which the workers treat as "signer unknown": settled only by a receipt or
-- by an admin, never as provably dropped.

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN "signerAddress" TEXT;

-- AlterTable
ALTER TABLE "TokenBurn" ADD COLUMN "pendingSigner" TEXT;

-- AlterTable
ALTER TABLE "TreasuryHedgeBatch" ADD COLUMN "signerAddress" TEXT;
