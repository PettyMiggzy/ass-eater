import { getUsdPrice, rawToUsdCents } from '../lib/price';
import { DECIMALS } from '../lib/chain';
import { parseUnits } from 'viem';
import { lockBalance, post, InsufficientFunds, isVip, getVipBurnThresholdTokens, BURNED_ID, type Tx } from './ledger';

export { isVip, getVipBurnThresholdTokens };

/**
 * "Burn 10 million tokens for VIP" -- a fan gives up $ONLYASS from their
 * token-funded balance, permanently, for nothing in return but VIP status
 * (FEES.VIP_DISCOUNT_BPS off everything, see ledger.ts's charge()). This is
 * a ledger-side burn: the amount is debited from the fan's onlyAssCents
 * balance and posted to BURNED_ID, a pseudo-account nothing is ever paid out
 * of -- from the ledger's perspective that value is gone, the same as if the
 * underlying tokens were sent to a dead address on-chain. It does not itself
 * execute an on-chain burn transaction; if the platform wants the actual
 * $ONLYASS supply to shrink to match (for a genuinely verifiable, on-chain
 * deflationary effect rather than just an internal accounting one), that's a
 * separate, not-yet-built step -- e.g. the treasury periodically burning a
 * batch of tokens on-chain equal to what's accumulated in BURNED_ID.
 *
 * @param tokens Whole (or fractional) $ONLYASS tokens the fan wants to burn.
 * Converted to USD-cents via the live price purely to know how much to debit
 * from their balance -- the token count itself, not a re-derived one, is
 * what accumulates toward the VIP threshold.
 */
export async function burnTokens(tx: Tx, userId: string, tokens: number) {
  if (!(tokens > 0)) throw new Error('invalid_amount');

  const px = await getUsdPrice('ONLYASS');
  const raw = parseUnits(tokens.toFixed(DECIMALS.ONLYASS), DECIMALS.ONLYASS);
  const usdCents = rawToUsdCents(raw, DECIMALS.ONLYASS, px);
  if (usdCents <= 0n) throw new Error('invalid_amount');

  const bal = await lockBalance(tx, userId, 'ONLYASS');
  if (bal < usdCents) throw new InsufficientFunds();

  await post(tx, userId, -usdCents, 'TOKEN_BURN', undefined, { tokens, priceUsed: px }, 'ONLYASS');
  await post(tx, BURNED_ID, usdCents, 'TOKEN_BURN', undefined, { fanId: userId, tokens, priceUsed: px }, 'ONLYASS');
  const account = await tx.account.update({
    where: { userId },
    data: { vipBurnedTokens: { increment: tokens } },
    select: { vipBurnedTokens: true },
  });

  // isVip() stamps vipSince the first time the bar is met, so this burn is
  // what makes it permanent -- deliberately not re-derived from the numbers
  // below, which would drift from the real answer the moment the bar moves.
  const threshold = await getVipBurnThresholdTokens(tx);
  const vip = await isVip(tx, userId);
  return { burnedTokens: account.vipBurnedTokens, thresholdTokens: threshold, isVip: vip, usdCentsSpent: Number(usdCents) };
}

export async function getVipStatus(tx: Tx, userId: string) {
  // isVip() FIRST, and not inside the Promise.all: it stamps vipSince the
  // first time the bar is met, so reading the account alongside it races the
  // write and reports vipSince: null for the very call that granted it.
  const vip = await isVip(tx, userId);
  const [account, threshold] = await Promise.all([
    tx.account.findUnique({ where: { userId }, select: { vipBurnedTokens: true, vipSince: true } }),
    getVipBurnThresholdTokens(tx),
  ]);
  return {
    burnedTokens: account?.vipBurnedTokens ?? 0,
    thresholdTokens: threshold,
    isVip: vip,
    // Null until they qualify. Shown so a member can see VIP is dated and
    // permanent rather than something that might lapse.
    vipSince: account?.vipSince ?? null,
  };
}
