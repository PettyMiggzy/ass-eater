import { prisma } from '../lib/prisma';
import { autoRelease } from '../core/escrow';

// A creator shouldn't have to depend on a buyer actually clicking "confirm
// receipt" to ever get paid -- this sweeps SHIPPED physical orders whose
// auto-release window has passed with no dispute, and pays them out the same
// way confirmReceipt would. Same protection eBay/Amazon marketplaces give
// sellers against a buyer who received the item and just never confirms.

const INTERVAL_MS = Number(process.env.ESCROW_SWEEP_INTERVAL_MS ?? 3_600_000); // hourly is plenty; this isn't time-sensitive

async function sweep() {
  const due = await prisma.listingOrder.findMany({
    where: { fulfillmentStatus: 'SHIPPED', autoReleaseAt: { lte: new Date() } },
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
