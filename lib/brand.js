/**
 * The token, and what money actually moves in. One place, because these two
 * are easy to mix up in copy and expensive to mix up in law.
 *
 * THE RULE, decided 2026-09-18: **$ONLYONE is never a payment method.**
 *
 * Fans pay in dollars and spend credits. The token buys nothing, prices
 * nothing, and settles nothing. Its job is status and access -- burn it for
 * VIP, hold it to unlock token-gated creators -- which keeps it out of the
 * "this token is the medium of exchange for adult content" position that
 * the founder wants to stay out of.
 *
 * So: if you ever find yourself writing "pay with ONLYONE", "priced in
 * ONLYONE", or "creator paid out in ONLYONE", that is the line. Don't.
 * Payouts are in dollars too -- paying a creator in the token is still paying
 * someone in the token.
 */

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
 * Credits are the in-platform unit fans buy with a dollar stablecoin and
 * spend on subs, tips and unlocks. 1 credit = $1, deliberately, so nobody
 * has to do arithmetic to know what they are spending. Buying them costs a
 * 2% fee (FEES.DEPOSIT_BPS in server/src/core/ledger.ts), so $100 buys 98 --
 * disclosed on /get-crypto and in Terms section 5, because an undisclosed
 * fee on the way in is how disputes start.
 */
export const CREDIT_PER_DOLLAR = 1;

/**
 * How a credit balance is DISPLAYED, decided 2026-09-19, wherever one is ever
 * shown -- no live UI does this yet (there is no wallet/balance screen on the
 * live site; payments aren't deployed), so this is the rule for when one is
 * built, written down now so it isn't re-litigated per-screen later.
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
