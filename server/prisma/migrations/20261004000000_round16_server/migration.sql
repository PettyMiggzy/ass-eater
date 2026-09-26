-- Round 16 server fixes: Media.bytes widens from INTEGER to BIGINT. The
-- upload limit allows a 4 GiB creator video (core/upload-limits.ts), but an
-- int4 column tops out at 2,147,483,647, so every video between ~2 GiB and
-- 4 GiB passed the size check and then failed its INSERT with a 500. Every
-- existing value fits; widening is lossless.

-- AlterTable
ALTER TABLE "Media" ALTER COLUMN "bytes" SET DATA TYPE BIGINT;

-- A REFERRAL row no longer carries the purchase's refId (core/ledger.ts
-- charge()): it told a fan's referrer which post, stream minute or message
-- their friend paid for. Existing rows keep it only as meta.chargeRefId,
-- which GET /wallet/history never returns.
UPDATE "LedgerEntry"
SET "meta" = COALESCE("meta", '{}'::jsonb) || jsonb_build_object('chargeRefId', "refId"),
    "refId" = NULL
WHERE "type" = 'REFERRAL' AND "refId" IS NOT NULL;
