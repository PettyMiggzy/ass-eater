-- Round 14 server fixes: a bid whose run ended without it winning (a
-- no-sale close, a cancel, a banned leader's dropped lead, a relist) is
-- voided, and the public bid history shows only live bids.

-- AlterTable
ALTER TABLE "Bid" ADD COLUMN "voidedAt" TIMESTAMP(3);

-- Backfill. Bids on an auction that is not live and not sold belong to a
-- run that ended without a sale. On a live auction with no standing lead,
-- no bid is live (a relist, or a dropped lead). On a live auction with a
-- lead, a bid above the current one can only be from an earlier run.
UPDATE "Bid" b SET "voidedAt" = CURRENT_TIMESTAMP
FROM "Listing" l
WHERE b."listingId" = l.id
  AND l."saleType" = 'AUCTION'
  AND (
    l.status = 'REMOVED'
    OR (l.status = 'ACTIVE' AND (l."currentBidderId" IS NULL OR b."amountCents" > l."currentBidCents"))
  );

-- Strip the other bidder's user id from existing outbid release rows: fans
-- read their own ledger meta back through GET /wallet/history.
UPDATE "LedgerEntry"
SET meta = (meta - 'outbidBy') || '{"reason":"outbid"}'::jsonb
WHERE type = 'AUCTION_BID_RELEASE' AND meta ? 'outbidBy';
