-- Round 21 server fixes.
-- User.kycStatusAt: time of the KYC decision kycStatus reflects, so the Sumsub
-- webhook can ignore delayed/retried events older than the current decision
-- (or than an admin override).
ALTER TABLE "User" ADD COLUMN "kycStatusAt" TIMESTAMP(3);

-- AdminAdjustRequest.earnings: the adjustment moved withdrawable (earned)
-- credits; part of the replay comparison.
ALTER TABLE "AdminAdjustRequest" ADD COLUMN "earnings" BOOLEAN NOT NULL DEFAULT false;
