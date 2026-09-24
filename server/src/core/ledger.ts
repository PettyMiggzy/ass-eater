import { Prisma, PrismaClient, TxType } from '@prisma/client';

export const PLATFORM_ID = '00000000-0000-0000-0000-000000000000';
// Pseudo-account tokens burned via core/vip.ts's burnTokens() are posted to --
// same shape as PLATFORM_ID, except nothing is ever paid out of this one. Its
// balance is purely a running "how much value has been burned" ledger record.
export const BURNED_ID = '00000000-0000-0000-0000-0000000000b0';

export const FEES = {
  DEFAULT_BPS: 1000, // 10% — standard platform cut
  // 20% on anything earned DURING a live stream: the ticket, per-minute
  // viewing, and tips sent while the stream is running.
  //
  // Decided 2026-09-20, and the shape matters as much as the number. This is
  // a higher cut of LIVE REVENUE, not a fee on a creator's income and not a
  // subscription to unlock a feature. A creator who never goes live pays
  // exactly what they pay today and has nothing to opt into, read, or
  // decline; a creator who lives constantly pays more, in proportion to what
  // they actually cost us to carry. Live is the one thing here with a real
  // per-minute marginal cost (media servers, egress), so it is the one thing
  // whose price should track usage.
  //
  // The alternative that was rejected: charging creators +5% of ALL their
  // income for access to live. That taxes a creator's subscriptions and
  // marketplace sales to pay for bandwidth they may barely use, and it needs
  // a tier, an opt-in and an explanation. This needs none.
  LIVE_BPS: 2000,
  DEPOSIT_BPS: 200, // 2% taken when a fan buys credits — see creditDeposit()
  // What share of the platform's OWN revenue is committed to buying $ONLYONE
  // on the open market and burning it. Overridable in PlatformConfig.burnBps.
  BURN_BPS: 2500,
  REFERRAL_BPS: 500, // 5% of gross to referrer, paid out of the platform's cut
  REFERRAL_MONTHS: 12,
  WITHDRAWAL_FLAT_CENTS: 100, // $1 per payout
  WITHDRAWAL_BPS: 100, // +1%
  INSTANT_PAYOUT_BPS: 200, // +2% on top, for skipping the payout queue -- waived if the creator opted into the token-lock perk
  MIN_PAYOUT_CENTS: 2000,
  MIN_TIP_CENTS: 100,
  // Fallback floor on paid inbound DMs when PlatformConfig has no row yet.
  // Admin moves the live value with PATCH /admin/vip-config
  // (minDmPriceCents, 1..50000 -- it can never be zero).
  MIN_DM_PRICE_CENTS: 99,
};

/**
 * The two balances an account carries, and they are not interchangeable.
 *
 * CREDITS is money: fans buy credits with USDC at 1 credit = $1 (booked here
 * in cents), spend them on subscriptions, tips, unlocks and the marketplace,
 * and creators are paid out of it in USDC. Everything charge() touches is
 * this one.
 *
 * ONLYONE is a HOLDING, not a payment source. Tokens a fan has deposited sit
 * here and the only thing that can be done with them is burn them for VIP
 * (core/vip.ts). Decided 2026-09-18: the token is deliberately never a way to
 * pay for anything -- it is far too volatile to denominate what someone is
 * owed, and a platform that both prices content in its own token and converts
 * it back to dollars is a redemption desk for its own token. If you are about
 * to let this reach charge(), that is the line.
 */
export type Balance = 'CREDITS' | 'ONLYONE';

export class InsufficientFunds extends Error {
  constructor() {
    super('insufficient_funds');
  }
}

export type Tx = Prisma.TransactionClient;

/**
 * Posts money the platform keeps, and records the share of it owed to the
 * token burn in the same transaction.
 *
 * Every PLATFORM_FEE posting goes through here so the two can never come
 * apart. There are eight places revenue lands -- charges, marketplace,
 * auctions, withdrawals, promotions, deposits, VIP -- and "remember to also
 * write a TokenBurn row" at eight call sites is a rule that gets forgotten at
 * the ninth.
 *
 * Money bound for a creator is never touched: this is only the platform's own
 * cut, which is the money that would otherwise just sit there.
 */
export async function postPlatformRevenue(
  tx: Tx,
  amountCents: number | bigint,
  refId?: string,
  meta?: object,
) {
  const amount = BigInt(amountCents);
  await post(tx, PLATFORM_ID, amount, 'PLATFORM_FEE', refId, meta);
  if (amount <= 0n) return { burnCents: 0n };

  const config = await tx.platformConfig.findUnique({ where: { id: 1 } });
  const bps = BigInt(config?.burnBps ?? FEES.BURN_BPS);
  const burnCents = (amount * bps) / 10_000n;
  if (burnCents > 0n) {
    await tx.tokenBurn.create({
      data: { usdCents: burnCents, reason: (meta as any)?.source ?? (meta as any)?.kind ?? 'revenue', refId },
    });
  }
  return { burnCents };
}

/**
 * Credits a fan's deposit, less the buy-credits fee.
 *
 * $100 of stablecoin arrives, 98 credits are issued, the platform keeps $2.
 * Note which direction that leaves the books: the pool holds the full $100
 * against $98 of credits, so taking this fee makes the float MORE than fully
 * backed, never less. The fee is floored, so any rounding remainder also
 * stays on the safe side.
 *
 * Returns the split so the caller can record both halves against the
 * deposit row -- the gross is what actually landed on-chain and must stay
 * recoverable, so it is never overwritten with the net.
 */
export function splitDeposit(grossCents: bigint): { creditedCents: bigint; feeCents: bigint } {
  const feeCents = (grossCents * BigInt(FEES.DEPOSIT_BPS)) / 10_000n;
  return { creditedCents: grossCents - feeCents, feeCents };
}

/**
 * Posts both halves of a deposit: credits to the fan, fee to the platform.
 *
 * One function so the two can never drift apart -- crediting the net without
 * posting the fee would quietly destroy the platform's revenue, and posting
 * the fee without netting the credit would hand it out twice.
 */
export async function creditDeposit(
  tx: Tx,
  userId: string,
  grossCents: bigint,
  refId: string,
  meta?: object,
) {
  const { creditedCents, feeCents } = splitDeposit(grossCents);
  await post(tx, userId, creditedCents, 'DEPOSIT', refId, { ...meta, grossCents: grossCents.toString(), feeCents: feeCents.toString() });
  if (feeCents > 0n) {
    await postPlatformRevenue(tx, feeCents, refId, { source: 'deposit', fanId: userId });
  }
  return { creditedCents, feeCents };
}

/**
 * Fans a creator earns the most from, restricted to CURRENT VIP members.
 *
 * This is the "Top Supporter placement" VIP perk: a fan who spends a fortune
 * but isn't VIP does not appear here, however much they've paid -- that is
 * what makes the badge worth having to someone who already spends a lot.
 * Ranked by lifetime revenue from that fan, not spend in any window.
 *
 * Reads LedgerEntry.meta.fanId, which charge() writes on the creator-side
 * posting of every fan payment. Restricted to the charge types that are
 * actually a fan paying a creator -- a creator's own PAYOUT, PLATFORM_FEE,
 * REFERRAL and TOKEN_BURN entries live on the same ledger and must never be
 * grouped in with fan spend.
 *
 * Capped at 200 candidate fans before the VIP check runs, so a creator with
 * an unusually large paying audience can't turn this into an unbounded scan.
 * Worth revisiting if a real creator ever approaches that number.
 *
 * DELIBERATELY NOT wired to any public page yet. Badging a fan's name in a
 * public comment or DM thread as a "top supporter" outs them as a paying
 * customer of adult content, to anyone who can see that thread -- a real
 * privacy cost against a platform that otherwise lets fans sign up under a
 * bare username specifically so a partner/employer never makes that link.
 * This is a creator-facing analytics number (modules/creators.ts) until
 * someone decides, explicitly, that a public badge is worth that trade --
 * and if it ever is, it should be opt-in per fan, not automatic.
 */
// Stale allowlist, missed when DM_SEND/LIVE_MINUTE/LIVE_TIP were added as
// fan-to-creator TxTypes (the live/DM pricing work) -- a fan who only tips
// during live streams, pays per-minute to watch, or pays to DM a creator was
// invisible here however much they'd actually paid, while equivalent spend
// via TIP/SUBSCRIPTION/PPV counted. This list has to be every TxType where
// `meta.fanId` identifies who paid the creator; check here whenever a new
// fan-facing charge type is added.
const FAN_CHARGE_TYPES = [
  'TIP', 'SUBSCRIPTION', 'PPV', 'MESSAGE_UNLOCK', 'LIVE_TICKET', 'MARKETPLACE_SALE', 'TOKEN_LOCK',
  'LIVE_MINUTE', 'LIVE_TIP', 'DM_SEND',
];

export async function getTopSupporters(tx: Tx, creatorId: string, limit = 10) {
  const rows = await tx.$queryRaw<{ fanId: string; totalCents: bigint }[]>`
    SELECT (meta->>'fanId') AS "fanId", SUM("amountCents") AS "totalCents"
    FROM "LedgerEntry"
    WHERE "userId" = ${creatorId}
      AND "amountCents" > 0
      AND "type"::text = ANY(${FAN_CHARGE_TYPES})
      AND meta->>'fanId' IS NOT NULL
    GROUP BY meta->>'fanId'
    ORDER BY SUM("amountCents") DESC
    LIMIT 200
  `;
  const withVip = await Promise.all(rows.map(async (r) => ({ fanId: r.fanId, totalCents: Number(r.totalCents), isVip: await isVip(tx, r.fanId) })));
  return withVip.filter((r) => r.isVip).slice(0, limit);
}

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
  if (balance === 'ONLYONE') {
    const [row] = await tx.$queryRaw<{ onlyOneCents: bigint }[]>`
      SELECT "onlyOneCents" FROM "Account" WHERE "userId" = ${userId} FOR UPDATE`;
    return row.onlyOneCents;
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
  const field = balance === 'ONLYONE' ? 'onlyOneCents' : 'balanceCents';
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
 * **There are no discounts.** Decided 2026-09-18: the platform keeps a flat
 * 10% and nothing reduces it -- not VIP, not referrals, not paying in any
 * particular asset. VIP is sold on perks alone (early access, priority,
 * status), which is how Twitch subs and YouTube memberships work; none of
 * them discount anything either.
 *
 * Creator-set discounts are a separate, later question and are deliberately
 * not built. If one is ever added it belongs to the CREATOR's side of the
 * split, not the platform's cut.
 *
 * There is also no choice of payment asset: credits are the only thing
 * anyone spends here (see Balance above).
 */
/**
 * The platform's cut for a given kind of charge.
 *
 * Everything pays FEES.DEFAULT_BPS unless it is listed here, so adding a new
 * TxType can never silently pick up a non-standard rate -- a new rate has to
 * be written down in this table on purpose.
 *
 * The live types are separate TxTypes rather than a flag on TIP precisely so
 * the rate is a property of the ledger row: reading the ledger back tells you
 * which rate applied and why, months later, without re-deriving it from a
 * stream that has since ended.
 */
const PLATFORM_BPS_BY_TYPE: Partial<Record<TxType, number>> = {
  LIVE_TICKET: FEES.LIVE_BPS,
  LIVE_MINUTE: FEES.LIVE_BPS,
  LIVE_TIP: FEES.LIVE_BPS,
};

export function platformBpsFor(type: TxType): number {
  return PLATFORM_BPS_BY_TYPE[type] ?? FEES.DEFAULT_BPS;
}

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

  // The fan pays the list price. Nothing reduces it.
  const chargeCents = p.grossCents;

  const bal = await lockBalance(tx, p.fanId);
  if (bal < BigInt(chargeCents)) throw new InsufficientFunds();

  const feeBps = platformBpsFor(p.type);
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
  // reported back. Two FEES.REFERRAL_BPS cuts (5% + 5%) can exceed a fee that
  // is itself smaller, which moved more out of the platform than it ever
  // collected -- value minted from nothing. Scale both down proportionally
  // against the fee actually retained; flooring each share means any rounding
  // remainder stays with the platform rather than being conjured. The one
  // case that made this reachable (an 8% payout fee for creators taking
  // $ONLYONE) is gone, but the cap stays: it is the invariant, not a patch
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
  // fanId rides along so a creator's ledger can be grouped by who paid --
  // see getTopSupporters() below. Nothing before this needed it; adding it
  // here is the one safe place, since every fan->creator charge posts here.
  await post(tx, p.creatorId, net, p.type, p.refId, { gross: chargeCents, fee, originalPriceCents: p.grossCents, fanId: p.fanId });
  await postPlatformRevenue(tx, fee - referral, p.refId, { source: p.type });
  if (creatorReferral) await post(tx, creator.user.referredById!, creatorReferral, 'REFERRAL', p.refId, { for: 'creator' });
  if (fanReferral) await post(tx, fan.referredById!, fanReferral, 'REFERRAL', p.refId, { for: 'fan' });

  return { gross: chargeCents, fee, net, referral };
}

/**
 * True for a transaction that lost a serialization race and is safe to retry.
 * Prisma surfaces it as P2034 on its own queries; a $queryRaw (lockBalance's
 * SELECT ... FOR UPDATE) that loses one reports the raw SQLSTATE through
 * P2010 instead, and a deadlock is the same "try again" signal.
 */
function isRetryableConflict(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string }; message?: string };
  if (err?.code === 'P2034') return true;
  if (err?.code === 'P2010' && (err.meta?.code === '40001' || err.meta?.code === '40P01')) return true;
  return /\b(40001|40P01)\b|could not serialize access|deadlock detected/.test(String(err?.message ?? ''));
}

const MONEY_ATTEMPTS = 8;

/**
 * Wrap a money operation in a serializable transaction, retrying on
 * serialization conflicts.
 *
 * Every charge writes the same hot rows (the platform's Account, a popular
 * creator's), and Postgres serializes SERIALIZABLE writers to one row by
 * failing all but one with 40001. Retrying immediately just re-collides with
 * the same neighbours, so the retries back off with jitter (roughly
 * 15ms -> 1s). Once the attempts are exhausted the caller gets a 503
 * `busy_retry` -- the request did nothing and is safe to repeat -- rather than
 * an opaque 500.
 */
export async function money<T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let i = 0; i < MONEY_ATTEMPTS; i++) {
    try {
      return await prisma.$transaction(fn as never, { isolationLevel: 'Serializable', timeout: 15000 });
    } catch (e) {
      if (!isRetryableConflict(e)) throw e;
      if (i === MONEY_ATTEMPTS - 1) {
        throw Object.assign(new Error('busy_retry'), { statusCode: 503, cause: e });
      }
      const base = Math.min(1000, 15 * 2 ** i);
      await new Promise((r) => setTimeout(r, base / 2 + Math.random() * base));
    }
  }
  throw new Error('unreachable');
}
