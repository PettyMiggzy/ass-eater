// Imported by workers/index.ts straight after treasury-guard and BEFORE any
// worker module (ES modules evaluate in import order), so it runs before the
// deposit indexer, payout worker, hedge or burn start their loops.
//
// TREASURY_SETTLE_ONLY is the key-rotation switch (deploy/DEPLOY.md). A value
// this process does not understand -- 'ture', 'on', a stray quote -- must not
// leave anyone guessing whether the exposed key is still signing: the process
// refuses to start. When the mode is on it says so on its own line, which is
// what the runbook tells the operator to look for in journalctl before going
// on; a switch that is silently ignored looks exactly like one that works.
import { settleOnlyMode } from '../lib/chain.js';

const mode = settleOnlyMode();
if (mode === 'invalid') {
  console.error(`workers: REFUSING TO START -- TREASURY_SETTLE_ONLY is set to an unrecognised value. Use true/1/yes or false/0/no (or remove it), on a line of its own with no inline '# comment'.`);
  throw new Error('treasury_settle_only_invalid');
}
if (mode === 'on') {
  console.error('workers: TREASURY SIGNING PAUSED (settle-only) -- TREASURY_SETTLE_ONLY is on: no payout, swap, approval, nonce-cancel or gas top-up will be signed with the treasury key, and deposit sweeps are paused (funds wait at the deposit addresses).');
} else {
  console.log('workers: treasury signing mode: normal (TREASURY_SETTLE_ONLY off)');
}
