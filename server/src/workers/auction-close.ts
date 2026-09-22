import { money } from '../core/ledger.js';
import { prisma } from '../lib/prisma.js';
import { closeAuction } from '../core/auctions.js';

// Auctions are time-sensitive (a bidder expects the item within seconds of
// the clock hitting zero, not whenever an hourly cron gets to it), so this
// sweeps far more often than the other periodic workers.
const INTERVAL_MS = Number(process.env.AUCTION_SWEEP_INTERVAL_MS ?? 60_000);

async function sweep() {
  const due = await prisma.listing.findMany({
    where: { saleType: 'AUCTION', status: 'ACTIVE', auctionEndsAt: { lte: new Date() } },
    select: { id: true },
  });
  for (const { id } of due) {
    try { await money(prisma, (tx) => closeAuction(tx, id)); } catch (e) { console.error('auction-close', id, e); }
  }
}

(async function loop() {
  for (;;) {
    try { await sweep(); } catch (e) { console.error('auction-close', e); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
})();
