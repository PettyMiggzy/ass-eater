import { money } from '../core/ledger.js';
import { prisma } from '../lib/prisma.js';
import { envInt } from '../lib/chain.js';
import { closeAuction } from '../core/auctions.js';
import { sweepLive } from '../core/live-sweep.js';
import { rooms, livekitConfigured } from '../core/livekit.js';

// Auctions are time-sensitive (a bidder expects the item within seconds of
// the clock hitting zero, not whenever an hourly cron gets to it), so this
// sweeps far more often than the other periodic workers.
const INTERVAL_MS = envInt('AUCTION_SWEEP_INTERVAL_MS', 60_000, 1000);

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

// Live-stream sweep (core/live-sweep.ts): ends streams whose LiveKit room is
// gone and removes per-minute viewers who stopped paying. It lives in this
// process because it is the other fast, time-sensitive loop -- a lapsed
// viewer should be dropped within seconds, not on an hourly cron. Off when
// LiveKit isn't configured (nothing to sweep).
const LIVE_INTERVAL_MS = envInt('LIVE_SWEEP_INTERVAL_MS', 20_000, 1000);
if (livekitConfigured()) {
  (async function liveLoop() {
    for (;;) {
      try { await sweepLive(rooms()); } catch (e) { console.error('live-sweep', e); }
      await new Promise((r) => setTimeout(r, LIVE_INTERVAL_MS));
    }
  })();
}
