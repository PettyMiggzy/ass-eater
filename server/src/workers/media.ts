// THE KEY-LESS WORKERS -- deploy/onlyone-media-workers.service, its own user,
// loading .env only (never .env.workers). Transcode parses untrusted uploads
// with ffmpeg and libvips; broadcast, renewals and auction-close need no
// signing key. Keeping them out of the process that holds TREASURY_PRIVATE_KEY
// and DEPOSIT_MNEMONIC (index.ts) means a parser exploit triggered by an
// uploaded file finds no key to steal.
//
// process-guards MUST stay first (see index.ts).
import './process-guards.js';
import './transcode.js'; import './broadcast.js'; import './renewals.js'; import './auction-close.js';
if (process.env.TREASURY_PRIVATE_KEY || process.env.DEPOSIT_MNEMONIC) {
  console.error('SECURITY: TREASURY_PRIVATE_KEY / DEPOSIT_MNEMONIC are set in the MEDIA workers process, which parses untrusted uploads. They belong only in .env.workers, loaded only by onlyone-workers.service.');
}
console.log('workers (media, key-less) up');
