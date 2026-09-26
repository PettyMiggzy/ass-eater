// THE KEY-LESS WORKERS -- deploy/onlyone-media-workers.service, its own user,
// loading .env only (never .env.workers). Transcode parses untrusted uploads
// with ffmpeg and libvips; broadcast, renewals and auction-close need no
// signing key. Keeping them out of the process that holds TREASURY_PRIVATE_KEY
// and DEPOSIT_MNEMONIC (index.ts) means a parser exploit triggered by an
// uploaded file finds no key to steal.
//
// process-guards MUST stay first (see index.ts).
import './process-guards.js';
// REFUSE to run with a signing secret in the environment -- checked before
// any worker module is loaded, so no upload is ever parsed with the key in
// this process. Logging and carrying on (as this used to) left the exact
// exposure the unit split exists to remove. Static imports would run before
// this check, hence the dynamic import below.
if (process.env.TREASURY_PRIVATE_KEY || process.env.DEPOSIT_MNEMONIC) {
  console.error('SECURITY: REFUSING TO START. TREASURY_PRIVATE_KEY / DEPOSIT_MNEMONIC are set in the MEDIA workers process, which parses untrusted uploads. They belong only in .env.workers, loaded only by onlyone-workers.service (see deploy/DEPLOY.md).');
  process.exit(1);
}
await import('./media-workers.js');
console.log('workers (media, key-less) up');
