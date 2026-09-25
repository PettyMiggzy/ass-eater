/**
 * The Terms of Service version, in ONE place (pure -- safe to import from
 * pages/terms.js as well as the server).
 *
 * Every order (lib/orders-store.js) and every signup acceptance
 * (pages/api/auth/signup.js) records CURRENT_TOS_VERSION, so a dispute can be
 * answered with the text that buyer actually agreed to. Bump BOTH constants
 * together whenever the Terms change materially -- Section 6 (Marketplace
 * Purchases) above all, since that is what a buyer accepts per order -- and
 * keep a copy of the outgoing text (git history of pages/terms.js at the
 * commit that bumped this is the archive).
 *
 *   'v1'         -- original marketplace terms (paid to the creator at sale).
 *   '2026-09-24' -- credits checkout: the creator's share is credited to their
 *                   platform balance at sale, shipping-address disclosure.
 *   '2026-09-25' -- the fees apply to shipping as well as price, and the
 *                   creator's share of a physical order includes the shipping
 *                   charge (Sections 5 and 6).
 */
export const CURRENT_TOS_VERSION = '2026-09-25';
export const TOS_LAST_UPDATED = 'September 25, 2026';
