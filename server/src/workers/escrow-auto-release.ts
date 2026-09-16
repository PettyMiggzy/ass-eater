import { prisma } from '../lib/prisma';
import { autoRelease } from '../core/escrow';

// A creator shouldn't have to depend on a buyer actually clicking "confirm
// receipt" (or a dispute actually getting resolved) to ever get paid -- this
// sweeps physical orders whose clock has run out with nothing further from
// the buyer, and pays them out the same way confirmReceipt would. Covers
// both a plain unresolved shipment and a dispute whose grace period expired
// unresolved (see core/escrow.ts's disputeOrder) -- same money movement,
// same reasoning either way: silence favors whoever already performed.

const INTERVAL_MS = Number(process.env.ESCROW_SWEEP_INTERVAL_MS ?? 3_600_000); // hourly is plenty; this isn't time-sensitive

async function sweep() {
  const due = await prisma.listingOrder.findMany({
    where: { fulfillmentStatus: { in: ['SHIPPED', 'DISPUTED'] }, autoReleaseAt: { lte: new Date() } },
    select: { id: true },
  });
  for (const { id } of due) {
    try {
      await prisma.$transaction((tx) => autoRelease(tx, id));
    } catch (e) {
      console.error('escrow-auto-release', id, e);
    }
  }
}

(async function loop() {
  for (;;) {
    try { await sweep(); } catch (e) { console.error('escrow-auto-release', e); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
})();
