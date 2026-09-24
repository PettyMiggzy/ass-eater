-- An ETH / $ONLYONE deposit indexed while no price was available is recorded
-- as pending and credited later by the deposit indexer's reprice loop,
-- instead of being frozen as an uncredited usdCents-0 row.
ALTER TABLE "Deposit" ADD COLUMN "pricePending" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Deposit_pricePending_idx" ON "Deposit"("pricePending");
