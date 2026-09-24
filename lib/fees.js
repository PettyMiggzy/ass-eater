/**
 * Platform fee rates, in basis points. These mirror the already-decided
 * rates documented for server/'s ledger (never deployed) -- this is the
 * first place they're actually enforced on the LIVE site, since credits
 * didn't exist here before now.
 */
export const FEES = {
  DEPOSIT_BPS: 200, // 2% kept when a fan converts real USDG into credits
  DEFAULT_BPS: 1000, // 10% platform cut on everything except marketplace
  MARKETPLACE_BPS: 1500, // 15% on marketplace sales (10% platform + 5% listing fee)
};

// Below this, integer-cents math rounds the credited amount to $0.00 for a
// real, verified, non-refundable on-chain payment -- and once verified the
// tx hash is permanently claimed (used_payment_tx), so there is no way to
// resubmit it for a second, correct-sized credit. $1 is comfortably above
// the rounding dead zone (anything under ~1 cent) and far below any amount a
// real deposit would realistically be, so this only ever rejects dust/test
// transfers, never a genuine top-up.
export const MIN_DEPOSIT_CENTS = 100;

// Every payout is a manual on-chain transfer an admin sends by hand, so a
// queue of one-cent requests is real work for nothing. Same $1 floor as a
// deposit.
export const MIN_PAYOUT_CENTS = 100;
