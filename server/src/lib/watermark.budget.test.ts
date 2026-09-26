import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// The API-side watermark budget (lib/watermark.ts): output is downscaled,
// concurrent requests for one copy share a single generation, and only a
// bounded number run at once.

const puts: string[] = [];
let gets = 0;
let stored = new Set<string>();
let source: Buffer = Buffer.alloc(0);
let release: (() => void) | null = null;
vi.mock('./s3.js', () => ({
  BUCKET: 'test',
  objectExists: vi.fn(async (k: string) => stored.has(k)),
  s3: {
    send: vi.fn(async (cmd: any) => {
      const name = cmd?.constructor?.name;
      if (name === 'GetObjectCommand') {
        gets++;
        if (release === null) await new Promise<void>((r) => { release = r; });
        return { Body: { transformToByteArray: async () => new Uint8Array(source) } };
      }
      if (name === 'PutObjectCommand') { puts.push(cmd.input.Key); stored.add(cmd.input.Key); return {}; }
      throw new Error('unexpected command ' + name);
    }),
  },
}));
const { watermarkImage, getOrCreateWatermarkedUrl, WM_MAX_EDGE, _watermarkLoad } = await import('./watermark.js');

describe('watermark budget', () => {
  it('downscales a large still to the API long-edge budget', async () => {
    const big = await sharp({ create: { width: 6000, height: 4000, channels: 3, background: '#445566' } }).jpeg().toBuffer();
    const out = await watermarkImage(big, 'fan · abcd1234', 'image/jpeg');
    const m = await sharp(out).metadata();
    expect(Math.max(m.width!, m.height!)).toBe(WM_MAX_EDGE);
    expect(m.width! / m.height!).toBeCloseTo(1.5, 2);
  });

  it('concurrent requests for the same copy share ONE generation', async () => {
    source = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000' } }).jpeg().toBuffer();
    stored = new Set(); puts.length = 0; gets = 0; release = null;
    const reqs = Array.from({ length: 5 }, () => getOrCreateWatermarkedUrl('root-1', 'raw/x', 'viewer-1', 'fan'));
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(_watermarkLoad()).toMatchObject({ running: 1, inFlight: 1 });
    release!();
    const keys = await Promise.all(reqs);
    expect(new Set(keys).size).toBe(1);
    expect(gets).toBe(1);
    expect(puts).toHaveLength(1);
    expect(_watermarkLoad()).toMatchObject({ running: 0, waiting: 0, inFlight: 0 });
  });

  it('different copies queue behind one slot, and past the wait limit are refused busy', async () => {
    stored = new Set(); puts.length = 0; gets = 0; release = null;
    const reqs = Array.from({ length: 18 }, (_, i) => getOrCreateWatermarkedUrl('root-2', 'raw/y', `viewer-${i}`, 'fan').then(() => 'ok', (e) => e.message));
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(_watermarkLoad()).toMatchObject({ running: 1, waiting: 16 });
    // Every later GET resolves immediately.
    const r = release!; release = () => {}; r();
    const results = await Promise.all(reqs);
    expect(results.filter((x) => x === 'watermark_busy')).toHaveLength(1);
    expect(results.filter((x) => x === 'ok')).toHaveLength(17);
    expect(_watermarkLoad()).toMatchObject({ running: 0, waiting: 0, inFlight: 0 });
  });
});
