import { PLATFORM_ID, lockBalance, post, InsufficientFunds, isVip, type Tx , postPlatformRevenue} from './ledger';

export { isVip };

/**
 * VIP: a paid monthly membership whose revenue buys $ONLYONE on the open
 * market and burns it.
 *
 * Decided 2026-09-18, replacing "burn 10 million tokens for permanent VIP".
 * Two reasons the paid version is strictly better:
 *
 *  - **The fan needs no wallet.** They pay $20 in credits, like everything
 *    else on the platform. Asking a fan to acquire a token on a DEX before
 *    they can buy a perk loses almost all of them.
 *  - **It recurs.** A one-time burn is a single event; a membership buys and
 *    destroys supply every month for as long as the member stays. And the
 *    buying happens on the OPEN MARKET, which moves the price -- unlike the
 *    platform selling its own tokens, which would cap the price at whatever
 *    it sold them for.
 *
 * VIP is not permanent any more. It runs while `vipUntil` is in the future.
 */

export const VIP_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_VIP_PRICE_CENTS = 2000;

export async function getVipConfig(tx: Tx) {
  const config = await tx.platformConfig.findUnique({ where: { id: 1 } });
  return { priceCents: config?.vipPriceCents ?? DEFAULT_VIP_PRICE_CENTS };
}

export async function getVipStatus(tx: Tx, userId: string) {
  const [account, config] = await Promise.all([
    tx.account.findUnique({ where: { userId }, select: { vipUntil: true } }),
    getVipConfig(tx),
  ]);
  const until = account?.vipUntil ?? null;
  return {
    isVip: !!until && until.getTime() > Date.now(),
    vipUntil: until,
    priceCents: config.priceCents,
  };
}

/**
 * Buy or extend a month of VIP.
 *
 * Extends from whichever is later, the current expiry or now, so paying
 * early adds a month rather than throwing away the rest of the one already
 * paid for. Renewing late starts from today, which is the same rule the
 * subscription renewals worker uses.
 *
 * The burn obligation is recorded in the SAME transaction as the charge.
 * Recording it afterwards would mean a crash between the two silently keeps
 * the money and never buys the tokens -- the one failure here that nobody
 * would ever notice, because the fan still gets their badge.
 */
export async function subscribeVip(tx: Tx, userId: string) {
  const { priceCents } = await getVipConfig(tx);

  const bal = await lockBalance(tx, userId);
  if (bal < BigInt(priceCents)) throw new InsufficientFunds();

  await post(tx, userId, -priceCents, 'SUBSCRIPTION', undefined, { kind: 'vip', priceCents });
  // Records the burn obligation too -- see postPlatformRevenue.
  const { burnCents } = await postPlatformRevenue(tx, priceCents, userId, { source: 'vip', fanId: userId, priceCents });

  const account = await tx.account.findUnique({ where: { userId }, select: { vipUntil: true } });
  const from = Math.max(account?.vipUntil?.getTime() ?? 0, Date.now());
  const vipUntil = new Date(from + VIP_PERIOD_MS);
  await tx.account.update({ where: { userId }, data: { vipUntil } });

  return { isVip: true, vipUntil, priceCents, committedToBurnCents: Number(burnCents) };
}

/** What the platform owes the supply but hasn't destroyed yet. */
export async function pendingBurnCents(tx: Tx): Promise<bigint> {
  const rows = await tx.tokenBurn.findMany({ where: { executedAt: null }, select: { usdCents: true } });
  return rows.reduce((sum, r) => sum + r.usdCents, 0n);
}

/**
 * Marks everything currently owed as burned, against a real transaction.
 *
 * This is the manual path, and it is the DEFAULT one: the founder holds the
 * money and does the burn himself once a month rather than leaving a hot
 * wallet with swap permissions on a server. That is a genuinely better
 * trade -- an automated burner needs a private key with spending rights
 * sitting in the runtime, which is the single most valuable thing an attacker
 * could find there.
 *
 * What it must not become is a claim. The obligation is recorded by the
 * ledger as revenue arrives, and closing it needs a real `txHash` that
 * anybody can open on an explorer. A burn recorded without one would turn a
 * verifiable number into a press release.
 *
 * Only rows that already existed are closed -- `upTo` is captured first, so
 * revenue landing mid-call stays owed rather than being marked burned by a
 * transaction that predates it.
 */
export async function recordManualBurn(
  tx: Tx,
  p: { txHash: string; tokensBurned?: string; note?: string },
) {
  const txHash = String(p.txHash || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('invalid_tx_hash');

  const upTo = new Date();
  const owed = await tx.tokenBurn.findMany({
    where: { executedAt: null, createdAt: { lte: upTo } },
    select: { id: true, usdCents: true },
  });
  if (!owed.length) return { closed: 0, usdCents: 0n, txHash };

  await tx.tokenBurn.updateMany({
    where: { id: { in: owed.map((r) => r.id) } },
    data: { executedAt: upTo, txHash, tokensBurned: p.tokensBurned ?? null },
  });
  return { closed: owed.length, usdCents: owed.reduce((sum, r) => sum + r.usdCents, 0n), txHash };
}
