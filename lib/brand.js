/**
 * The token, and what money actually moves in. One place, because these two
 * are easy to mix up in copy and expensive to mix up in law.
 *
 * THE RULE, decided 2026-09-18: **$ONLYONE is never a payment method.**
 *
 * Fans pay in USDC and spend credits. The token buys nothing, prices
 * nothing, and settles nothing. Its job is status and access -- burn it for
 * VIP, hold it to unlock token-gated creators -- which keeps it out of the
 * "this token is the medium of exchange for adult content" position that
 * the founder wants to stay out of.
 *
 * So: if you ever find yourself writing "pay with ONLYONE", "priced in
 * ONLYONE", or "creator paid out in ONLYONE", that is the line. Don't.
 * Payouts are USDC too -- paying a creator in the token is still paying
 * someone in the token.
 */

export const TOKEN_SYMBOL = '$ONLYONE';

/** What fans actually pay with, and what creators are actually paid in. */
export const PAY_ASSET = 'USDC';

/**
 * Credits are the in-platform unit fans buy with USDC and spend on subs,
 * tips and unlocks. 1 credit = 1 USDC, deliberately, so nobody has to do
 * arithmetic to know what they are spending.
 */
export const CREDIT_PER_USDC = 1;
