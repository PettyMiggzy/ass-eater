import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { redis, sub, subscribeChannel, channelListenerCount } from './redis';

afterAll(async () => { sub.disconnect(); redis.disconnect(); });

const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

describe('subscribeChannel -- reference-counted Redis subscriptions', () => {
  it("closing one listener does not silence the others on the same channel", async () => {
    const ch = `u:test:${randomUUID()}`;
    const a: string[] = [], b: string[] = [];
    const releaseA = await subscribeChannel(ch, (m) => a.push(m));
    const releaseB = await subscribeChannel(ch, (m) => b.push(m));
    expect(channelListenerCount(ch)).toBe(2);

    await releaseA();                                  // e.g. the phone tab closes
    expect(channelListenerCount(ch)).toBe(1);
    await redis.publish(ch, 'after-close');
    await until(() => b.length > 0);
    expect(b).toEqual(['after-close']);                // the laptop still receives
    expect(a).toEqual([]);

    await releaseB();
    await releaseB();                                  // idempotent
    expect(channelListenerCount(ch)).toBe(0);
    await redis.publish(ch, 'nobody');
    await new Promise((r) => setTimeout(r, 100));
    expect(b).toEqual(['after-close']);
  });

  it('resubscribes cleanly after the last listener left', async () => {
    const ch = `u:test:${randomUUID()}`;
    const first = await subscribeChannel(ch, () => {});
    await first();
    const got: string[] = [];
    const again = await subscribeChannel(ch, (m) => got.push(m));
    await redis.publish(ch, 'x');
    await until(() => got.length > 0);
    expect(got).toEqual(['x']);
    await again();
  });

  it('a listener joining while the first SUBSCRIBE is in flight shares its outcome', async () => {
    const ch = `u:test:${randomUUID()}`;
    const spy = vi.spyOn(sub, 'subscribe').mockRejectedValueOnce(new Error('redis down'));
    const results = await Promise.allSettled([subscribeChannel(ch, () => {}), subscribeChannel(ch, () => {})]);
    spy.mockRestore();
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(channelListenerCount(ch)).toBe(0);          // nothing half-registered

    // ...so the next listener really SUBSCRIBEs, and two concurrent ones both receive.
    const a: string[] = [], b: string[] = [];
    const [ra, rb] = await Promise.all([subscribeChannel(ch, (m) => a.push(m)), subscribeChannel(ch, (m) => b.push(m))]);
    await redis.publish(ch, 'ok');
    await until(() => a.length > 0 && b.length > 0);
    expect([a, b]).toEqual([['ok'], ['ok']]);
    await ra(); await rb();
    expect(channelListenerCount(ch)).toBe(0);
  });
});
