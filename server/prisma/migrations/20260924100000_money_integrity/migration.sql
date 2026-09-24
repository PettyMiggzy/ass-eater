-- Auction holds: what is actually held from the leading bidder (bid + shipping).
ALTER TABLE "Listing" ADD COLUMN "currentHoldCents" INTEGER;
ALTER TABLE "Bid" ADD COLUMN "heldCents" INTEGER;

-- Mass-DM media copies point at their source object instead of reusing its
-- unique key (every media broadcast used to fail on Media_key_key).
ALTER TABLE "Media" ADD COLUMN "sourceMediaId" TEXT;
CREATE INDEX "Media_sourceMediaId_idx" ON "Media"("sourceMediaId");

-- Resumable broadcasts: one message per (conversation, broadcast).
ALTER TABLE "Message" ADD COLUMN "broadcastId" TEXT;
CREATE UNIQUE INDEX "Message_conversationId_broadcastId_key" ON "Message"("conversationId", "broadcastId");

-- Per-minute live billing: paid-through time enforced by the live sweep.
ALTER TABLE "LiveMinute" ADD COLUMN "paidThrough" TIMESTAMP(3);
