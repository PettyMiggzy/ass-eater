/**
 * Config for real marketplace crypto checkout. Same pattern as AgeChecker
 * and SES elsewhere in this codebase: the integration is real and wired end
 * to end, but it reports itself as NOT LIVE until every required value is
 * actually set, rather than silently accepting payments against a guessed
 * or placeholder address. A wrong receiving address here is unrecoverable
 * real money loss -- there is no safe default to fall back to, so the only
 * safe behavior when unset is to refuse, loudly, not quietly proceed.
 *
 * NEXT_PUBLIC_* values are readable client-side (needed to build the
 * transaction in the browser via the buyer's own wallet). The RPC url used
 * for SERVER-SIDE verification is separate (MARKETPLACE_RPC_URL) so the
 * verification path isn't dependent on whatever RPC the client happened to
 * use to submit -- a public client-side RPC can lie or lag; the server
 * checks the payment against its own node.
 */

export function getMarketplacePaymentConfig() {
  return {
    payoutAddress: process.env.NEXT_PUBLIC_MARKETPLACE_PAYOUT_ADDRESS || '',
    usdcAddress: process.env.NEXT_PUBLIC_MARKETPLACE_USDC_ADDRESS || '',
    // Display name of whatever stablecoin usdcAddress actually points at --
    // "USDC" is the variable/env-var name for historical reasons (it was
    // written before Robinhood Chain was chosen, which has no USDC contract
    // at all -- only USDG), but the UI must say the REAL asset name or a
    // fan pays real money expecting a token they never actually get.
    stableSymbol: process.env.NEXT_PUBLIC_MARKETPLACE_STABLE_SYMBOL || 'USDC',
    chainId: process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_ID || '',
    chainName: process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_NAME || '',
    nativeSymbol: process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_NATIVE_SYMBOL || 'ETH',
    // Used only by the buyer's own wallet to add/verify the network -- not a
    // trust boundary, the server verifies against its own RPC below.
    publicRpcUrl: process.env.NEXT_PUBLIC_MARKETPLACE_RPC_URL || '',
  };
}

/** True only when every value a real transfer needs to be built is present. */
export function marketplacePaymentsLive(config = getMarketplacePaymentConfig()) {
  return !!(config.payoutAddress && config.usdcAddress && config.chainId);
}

/** Server-side verification config -- kept separate from the client config above on purpose (see file comment). */
export function getMarketplaceVerificationConfig() {
  return {
    rpcUrl: process.env.MARKETPLACE_RPC_URL || '',
    ...getMarketplacePaymentConfig(),
  };
}

export function marketplaceVerificationLive(config = getMarketplaceVerificationConfig()) {
  return marketplacePaymentsLive(config) && !!config.rpcUrl;
}
