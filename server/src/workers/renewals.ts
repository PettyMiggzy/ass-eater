import { Worker } from 'bullmq';
import { prisma } from '../lib/prisma';
import { charge, money, InsufficientFunds } from '../core/ledger';
import { renewalQueue, publish, connection } from '../lib/redis';
import { PERIOD_MS } from '../modules/subscriptions';

await renewalQueue.add('tick', {}, { repeat: { every: 5 * 60_000 }, jobId: 'renewals-tick', removeOnComplete: true });

new Worker('renewals', async () => {
  const due = await prisma.subscription.findMany({ where: { currentPeriodEnd: { lt: new Date() }, status: { in: ['ACTIVE', 'CANCELLED'] } }, take: 500, include: { creator: { select: { status: true } } } });
  for (const s of due) {
    if (!s.autoRenew || s.status === 'CANCELLED' || s.creator.status !== 'ACTIVE') {
      await prisma.subscription.update({ where: { id: s.id }, data: { status: 'EXPIRED' } }); continue;
    }
    try {
      await money(prisma, async (tx) => {
        await charge(tx, { fanId: s.fanId, creatorId: s.creatorId, grossCents: s.priceCents, type: 'SUBSCRIPTION', refId: s.id });
        await tx.subscription.update({ where: { id: s.id }, data: { currentPeriodEnd: new Date(Math.max(s.currentPeriodEnd.getTime(), Date.now()) + PERIOD_MS) } });
      });
      await publish(s.fanId, { type: 'renewed', creatorId: s.creatorId, amountCents: s.priceCents });
    } catch (e) {
      if (e instanceof InsufficientFunds) {
        await prisma.subscription.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
        await publish(s.fanId, { type: 'renewal_failed', creatorId: s.creatorId, reason: 'insufficient_funds' });
      } else console.error('renewal', s.id, e);
    }
  }
}, { ...connection, concurrency: 1 });
