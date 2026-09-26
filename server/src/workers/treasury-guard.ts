// Imported by workers/index.ts straight after process-guards and BEFORE any
// worker module: ES modules evaluate in import order, so a throw here stops
// the key-holding process before the deposit indexer, payout worker, hedge
// or burn start their loops.
//
// Refuses to start while TREASURY_ADDRESS names a different wallet from the
// TREASURY_PRIVATE_KEY this process signs with (lib/chain.ts
// treasuryAddressMismatch) -- the state a key rotation leaves behind when the
// runbook's TREASURY_ADDRESS step is skipped (deploy/DEPLOY.md). Running on
// anyway would credit the treasury's own gas top-ups to fans and keep the
// API trusting the old, exposed wallet.
import { treasuryAddressMismatch } from '../lib/chain.js';

const why = treasuryAddressMismatch();
if (why) {
  console.error(`workers: REFUSING TO START -- ${why}`);
  throw new Error(`treasury_address_mismatch: ${why}`);
}
