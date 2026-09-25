// THE KEY-HOLDING WORKERS: the only process that loads .env.workers
// (TREASURY_PRIVATE_KEY, DEPOSIT_MNEMONIC) -- deploy/onlyone-workers.service.
// Nothing here parses user-supplied files. Everything that does (transcode:
// ffmpeg and libvips over any bridged account's uploads, the largest
// memory-unsafe attack surface in the stack) and everything that needs no key
// (broadcast, renewals, auction-close) runs in media.ts, a separate unit and
// user with no access to the signing secrets -- a parser exploit there must
// not land in a process holding the hot wallet key.
//
// process-guards MUST stay first: it installs the unhandledRejection handler
// before any worker module starts its loops.
import './process-guards.js';
import { warnSecretShape } from '../lib/chain.js';
import './deposit-indexer.js'; import './payout-worker.js'; import './treasury-hedge.js';
// Gated on TOKEN_BURN_AUTOMATIC=true inside the module; importing it is what
// makes that switch do anything at all (it used to be compiled and orphaned).
import './token-burn.js';
// A malformed secret (e.g. an inline '# comment' systemd kept as part of
// the value) otherwise shows up only as every payout refunding and every
// sweep failing. Names only are logged, never values.
warnSecretShape();
console.log('workers (key-holding) up');
