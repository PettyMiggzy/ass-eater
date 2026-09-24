// process-guards MUST stay first: it installs the unhandledRejection handler
// before any worker module starts its loops.
import './process-guards.js';
import './deposit-indexer.js'; import './payout-worker.js'; import './renewals.js'; import './transcode.js'; import './broadcast.js'; import './treasury-hedge.js'; import './auction-close.js';
// Gated on TOKEN_BURN_AUTOMATIC=true inside the module; importing it is what
// makes that switch do anything at all (it used to be compiled and orphaned).
import './token-burn.js';
console.log('workers up');
