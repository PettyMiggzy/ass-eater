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
