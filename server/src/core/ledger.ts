import { Prisma, PrismaClient, TxType } from '@prisma/client';

export const PLATFORM_ID = '00000000-0000-0000-0000-000000000000';
// Pseudo-account tokens burned via core/vip.ts's burnTokens() are posted to --
// same shape as PLATFORM_ID, except nothing is ever paid out of this one. Its
// balance is purely a running "how much value has been burned" ledger record.
export const BURNED_ID = '00000000-0000-0000-0000-0000000000b0';

export const FEES = {
  DEFAULT_BPS: 1000, // 10% — standard platform cut
  REFERRAL_BPS: 500, // 5% of gross to referrer, paid out of the platform's cut
  REFERRAL_MONTHS: 12,
  WITHDRAWAL_FLAT_CENTS: 100, // $1 per payout
  WITHDRAWAL_BPS: 100, // +1%
  INSTANT_PAYOUT_BPS: 200, // +2% on top, for skipping the payout queue -- waived if the creator opted into the token-lock perk
  VIP_DISCOUNT_BPS: 500, // 5% off any charge for a paid-up VIP member (see core/vip.ts) -- the only fan-facing discount, and it comes out of the PLATFORM's cut, never the creator's
  MIN_PAYOUT_CENTS: 2000,
  MIN_TIP_CENTS: 100,
};

/**
 * The two balances an account carries, and they are not interchangeable.
 *
 * CREDITS is money: fans buy credits with USDC at 1 credit = $1 (booked here
 * in cents), spend them on subscriptions, tips, unlocks and the marketplace,
 * and creators are paid out of it in USDC. Everything charge() touches is
 * this one.
 *
 * ONLYASS is a HOLDING, not a payment source. Tokens a fan has deposited sit
 * here and the only thing that can be done with them is burn them for VIP
 * (core/vip.ts). Decided 2026-09-18: the token is deliberately never a way to
 * pay for anything -- it is far too volatile to denominate what someone is
 * owed, and a platform that both prices content in its own token and converts
 * it back to dollars is a redemption desk for its own token. If you are about
 * to let this reach charge(), that is the line.
 */
export type Balance = 'CREDITS' | 'ONLYASS';

export class InsufficientFunds extends Error {
  constructor() {
    super('insufficient_funds');
  }
}

export type Tx = Prisma.TransactionClient;

/**
 * VIP membership is live while vipUntil is in the future.
 *
 * Lives here rather than in core/vip.ts because charge() needs it and
 * core/vip.ts needs charge()'s primitives -- putting it there makes the two
 * modules import each other. It only touches Account, so it belongs on this
 * side of that line.
 */
export async function isVip(tx: Tx, userId: string): Promise<boolean> {
  const account = await tx.account.findUnique({ where: { userId }, select: { vipUntil: true } });
  return !!account?.vipUntil && account.vipUntil.getTime() > Date.now();
}

/** Row-locks the account so concurrent charges against the same balance serialize. */
export async function lockBalance(tx: Tx, userId: string, balance: Balance = 'CREDITS'): Promise<bigint> {
  await tx.account.upsert({ where: { userId }, create: { userId }, update: {} });
  if (balance === 'ONLYASS') {
    const [row] = await tx.$queryRaw<{ onlyAssCents: bigint }[]>`
      SELECT "onlyAssCents" FROM "Account" WHERE "userId" = ${userId} FOR UPDATE`;
    return row.onlyAssCents;
  }
  const [row] = await tx.$queryRaw<{ balanceCents: bigint }[]>`
    SELECT "balanceCents" FROM "Account" WHERE "userId" = ${userId} FOR UPDATE`;
  return row.balanceCents;
}

export async function post(
  tx: Tx,
  userId: string,
  amountCents: bigint | number,
  type: TxType,
  refId?: string,
  meta?: object,
  balance: Balance = 'CREDITS',
) {
  const amt = BigInt(amountCents);
  const field = balance === 'ONLYASS' ? 'onlyAssCents' : 'balanceCents';
  await tx.account.upsert({
    where: { userId },
    create: { userId, [field]: amt },
    update: { [field]: { increment: amt } },
  });
  await tx.ledgerEntry.create({
    data: { userId, amountCents: amt, type, refId, meta: meta as Prisma.InputJsonValue },
  });
}

/**
 * Fan pays creator, in credits, always. Platform takes its cut. Whoever
 * referred the creator and whoever referred the fan each get their own slice
 * of the platform's cut (see referralCut() below).
 *
 * There is no choice of payment asset: credits are the only thing anyone
 * spends here (see Balance above). Being VIP -- having burned enough
 * $ONLYONE, core/vip.ts -- is the only thing that discounts a charge.
 */
export async function charge(
  tx: Tx,
  p: { fanId: string; creatorId: string; grossCents: number; type: TxType; refId: string },
) {
  if (p.fanId === p.creatorId) throw new Error('self_payment');
  if (p.grossCents <= 0) throw new Error('invalid_amount');

  const [creator, fan] = await Promise.all([
    tx.creatorProfile.findUniqueOrThrow({
      where: { userId: p.creatorId },
      include: { user: { select: { referredById: true, createdAt: true, status: true } } },
    }),
    tx.user.findUniqueOrThrow({ where: { id: p.fanId }, select: { referredById: true, createdAt: true } }),
  ]);
  if (creator.user.status !== 'ACTIVE') throw new Error('creator_unavailable');

  // The VIP discount is the PLATFORM's to fund, not the creator's.
  //
  // It used to come off the charge before the fee was taken, which meant a
  // creator earned 81 instead of 90 on a 100 tip from a VIP while the
  // platform gave up 1 -- the creator paying 90% of the platform's loyalty
  // programme, out of money the fan intended for them. Creators would have
  // priced around it the moment they noticed.
  //
  // So the creator's net is computed from the FULL list price and is
  // identical either way; the discount is taken from what the platform keeps.
  // Clamped to the fee, because a discount larger than the platform's own cut
  // would have the platform paying the difference on every transaction --
  // minting money out of nothing, per charge, forever.
  const vip = await isVip(tx, p.fanId);
  const discountBps = vip ? Math.min(FEES.VIP_DISCOUNT_BPS, FEES.DEFAULT_BPS) : 0;
  const chargeCents = Math.round((p.grossCents * (10_000 - discountBps)) / 10_000);

  const bal = await lockBalance(tx, p.fanId);
  if (bal < BigInt(chargeCents)) throw new InsufficientFunds();

  const net = p.grossCents - Math.floor((p.grossCents * FEES.DEFAULT_BPS) / 10_000);
  const fee = chargeCents - net;

  // Whoever referred the creator (payee) and whoever referred the fan (payer)
  // each earn a cut of the platform's fee for FEES.REFERRAL_MONTHS after the
  // referred person signed up -- referring either side of a transaction pays.
  const referralCut = (referredById: string | null, since: Date) => {
    if (!referredById) return 0;
    const cutoff = new Date(since);
    cutoff.setMonth(cutoff.getMonth() + FEES.REFERRAL_MONTHS);
    if (new Date() >= cutoff) return 0;
    return Math.floor((chargeCents * FEES.REFERRAL_BPS) / 10_000);
  };
  // Referral payouts come out of the platform's fee and nowhere else, so the
  // cap has to bind what each referrer is actually *paid*, not just the total
  // reported back. Two FEES.REFERRAL_BPS cuts (5% + 5%) can exceed a fee that
  // is itself smaller, which moved more out of the platform than it ever
  // collected -- value minted from nothing. Scale both down proportionally
  // against the fee actually retained; flooring each share means any rounding
  // remainder stays with the platform rather than being conjured. The one
  // case that made this reachable (an 8% payout fee for creators taking
  // $ONLYASS) is gone, but the cap stays: it is the invariant, not a patch
  // for one rate.
  let creatorReferral = referralCut(creator.user.referredById, creator.user.createdAt);
  let fanReferral = referralCut(fan.referredById, fan.createdAt);
  const claimed = creatorReferral + fanReferral;
  if (claimed > fee) {
    creatorReferral = Math.floor((creatorReferral * fee) / claimed);
    fanReferral = Math.floor((fanReferral * fee) / claimed);
  }
  const referral = creatorReferral + fanReferral;

  await post(tx, p.fanId, -chargeCents, p.type, p.refId);
  await post(tx, p.creatorId, net, p.type, p.refId, { gross: chargeCents, fee, originalPriceCents: p.grossCents });
  await post(tx, PLATFORM_ID, fee - referral, 'PLATFORM_FEE', p.refId, { source: p.type });
  if (creatorReferral) await post(tx, creator.user.referredById!, creatorReferral, 'REFERRAL', p.refId, { for: 'creator' });
  if (fanReferral) await post(tx, fan.referredById!, fanReferral, 'REFERRAL', p.refId, { for: 'fan' });

  return { gross: chargeCents, fee, net, referral };
}

/** Wrap a money operation in a serializable transaction, retrying on serialization conflicts. */
export async function money<T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let i = 0; i < 4; i++) {
    try {
      return await prisma.$transaction(fn as never, { isolationLevel: 'Serializable', timeout: 15000 });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'P2034' || i === 3) throw e;
    }
  }
  throw new Error('unreachable');
}
