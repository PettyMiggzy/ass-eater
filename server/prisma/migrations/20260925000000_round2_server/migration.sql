-- Round-2 audit fixes (server/). Additive only; safe on the live droplet DB.

-- Payouts an admin must act on: HELD (creator frozen/suspended/banned when
-- the payout came up -- never signed) and REFUNDED (reversed back to the
-- creator). Previously a refund and a doubtful send were both just FAILED.
ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'HELD';
ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';

-- The site creator's standing as last seen over the bridge, and whether the
-- current status was set by the site (only a site-set suspension is lifted
-- by the site reporting the creator active again).
ALTER TABLE "User" ADD COLUMN "siteCreatorStatus" TEXT;
ALTER TABLE "User" ADD COLUMN "statusBySite" BOOLEAN NOT NULL DEFAULT false;
-- Bridged CREATOR rows provisioned before this migration were upgraded on any
-- site status; they are treated as unapproved until their next exchange (or
-- a site status push) says 'active'.

-- Closed-loop credits: only credits EARNED from someone else's spend may be
-- paid out. Backfill: what each account has earned (creator-side postings of
-- fan charges, marketplace/auction sales, referrals) net of payouts and
-- payout reversals, clamped to [0, balance].
ALTER TABLE "Account" ADD COLUMN "withdrawableCents" BIGINT NOT NULL DEFAULT 0;
UPDATE "Account" a SET "withdrawableCents" = LEAST(a."balanceCents", GREATEST(0, COALESCE((
  SELECT SUM(e."amountCents") FROM "LedgerEntry" e
  WHERE e."userId" = a."userId" AND (
    (e."amountCents" > 0 AND e."type" IN ('SUBSCRIPTION','PPV','TIP','MESSAGE_UNLOCK','LIVE_TICKET','LIVE_MINUTE','LIVE_TIP','DM_SEND','TOKEN_LOCK','MARKETPLACE_SALE','REFERRAL'))
    OR e."type" IN ('PAYOUT','PAYOUT_REVERSAL')
  )
), 0)))
WHERE a."userId" NOT IN ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000b0');

-- Payouts are USDG only.
UPDATE "CreatorProfile" SET "payoutAsset" = 'STABLE' WHERE "payoutAsset" <> 'STABLE';

-- An auction bid now carries the bidder's own 18+ / ToS confirmation, which
-- the winning order copies instead of inventing one at close time.
ALTER TABLE "Bid" ADD COLUMN "ageConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Bid" ADD COLUMN "tosVersion" TEXT;
ALTER TABLE "ListingOrder" ALTER COLUMN "ageConfirmedAt" DROP NOT NULL;
ALTER TABLE "ListingOrder" ALTER COLUMN "tosVersion" DROP NOT NULL;

-- Treasury hedge progress per deposit (raw token units already sold).
ALTER TABLE "Deposit" ADD COLUMN "hedgedRaw" TEXT NOT NULL DEFAULT '0';

-- The nonce of a payout's signed transaction, so an interrupted payout can
-- be proven never-sent (or found) by the reconciler.
ALTER TABLE "Payout" ADD COLUMN "nonce" INTEGER;

-- An auction hold remembers how much of it came out of withdrawable (earned)
-- credits, so releasing it (outbid, cancelled, reserve not met) restores
-- exactly that much as withdrawable.
ALTER TABLE "Listing" ADD COLUMN "currentHoldWithdrawableCents" INTEGER;
ALTER TABLE "Bid" ADD COLUMN "heldWithdrawableCents" INTEGER;

-- One chain transaction settles at most one payout. Wrapped so a droplet
-- that somehow already holds a duplicate still migrates (the admin
-- mark_sent route also checks for reuse inside its transaction).
DO $$ BEGIN
  CREATE UNIQUE INDEX "Payout_txHash_lower_key" ON "Payout" (lower("txHash")) WHERE "txHash" IS NOT NULL;
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'Payout_txHash_lower_key not created: duplicate payout txHash rows exist';
END $$;
