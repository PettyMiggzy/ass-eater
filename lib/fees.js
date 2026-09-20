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
