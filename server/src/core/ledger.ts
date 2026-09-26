import { Prisma, PrismaClient, TxType } from '@prisma/client';
import { creatorMayBePaid } from './creator-standing.js';

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
  INSTANT_PAYOUT_BPS: 200, // +2% on top, for skipping the payout queue -- charged to every creator (the token-lock waiver was a free toggle; see modules/payouts.ts)
  MIN_PAYOUT_CENTS: 2000,
  MIN_TIP_CENTS: 100,
  // Fallback floor on paid inbound DMs when PlatformConfig has no row yet.
  // Admin moves the live value with PATCH /admin/vip-config
  // (minDmPriceCents, 1..50000 -- it can never be zero).
  MIN_DM_PRICE_CENTS: 99,
  // Smallest NON-ZERO price a creator may set on the pay-per-use surfaces.
  // charge() floors the platform's fee per transaction, so a price small
  // enough that fee = floor(price * bps / 10000) = 0 moved 100% to the
  // creator: a 4-cent minute at 20% or a 9-cent priced message at 10% kept
  // the platform nothing, on every minute of every viewer. Each floor here
  // keeps the fee at least one cent at its rate. 0 still means "free / off".
  MIN_PER_MINUTE_CENTS: 5, // 20% of 5 = 1
  MIN_TICKET_CENTS: 100,
  MIN_PRICED_MESSAGE_CENTS: 100, // same as the PPV-post floor
  // The admin-set floor on inbound DM prices can go no lower than this.
  MIN_DM_FLOOR_CENTS: 10, // 10% of 10 = 1
};

/** zod-friendly check: 0 (off/free) or at least `min`. */
export const zeroOrAtLeast = (min: number) => (v: number) => v === 0 || v >= min;

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
export const FAN_CHARGE_TYPES = [
  'TIP', 'SUBSCRIPTION', 'PPV', 'MESSAGE_UNLOCK', 'LIVE_TICKET', 'MARKETPLACE_SALE', 'TOKEN_LOCK',
  'LIVE_MINUTE', 'LIVE_TIP', 'DM_SEND',
] as const;

/**
 * Gross fan spend since `since`, in cents (GET /admin/stats gmv30dCents).
 *
 * Every fan-side debit of a FAN_CHARGE_TYPES type -- VIP membership books as
 * a SUBSCRIPTION debit (core/vip.ts), so it is included -- EXCEPT the
 * marketplace, which is counted from its orders instead: a won auction has
 * no fan-side MARKETPLACE_SALE debit at all (the winner's money left at bid
 * time as an AUCTION_BID_HOLD, which is a hold, not a sale, and would be
 * double-counted with any outbid-and-released hold). ListingOrder carries
 * exactly what each sale charged, fixed-price and auction alike: price plus
 * shipping. It used to be a hardcoded five-type subset that missed every
 * type added since (live minutes and tips, paid DMs, token locks, the
 * marketplace).
 */
export async function grossFanSpendCents(db: Pick<PrismaClient, 'ledgerEntry' | 'listingOrder'> | Tx, since: Date) {
  const [ledger, orders] = await Promise.all([
    db.ledgerEntry.aggregate({
      _sum: { amountCents: true },
      where: {
        amountCents: { lt: 0 },
        type: { in: FAN_CHARGE_TYPES.filter((t) => t !== 'MARKETPLACE_SALE') },
        createdAt: { gt: since },
      },
    }),
    db.listingOrder.aggregate({ _sum: { priceCents: true, shippingCents: true }, where: { createdAt: { gt: since } } }),
  ]);
  return -Number(ledger._sum.amountCents ?? 0) + (orders._sum.priceCents ?? 0) + (orders._sum.shippingCents ?? 0);
}

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

/**
 * Moves a balance and writes its ledger row, in the caller's transaction.
 *
 * Closed-loop credits: `opts.earned` marks a CREDITS posting as money EARNED
 * from someone else's spend (a creator's share of a charge or sale, a
 * referral cut, a payout reversal) -- only that raises withdrawableCents,
 * the part of the balance a payout may take. Deposited credits are
 * spendable here and never withdrawn. Every CREDITS debit then clamps
 * withdrawableCents to the new balance, which is what makes a spend consume
 * the non-withdrawable part first and keeps 0 <= withdrawable <= balance
 * (a credit that raises withdrawable is clamped the same way).
 * A payout reserves withdrawable credits explicitly (reserveWithdrawable)
 * before debiting.
 *
 * `opts.withdrawableCents` is for returning a user's OWN held money (an
 * auction hold being released): it restores exactly that much of the credit
 * as withdrawable -- the part the hold took from their earned credits --
 * and the rest comes back as ordinary spendable credits. Clamped to the
 * credit itself.
 *
 * `opts.at` stamps the ledger row with a time other than now -- only
 * core/referrals.ts uses it, to date a day's settled referral total to the
 * UTC day it was earned.
 */
export async function post(
  tx: Tx,
  userId: string,
  amountCents: bigint | number,
  type: TxType,
  refId?: string,
  meta?: object,
  balance: Balance = 'CREDITS',
  opts: { earned?: boolean; withdrawableCents?: bigint | number; at?: Date } = {},
) {
  const amt = BigInt(amountCents);
  const field = balance === 'ONLYONE' ? 'onlyOneCents' : 'balanceCents';
  let w = 0n;
  if (balance === 'CREDITS' && amt > 0n) {
    if (opts.earned) w = amt;
    else if (opts.withdrawableCents != null) {
      const r = BigInt(opts.withdrawableCents);
      w = r < 0n ? 0n : r > amt ? amt : r;
    }
  }
  await tx.account.upsert({
    where: { userId },
    create: { userId, [field]: amt, ...(w > 0n ? { withdrawableCents: w } : {}) },
    update: { [field]: { increment: amt }, ...(w > 0n ? { withdrawableCents: { increment: w } } : {}) },
  });
  // Clamped after a debit, and after any credit that raised withdrawable
  // too: an earning landing on a NEGATIVE balance (an admin correction can
  // leave one) used to add its full amount to withdrawable while the balance
  // rose only to the credit minus the deficit -- withdrawable 900 against a
  // balance of 400.
  if (balance === 'CREDITS' && (amt < 0n || w > 0n)) {
    await tx.$executeRaw`
      UPDATE "Account" SET "withdrawableCents" = GREATEST(0, LEAST("withdrawableCents", "balanceCents"))
      WHERE "userId" = ${userId} AND "withdrawableCents" > GREATEST(0, "balanceCents")`;
  }
  await tx.ledgerEntry.create({
    data: { userId, amountCents: amt, type, refId, meta: meta as Prisma.InputJsonValue, ...(opts.at ? { createdAt: opts.at } : {}) },
  });
}

/**
 * Takes `amountCents` of a creator's withdrawable (earned) credits for a
 * payout, under the account's row lock. Throws InsufficientFunds when the
 * earned part of the balance does not cover it -- deposited credits are
 * never payable. The caller then posts the matching debit.
 */
export async function reserveWithdrawable(tx: Tx, userId: string, amountCents: number | bigint) {
  const amt = BigInt(amountCents);
  await tx.account.upsert({ where: { userId }, create: { userId }, update: {} });
  const [row] = await tx.$queryRaw<{ balanceCents: bigint; withdrawableCents: bigint }[]>`
    SELECT "balanceCents", "withdrawableCents" FROM "Account" WHERE "userId" = ${userId} FOR UPDATE`;
  if (row.balanceCents < amt || row.withdrawableCents < amt) throw new InsufficientFunds();
  await tx.account.update({ where: { userId }, data: { withdrawableCents: { decrement: amt } } });
  return { balanceCents: row.balanceCents, withdrawableCents: row.withdrawableCents };
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
 *
 * NOT HONOURED HERE (yet): the site's Founding Creator fee waiver -- 0% total
 * fee for 30 days from the later of the founding grant and PAYMENTS_LIVE_AT
 * (lib/founding.js feeWaiverActive on the Next.js site). server/ holds no
 * founding data at all: the bridge (lib/bridge.ts) carries a creator's
 * standing, not their founding flag or foundingSince, so there is nothing
 * here to decide a waiver from, and none is invented. Until the bridge
 * carries it, every server/ charge pays the rate below, and marketplace
 * buys and auction closes (modules/marketplace.ts, core/auctions.ts) the
 * fixed 10% + 5%. TODO(founding-waiver): once the site sends the waiver
 * window start on a creator's bridge token, store it on CreatorProfile and
 * zero the platform fee AND the listing fee in charge(), the marketplace
 * buy and closeAuction while the window is open -- the creator's side of
 * the split only (never a fan-facing discount); the proportional referral
 * cap then brings referral cuts to 0 with it. The live site does not route
 * money through server/ today, so no founding creator is charged by this.
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
      include: { user: { select: { referredById: true, createdAt: true, status: true, role: true, kycStatus: true, siteUid: true, siteCreatorStatus: true } } },
    }),
    tx.user.findUniqueOrThrow({ where: { id: p.fanId }, select: { referredById: true, createdAt: true } }),
  ]);
  // Every new flow of money to a creator -- tips, DMs, unlocks, live, new
  // subscriptions and their renewals, token locks -- requires a creator who
  // is not suspended or banned AND is still approved (KYC, and for a row
  // bridged from the site, the site's own approval with its §2257 gate).
  // Checking only status let a creator whose KYC was demoted, or whom the
  // site moved back to 'pending', keep taking money by direct link while
  // discovery already hid them. Serving content already paid for is a
  // separate rule (core/access.ts creatorIsActive).
  if (!creatorMayBePaid(creator.user)) throw Object.assign(new Error('creator_unavailable'), { statusCode: 400 });

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
  await post(tx, p.creatorId, net, p.type, p.refId, { gross: chargeCents, fee, originalPriceCents: p.grossCents, fanId: p.fanId }, 'CREDITS', { earned: true });
  await postPlatformRevenue(tx, fee - referral, p.refId, { source: p.type });
  // Referral cuts are NOT credited to the referrer here. Posting each one
  // straight into the referrer's balance let them poll GET /wallet/balance
  // (or /payouts/earnings, or watch a spend succeed) and date every purchase
  // their referred friend made -- each live minute, each paid DM -- and its
  // price bracket. The platform account holds the cut (a REFERRAL row on
  // PLATFORM_ID, meta.held) and a PendingReferral row records who it is owed
  // to; core/referrals.ts settleReferrals() credits one summed REFERRAL entry
  // per referrer per side per UTC day, only once that day has ended.
  //
  // The referrer's settled row carries no refId and no charge ref: the
  // charge's refId is the purchased object (the PPV post, the live stream,
  // the unlocked message, for a DM the paying fan's own id). The charge ref
  // stays on the platform-side hold row and the pending row, for
  // reconciliation; neither is ever returned to the referrer.
  const hold = async (referrerId: string, cents: number, side: 'creator' | 'fan') => {
    await post(tx, PLATFORM_ID, cents, 'REFERRAL', undefined, { held: true, for: side, ...(p.refId ? { chargeRefId: p.refId } : {}) });
    await tx.pendingReferral.create({ data: { referrerId, side, amountCents: BigInt(cents), chargeRefId: p.refId || null } });
  };
  if (creatorReferral) await hold(creator.user.referredById!, creatorReferral, 'creator');
  if (fanReferral) await hold(fan.referredById!, fanReferral, 'fan');

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
