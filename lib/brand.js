/**
 * The token, and what money actually moves in. One place, because these two
 * are easy to mix up in copy and expensive to mix up in law.
 *
 * THE RULE, decided 2026-09-18: **$ONLYONE is never a payment method.**
 *
 * Fans pay in dollars and spend credits. The token buys nothing, prices
 * nothing, and settles nothing. Its job is status and access -- hold it to
 * unlock token-gated creators (proved by a wallet signature; nothing is
 * spent or moved) -- which keeps it out of the
 * "this token is the medium of exchange for adult content" position that
 * the founder wants to stay out of.
 *
 * So: if you ever find yourself writing "pay with ONLYONE", "priced in
 * ONLYONE", or "creator paid out in ONLYONE", that is the line. Don't.
 * Payouts are in dollars too -- paying a creator in the token is still paying
 * someone in the token.
 */

import { FEES } from './fees.js';

export const TOKEN_SYMBOL = '$ONLYONE';

/**
 * What the ledger settles in, and what people actually hold.
 *
 * Robinhood Chain -- where $ONLYONE launches, and therefore where the money
 * lives too, so nobody has to run two networks -- has no USDC contract at
 * all. Its stablecoin is USDG (Global Dollar, issued by Paxos, redeemable
 * 1:1 for dollars).
 *
 * This is less of a change than it sounds, because the bridge converts at
 * both ends: USDC bridged in arrives as USDG in one transaction with no
 * swap step, and USDG bridged out comes back as USDC on Base, Ethereum and
 * eleven other chains. So "USDC" stays the right word for what someone
 * brings and what they leave with, and USDG is what the balance is.
 *
 * Say both, in that order, wherever it matters. Writing only "USDC" makes
 * someone look for a USDC balance that does not exist; writing only "USDG"
 * makes them think they need to go find an asset they have never heard of.
 */
export const SETTLE_ASSET = 'USDG';
export const BRIDGE_ASSET = 'USDC';

/**
 * Credits are the in-platform unit fans buy with a dollar stablecoin. On the
 * live site today they are spent on marketplace purchases and paid messages
 * to creators -- subscriptions and tips exist only in server/, which is not
 * connected to the site, so copy must not offer them as something credits
 * buy. 1 credit = $1, deliberately, so nobody has to do arithmetic to know
 * what they are spending. Buying them costs a 2% fee (FEES.DEPOSIT_BPS in
 * lib/fees.js), so $100 buys 98 -- disclosed on /get-crypto and in Terms
 * section 5, because an undisclosed fee on the way in is how disputes start.
 *
 * Credits are closed-loop: a fan's purchased credits are never refunded or
 * cashed out. Only credits a creator EARNED from someone else's spend can be
 * requested as a USDG payout.
 */
export const CREDIT_PER_DOLLAR = 1;

/**
 * Fee percentages for COPY, derived from lib/fees.js (the numbers the code
 * actually charges) so a page can never quote a rate the ledger doesn't
 * use. Every public page and legal document that states a fee should
 * interpolate these rather than typing "10%" -- the flat "we take 10%,
 * nothing else" copy that shipped while every live sale was charged 15% is
 * exactly the drift this prevents. lib/brand.test.mjs pins them.
 */
const pct = (bps) => bps / 100;
export const PLATFORM_FEE_PCT = pct(FEES.DEFAULT_BPS);
export const MARKETPLACE_FEE_PCT = pct(FEES.MARKETPLACE_BPS);
export const LISTING_FEE_PCT = MARKETPLACE_FEE_PCT - PLATFORM_FEE_PCT;
export const CREDIT_PURCHASE_FEE_PCT = pct(FEES.DEPOSIT_BPS);

/**
 * The floor price of a fan -> creator message, in cents (decided 2026-09-24:
 * "sending creators messages can't be free"). A creator may set a higher
 * price; the fan pays max(floor, creator's price). Stated in Terms section 5.
 * The send path must charge exactly this floor -- if the enforced number
 * ever lives somewhere else, import it from here or keep them identical.
 */
export const DM_PRICE_FLOOR_CENTS = 99;

/**
 * VIP, decided 2026-09-18 and superseding the earlier burn-for-permanent-VIP
 * design entirely. $20/month in credits, and its revenue is what buys
 * $ONLYONE on the open market and burns it.
 *
 * THE RULE THAT MATTERS IN COPY: **VIP is perks only.** It includes no
 * creator's content and it discounts nothing -- the platform takes a flat
 * 10% and nothing reduces it (decided 2026-09-18: no fan-facing discounts
 * at all, superseding "VIP is the only fan-facing discount"). Every perk is
 * access and status: things that cost the platform nothing and take nothing
 * out of a creator's earnings.
 *
 * Source of truth is PlatformConfig.vipPriceCents in server/, which is not
 * connected to the live site -- VIP cannot be bought here yet, so copy must
 * describe it as coming, not available. This mirror exists so the live
 * site's copy has one number to quote instead of a literal typed into each
 * page.
 */
export const VIP_PRICE_USD = 20;
export const VIP_PERKS = [
  'Early access to new posts, before anyone else sees them',
  'First look at one-of-a-kind marketplace drops',
  'Your messages sort to the top of a creator\'s inbox',
  'VIP badge wherever you appear',
];

/**
 * How a credit balance is DISPLAYED, decided 2026-09-19, wherever one is
 * shown, written down once so it isn't re-litigated per screen.
 *
 * Show BOTH forms, always: "50 credits ($50.00)". Neither form alone is
 * right on its own:
 *
 *  - Showing only the raw settlement asset ("50.00 USDG") reads as the
 *    platform handling the fan's actual money -- and once the 2% buy fee and
 *    the no-refund rule are visible against a NAMED stablecoin, that reads
 *    as skimming a real currency. The same mechanics under "credits" read as
 *    an ordinary purchase (arcade tokens, Twitch bits, Reddit coins) because
 *    everyone already understands a credit is one-way.
 *  - Showing only "50 credits" with no dollar figure makes a fan do
 *    arithmetic to know what they're spending, which is the exact thing
 *    CREDIT_PER_DOLLAR = 1 exists to avoid.
 *
 * Showing both keeps the one-way "credits" framing (which is load-bearing --
 * see the closed-loop / non-cashable design in MEMORY.md) while giving a fan
 * the dollar clarity they'd get from seeing the raw asset.
 */
export function formatCredits(cents) {
  const dollars = cents / 100;
  const credits = dollars * CREDIT_PER_DOLLAR;
  const creditLabel = Number.isInteger(credits) ? credits.toLocaleString() : credits.toFixed(2);
  const dollarLabel = dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${creditLabel} credit${credits === 1 ? '' : 's'} ($${dollarLabel})`;
}
