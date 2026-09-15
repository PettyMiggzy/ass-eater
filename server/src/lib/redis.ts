import IORedis from 'ioredis';
import { Queue } from 'bullmq';

export const redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
export const connection = { connection: redis };

export const transcodeQueue = new Queue('transcode', connection);
export const payoutQueue = new Queue('payout', connection);
export const sweepQueue = new Queue('sweep', connection);
export const renewalQueue = new Queue('renewals', connection);
export const broadcastQueue = new Queue('broadcast', connection);

// realtime fan-out (messages, tips, live events)
export const pub = redis;
export const sub = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
export const publish = (userId: string, event: object) => pub.publish(`u:${userId}`, JSON.stringify(event));
