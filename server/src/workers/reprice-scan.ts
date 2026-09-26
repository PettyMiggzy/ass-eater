import { prisma } from '../lib/prisma.js';
import { money, type Tx } from '../core/ledger.js';

type PendingDeposit = Awaited<ReturnType<typeof prisma.deposit.findMany>>[number];

/**
 * Walks the price-pending deposits of the assets that CAN be priced right
 * now, oldest first, in pages, calling `each` once per row (repricePending
 * in workers/deposit-indexer.ts). Kept free of the indexer's side effects so
 * it is testable on its own.
 *
 * It used to read the 100 oldest pending rows of ANY asset and skip past the
 * ones it could not price -- so 100 unpriceable ETH deposits (100 tiny
 * transfers while CHAINLINK_ETH_USD is unset, cheap on an L2) meant no newer
 * $ONLYONE deposit was ever looked at again, never credited, never swept.
 * Now an asset whose price could not be read this pass is not queried at all,
 * and the walk moves on by a (createdAt, id) cursor rather than re-reading
 * the same head, up to `maxPerPass` rows (the rest wait for the next pass).
 */
export async function forEachPricedPending(
  chainId: number,
  pricedAssets: Array<'ETH' | 'ONLYONE'>,
  each: (d: PendingDeposit) => Promise<void>,
  opts: { pageSize?: number; maxPerPass?: number } = {},
): Promise<number> {
  const pageSize = opts.pageSize ?? 100;
  const maxPerPass = opts.maxPerPass ?? 1000;
  if (!pricedAssets.length) return 0;
  let seen = 0;
  let cursor: { createdAt: Date; id: string } | null = null;
  while (seen < maxPerPass) {
    const rows: PendingDeposit[] = await prisma.deposit.findMany({
      where: {
        chainId, pricePending: true, asset: { in: pricedAssets },
        ...(cursor ? { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.min(pageSize, maxPerPass - seen),
    });
    if (!rows.length) break;
    for (const d of rows) {
      seen++;
      await each(d);
    }
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }
  return seen;
}

/**
 * Settles one price-pending deposit at price `px` (`cents` already derived
 * from it): the guarded claim (pricePending true -> false) and, if it priced
 * above zero, the credit -- one serializable transaction, so two passes can
 * never both credit one deposit. Dust that priced to zero is settled with
 * nothing to credit, same as the first pass does.
 *
 * `claimed` and `credited` are returned separately because they drive
 * different follow-ups in repricePending: the address's sweep is re-queued
 * whenever the row was CLAIMED (a pending row defers every ETH/$ONLYONE sweep
 * at its address, so clearing it -- dust included -- must queue one), while
 * the deposit notification and the credited count need an actual credit.
 */
export async function settleRepriced(
  d: { id: string; hedgedAt: Date | null },
  cents: bigint,
  px: number,
  postCredit: (tx: Tx) => Promise<void>,
): Promise<{ claimed: boolean; credited: boolean }> {
  return money(prisma, async (tx) => {
    const claim = await tx.deposit.updateMany({
      where: { id: d.id, pricePending: true },
      data: { pricePending: false, usdCents: cents > 0n ? cents : 0n, priceUsed: px, hedgedAt: cents > 0n ? null : d.hedgedAt },
    });
    if (!claim.count) return { claimed: false, credited: false };
    if (cents <= 0n) return { claimed: true, credited: false };
    await postCredit(tx);
    return { claimed: true, credited: true };
  });
}
