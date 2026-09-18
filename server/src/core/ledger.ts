import { Prisma, PrismaClient, TxType } from '@prisma/client';

export const PLATFORM_ID = '00000000-0000-0000-0000-000000000000';
// Pseudo-account tokens burned via core/vip.ts's burnTokens() are posted to --
// same shape as PLATFORM_ID, except nothing is ever paid out of this one. Its
// balance is purely a running "how much value has been burned" ledger record.
export const BURNED_ID = '00000000-0000-0000-0000-0000000000b0';

export const FEES = {
  DEFAULT_BPS: 1000, // 10% — standard platform cut
  TOKEN_PAYOUT_BPS: 800, // 8% if creator takes payout in $ONLYASS (token demand driver)
  REFERRAL_BPS: 500, // 5% of gross to referrer, paid out of the platform's cut
  REFERRAL_MONTHS: 12,
  WITHDRAWAL_FLAT_CENTS: 100, // $1 per payout
  WITHDRAWAL_BPS: 100, // +1%
  INSTANT_PAYOUT_BPS: 200, // +2% on top, for skipping the payout queue -- waived if the creator opted into the token-lock perk
  VIP_DISCOUNT_BPS: 1000, // 10% off any charge for a fan who has burned enough $ONLYASS (see core/vip.ts) -- the only fan-facing discount
  MIN_PAYOUT_CENTS: 2000,
  MIN_TIP_CENTS: 100,
};

const DEFAULT_VIP_BURN_THRESHOLD_TOKENS = 10_000_000;

export type PayAsset = 'USD' | 'ONLYASS';

export class InsufficientFunds extends Error {
  constructor() {
    super('insufficient_funds');
  }
}

export type Tx = Prisma.TransactionClient;

/** Reads the platform-wide VIP burn bar, in whole $ONLYASS tokens. Admin-adjustable (see modules/vip.ts); falls back to the default if the config row hasn't been created yet. */
export async function getVipBurnThresholdTokens(tx: Tx): Promise<number> {
  const config = await tx.platformConfig.findUnique({ where: { id: 1 } });
  return config?.vipBurnThresholdTokens ?? DEFAULT_VIP_BURN_THRESHOLD_TOKENS;
}

/**
 * A fan is VIP once their cumulative burned tokens meet or exceed the
 * current threshold -- checked live, not cached, so lowering the threshold
 * later immediately qualifies anyone who already burned enough for the new
 * bar (see the Account.vipBurnedTokens schema comment).
 */
export async function isVip(tx: Tx, userId: string): Promise<boolean> {
  const [account, threshold] = await Promise.all([
    tx.account.findUnique({ where: { userId }, select: { vipBurnedTokens: true } }),
    getVipBurnThresholdTokens(tx),
  ]);
  return (account?.vipBurnedTokens ?? 0) >= threshold;
}

/** Row-locks the account so concurrent charges against the same balance serialize. */
export async function lockBalance(tx: Tx, userId: string, asset: PayAsset = 'USD'): Promise<bigint> {
  await tx.account.upsert({ where: { userId }, create: { userId }, update: {} });
  if (asset === 'ONLYASS') {
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
  asset: PayAsset = 'USD',
) {
  const amt = BigInt(amountCents);
  const field = asset === 'ONLYASS' ? 'onlyAssCents' : 'balanceCents';
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
 * Fan pays creator. Platform takes its cut. Whoever referred the creator and
 * whoever referred the fan each get their own slice of the platform's cut
 * (see referralCut() below). Paying out of a $ONLYASS-denominated balance
 * (payAsset: 'ONLYASS') does not discount the charge on its own -- being VIP
 * (having burned enough $ONLYASS, see core/vip.ts) is the only thing that
 * does, regardless of which balance the charge is paid from.
 */
export async function charge(
  tx: Tx,
  p: { fanId: string; creatorId: string; grossCents: number; type: TxType; refId: string; payAsset?: PayAsset },
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

  const payAsset: PayAsset = p.payAsset === 'ONLYASS' ? 'ONLYASS' : 'USD';
  const vip = await isVip(tx, p.fanId);
  const chargeCents = vip ? Math.round((p.grossCents * (10_000 - FEES.VIP_DISCOUNT_BPS)) / 10_000) : p.grossCents;

  const bal = await lockBalance(tx, p.fanId, payAsset);
  if (bal < BigInt(chargeCents)) throw new InsufficientFunds();

  const feeBps = creator.payoutAsset === 'ONLYASS' ? FEES.TOKEN_PAYOUT_BPS : FEES.DEFAULT_BPS;
  const fee = Math.floor((chargeCents * feeBps) / 10_000);
  const net = chargeCents - fee;

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
  // reported back: when the creator takes payout in $ONLYASS the fee is
  // FEES.TOKEN_PAYOUT_BPS (8%), which is less than two FEES.REFERRAL_BPS
  // (5% + 5%) cuts, so paying both referrers in full moved more out of the
  // platform than it ever collected -- value minted from nothing. Scale both
  // down proportionally against the fee actually retained instead; flooring
  // each share means any rounding remainder stays with the platform rather
  // than being conjured.
  let creatorReferral = referralCut(creator.user.referredById, creator.user.createdAt);
  let fanReferral = referralCut(fan.referredById, fan.createdAt);
  const claimed = creatorReferral + fanReferral;
  if (claimed > fee) {
    creatorReferral = Math.floor((creatorReferral * fee) / claimed);
    fanReferral = Math.floor((fanReferral * fee) / claimed);
  }
  const referral = creatorReferral + fanReferral;

  await post(tx, p.fanId, -chargeCents, p.type, p.refId, undefined, payAsset);
  await post(tx, p.creatorId, net, p.type, p.refId, { gross: chargeCents, fee, payAsset, originalPriceCents: p.grossCents });
  await post(tx, PLATFORM_ID, fee - referral, 'PLATFORM_FEE', p.refId, { source: p.type });
  if (creatorReferral) await post(tx, creator.user.referredById!, creatorReferral, 'REFERRAL', p.refId, { for: 'creator' });
  if (fanReferral) await post(tx, fan.referredById!, fanReferral, 'REFERRAL', p.refId, { for: 'fan' });

  return { gross: chargeCents, fee, net, referral, payAsset };
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
