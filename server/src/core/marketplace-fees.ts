// Shared between modules/marketplace.ts (fixed-price buys) and
// core/auctions.ts (auction close) so both charge identically -- an auction
// sale is still a marketplace sale, just priced by bidding instead of a
// sticker price.
export const PLATFORM_FEE_BPS = 1000; // 10% commission on the sale
export const LISTING_FEE_BPS = 500; // 5% listing fee, also cut at sale time
export const MARKETPLACE_TOS_VERSION = 'v1'; // pages/terms.js, Section 6 (Marketplace Purchases) -- bump if that section's text materially changes

// PHYSICAL items are switched off on server/ until a shipping address can be
// collected and kept (encrypted, seller-only, purged after shipping). There
// is no address field anywhere in ListingOrder, so a physical sale paid the
// creator at once for an item they had nowhere to send -- and with no
// refunds, the fan was simply out the money. Checked at every entry point:
// listing create/patch, fixed-price buy and bid. The hold/settlement maths in
// core/auctions.ts still handles shipping correctly for the day this flips.
export const PHYSICAL_SALES_ENABLED = false;
