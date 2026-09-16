// Shared between modules/marketplace.ts (fixed-price buys) and
// core/auctions.ts (auction close) so both charge identically -- an auction
// sale is still a marketplace sale, just priced by bidding instead of a
// sticker price.
export const PLATFORM_FEE_BPS = 1000; // 10% commission on the sale
export const LISTING_FEE_BPS = 500; // 5% listing fee, also cut at sale time
export const MARKETPLACE_TOS_VERSION = 'v1'; // pages/terms.js, Section 6 (Marketplace Purchases) -- bump if that section's text materially changes
