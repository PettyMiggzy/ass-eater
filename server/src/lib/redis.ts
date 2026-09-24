import { Redis } from 'ioredis';
import { Queue } from 'bullmq';

export const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
export const connection = { connection: redis };

export const transcodeQueue = new Queue('transcode', connection);
export const payoutQueue = new Queue('payout', connection);
export const sweepQueue = new Queue('sweep', connection);
export const renewalQueue = new Queue('renewals', connection);
export const broadcastQueue = new Queue('broadcast', connection);

// realtime fan-out (messages, tips, live events)
export const pub = redis;
export const sub = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
export const publish = (userId: string, event: object) => pub.publish(`u:${userId}`, JSON.stringify(event));

// Reference-counted channel subscriptions on the one shared `sub`
// connection. Redis subscriptions belong to the CONNECTION, not to a
// listener, so the old per-socket `sub.subscribe(ch)` / `sub.unsubscribe(ch)`
// meant the first socket on a channel to close unsubscribed it for every
// other socket on it -- a creator's second device, or every other viewer of a
// stream's tip overlay. Here a channel is SUBSCRIBEd when its first listener
// arrives and UNSUBSCRIBEd only when its last one leaves, and one 'message'
// handler dispatches to all of them (instead of one handler per socket, which
// also tripped Node's MaxListeners warning past ten sockets).
//
// Commands on one ioredis connection are sent in order, so an UNSUBSCRIBE for
// a channel whose last listener just left and a SUBSCRIBE from a listener
// that arrives a moment later reach Redis in that order and end subscribed.
//
// Every listener awaits the SAME in-flight SUBSCRIBE (`ready`), not just the
// first one: a second socket arriving while the first SUBSCRIBE is still on
// the wire must not return "subscribed" before Redis has said so. If that
// SUBSCRIBE fails, the whole entry is dropped and every waiter is rejected,
// so no listener is left registered on a channel nothing is subscribed to
// (which would make every later listener skip the SUBSCRIBE too).
type ChannelEntry = { listeners: Set<(message: string) => void>; ready: Promise<void> };
const channels = new Map<string, ChannelEntry>();
let dispatcherInstalled = false;

export async function subscribeChannel(channel: string, listener: (message: string) => void): Promise<() => Promise<void>> {
  if (!dispatcherInstalled) {
    dispatcherInstalled = true;
    sub.on('message', (ch: string, message: string) => {
      const entry = channels.get(ch);
      if (!entry) return;
      for (const fn of [...entry.listeners]) {
        try { fn(message); } catch { /* one broken socket must not starve the rest */ }
      }
    });
  }
  let entry = channels.get(channel);
  if (!entry) {
    const created: ChannelEntry = { listeners: new Set(), ready: Promise.resolve() };
    created.ready = sub.subscribe(channel).then(
      () => undefined,
      (err) => {
        if (channels.get(channel) === created) channels.delete(channel);
        created.listeners.clear();
        throw err;
      },
    );
    channels.set(channel, created);
    entry = created;
  }
  const mine = entry;
  mine.listeners.add(listener);
  // Rejects (for this caller and every concurrent one) if the SUBSCRIBE
  // failed; the entry is already gone, so the next caller retries it.
  await mine.ready;

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (channels.get(channel) !== mine) return;
    mine.listeners.delete(listener);
    if (mine.listeners.size === 0) {
      channels.delete(channel);
      await sub.unsubscribe(channel);
    }
  };
}

/** Test/diagnostic helper: how many live listeners a channel has. */
export const channelListenerCount = (channel: string) => channels.get(channel)?.listeners.size ?? 0;
