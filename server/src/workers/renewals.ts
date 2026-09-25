import { Worker } from 'bullmq';
import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { charge, money, InsufficientFunds } from '../core/ledger.js';
import { renewalQueue, publish, connection, redis } from '../lib/redis.js';
import { PERIOD_MS } from '../modules/subscriptions.js';
import { registerWorker } from './process-guards.js';
import { CREATOR_STANDING_SELECT } from '../core/creator-standing.js';
import { renewalShouldExpire } from '../core/renewal-policy.js';
import { liftLapsedSiteSuspensions } from '../lib/bridge.js';

await renewalQueue.add('tick', {}, { repeat: { every: 5 * 60_000 }, jobId: 'renewals-tick', removeOnComplete: true });

// Raised when the row's period was already advanced by someone else between our
// read and our write. Thrown from inside money(), so the charge that would have
// been the second one for the same period rolls back with it.
class AlreadyRenewed extends Error {}

const TICK_LOCK = 'renewals:tick';
const TICK_LOCK_MS = 15 * 60_000;
// Release only if we still hold it -- a tick that overran the TTL must not
// delete the lock a later tick has since taken.
const RELEASE_LOCK = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

registerWorker(new Worker('renewals', async () => {
  // Only one tick runs at a time across every worker instance. BullMQ hands a
  // stalled job to a second worker, and nothing stops a second worker process
  // existing at all, so without this two runs can pick up the same due rows.
  // This is the cheap guard; the per-row claim below is what actually makes a
  // double charge impossible if this lock ever expires mid-tick.
  const held = randomUUID();
  if (!(await redis.set(TICK_LOCK, held, 'PX', TICK_LOCK_MS, 'NX'))) return;
  try {
    // Site suspensions that have lapsed by themselves are lifted first, so a
    // creator whose 30-day suspension just ended is payable again in this
    // same tick (lib/bridge.ts). Its own failure must not stop renewals.
    try { await liftLapsedSiteSuspensions(); } catch (e) { console.error('renewals: lifting lapsed site suspensions failed', e); }
    // Which due rows are expired rather than charged: core/renewal-policy.ts
    // (creator must still be payable -- not suspended/banned AND approved --
    // and the FAN must be ACTIVE, since a suspended/banned fan cannot reach
    // DELETE /subscriptions to stop renewing). The fan keeps the access they
    // already paid for until the period they paid for ended.
    const due = await prisma.subscription.findMany({ where: { currentPeriodEnd: { lt: new Date() }, status: { in: ['ACTIVE', 'CANCELLED'] } }, take: 500, include: { creator: { select: CREATOR_STANDING_SELECT }, fan: { select: { status: true } } } });
    for (const s of due) {
      if (renewalShouldExpire(s)) {
        // Expire against the same snapshot the decision was made from, not by id
        // alone. `due` is read up to 500 rows earlier, and a fan who re-subscribed
        // (and paid) in between has a brand-new ACTIVE period sitting in this row
        // -- stamping EXPIRED over it revokes access they just bought, and the due
        // query above never picks EXPIRED rows back up, so it never self-heals.
        await prisma.subscription.updateMany({ where: { id: s.id, status: s.status, currentPeriodEnd: s.currentPeriodEnd }, data: { status: 'EXPIRED' } }); continue;
      }
      try {
        await money(prisma, async (tx) => {
          // Claim the period before charging for it: this only matches while the
          // row still shows the period end (and status) we read, so a racing tick
          // that already renewed it claims nothing and we roll back without ever
          // touching the fan's balance. Idempotency lives here, in the database,
          // not in how the job happens to be scheduled.
          const claimed = await tx.subscription.updateMany({
            where: { id: s.id, status: s.status, currentPeriodEnd: s.currentPeriodEnd },
            data: { currentPeriodEnd: new Date(Math.max(s.currentPeriodEnd.getTime(), Date.now()) + PERIOD_MS) },
          });
          if (!claimed.count) throw new AlreadyRenewed();
          await charge(tx, { fanId: s.fanId, creatorId: s.creatorId, grossCents: s.priceCents, type: 'SUBSCRIPTION', refId: s.id });
        });
        await publish(s.fanId, { type: 'renewed', creatorId: s.creatorId, amountCents: s.priceCents });
      } catch (e) {
        if (e instanceof AlreadyRenewed) continue;
        if (e instanceof InsufficientFunds) {
          // Same snapshot guard as above -- the charge rolled the claim back, so
          // the row should still look exactly as it was read unless someone
          // renewed it meanwhile. Only tell the fan it failed if we really did
          // expire the period we read; otherwise the notice is about a period
          // that no longer exists.
          const expired = await prisma.subscription.updateMany({ where: { id: s.id, status: s.status, currentPeriodEnd: s.currentPeriodEnd }, data: { status: 'EXPIRED' } });
          if (expired.count) await publish(s.fanId, { type: 'renewal_failed', creatorId: s.creatorId, reason: 'insufficient_funds' });
        } else console.error('renewal', s.id, e);
      }
    }

    // Token-lock perks renew the same way -- see modules/stake.ts
    const dueLocks = await prisma.tokenLock.findMany({ where: { currentPeriodEnd: { lt: new Date() }, status: { in: ['ACTIVE', 'CANCELLED'] } }, take: 500, include: { creator: { select: { ...CREATOR_STANDING_SELECT, creator: { select: { stakePerkEnabled: true } } } }, fan: { select: { status: true } } } });
    for (const l of dueLocks) {
      if (renewalShouldExpire({ ...l, perkEnabled: !!l.creator.creator?.stakePerkEnabled })) {
        // Snapshot-guarded for the same reason the subscription loop above is.
        await prisma.tokenLock.updateMany({ where: { id: l.id, status: l.status, currentPeriodEnd: l.currentPeriodEnd }, data: { status: 'EXPIRED' } }); continue;
      }
      try {
        await money(prisma, async (tx) => {
          const claimed = await tx.tokenLock.updateMany({
            where: { id: l.id, status: l.status, currentPeriodEnd: l.currentPeriodEnd },
            data: { currentPeriodEnd: new Date(Math.max(l.currentPeriodEnd.getTime(), Date.now()) + PERIOD_MS) },
          });
          if (!claimed.count) throw new AlreadyRenewed();
          await charge(tx, { fanId: l.fanId, creatorId: l.creatorId, grossCents: l.usdCents, type: 'TOKEN_LOCK', refId: l.id });
        });
        await publish(l.fanId, { type: 'lock_renewed', creatorId: l.creatorId, amountCents: l.usdCents });
      } catch (e) {
        if (e instanceof AlreadyRenewed) continue;
        if (e instanceof InsufficientFunds) {
          const expired = await prisma.tokenLock.updateMany({ where: { id: l.id, status: l.status, currentPeriodEnd: l.currentPeriodEnd }, data: { status: 'EXPIRED' } });
          if (expired.count) await publish(l.fanId, { type: 'lock_renewal_failed', creatorId: l.creatorId, reason: 'insufficient_funds' });
        } else console.error('lock renewal', l.id, e);
      }
    }
  } finally {
    await redis.eval(RELEASE_LOCK, 1, TICK_LOCK, held);
  }
}, { ...connection, concurrency: 1 }));
