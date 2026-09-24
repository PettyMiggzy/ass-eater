import type { Worker } from 'bullmq';
import { warnLegacyEnv } from '../lib/chain.js';

/**
 * Imported first by workers/index.ts, before any worker module.
 *
 * Every worker (deposits, payouts, renewals, transcode, broadcast, hedge,
 * auction-close, burn) shares this one Node process. Under Node 22's default
 * --unhandled-rejections=throw, one stray rejected promise in any of them --
 * an RPC blip during a worker's startup, say -- killed the process and every
 * unrelated worker with it, and systemd's 3-second restart turned a
 * 20-minute RPC outage into 20 minutes of no renewals, no auction closes and
 * payouts interrupted mid-flight. A worker's own bug should be logged and
 * contained to that worker, not become everyone's outage.
 *
 * uncaughtException is deliberately NOT swallowed: after a synchronous throw
 * the process state is unknown, and restarting is the right answer.
 */
process.on('unhandledRejection', (reason) => {
  console.error('workers: unhandled promise rejection (process kept alive)', reason);
});

warnLegacyEnv();

/**
 * Graceful stop. systemd sends SIGTERM on every redeploy (app-setup.sh
 * restarts this unit); without a handler the process died mid-job, and a
 * payout waiting for its confirmations was abandoned in PROCESSING. Each
 * BullMQ Worker is closed, which stops it taking new jobs and waits for the
 * active ones to finish (onlyone-workers.service allows long enough for a
 * payout's receipt wait). Anything still interrupted is picked up by the
 * payout reconciler (workers/payout-worker.ts) on the next start.
 */
const workers: Worker[] = [];
const stopHooks: (() => void)[] = [];
export function registerWorker<T extends Worker>(w: T): T {
  workers.push(w);
  return w;
}
/** For interval loops (reconcilers, sweeps) that should stop taking new work on SIGTERM. */
export function onStop(fn: () => void) { stopHooks.push(fn); }
let stopping = false;
export const isStopping = () => stopping;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`workers: ${signal}, draining ${workers.length} workers`);
  for (const fn of stopHooks) { try { fn(); } catch { /* best effort */ } }
  await Promise.allSettled(workers.map((w) => w.close()));
  console.log('workers: drained, exiting');
  process.exit(0);
}
process.once('SIGTERM', () => { void stop('SIGTERM'); });
process.once('SIGINT', () => { void stop('SIGINT'); });
