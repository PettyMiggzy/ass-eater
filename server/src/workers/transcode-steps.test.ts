import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { hlsArgs, sanitizeImage, previewArgs, previewSeekSeconds, firstFrameStill } from './transcode-steps.js';
import { checkedImageShape, MAX_FRAMES } from '../lib/image-limits.js';

describe('hlsArgs', () => {
  it('maps audio only when the source has it', () => {
    const silent = hlsArgs('/s', '/h', false);
    expect(silent[silent.indexOf('-var_stream_map') + 1]).toBe('v:0 v:1');
    expect(silent.join(' ')).not.toMatch(/0:a|-c:a/);

    const withAudio = hlsArgs('/s', '/h', true);
    expect(withAudio[withAudio.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0 v:1,a:1');
    expect(withAudio.filter((a) => a === '0:a')).toHaveLength(2);
  });
});

describe('sanitizeImage', () => {
  it('drops EXIF (GPS included) from a JPEG', async () => {
    const withExif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f00' } })
      .jpeg().withExif({ IFD0: { Copyright: 'home-address-marker' } }).toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const clean = await sanitizeImage(withExif, 'image/jpeg');
    const meta = await sharp(clean).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe('jpeg');
    expect(clean.includes(Buffer.from('home-address-marker'))).toBe(false);
  });

  it('keeps the uploaded format', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#0f0' } }).png().toBuffer();
    expect((await sharp(await sanitizeImage(png, 'image/png')).metadata()).format).toBe('png');
  });
});

describe('previewArgs', () => {
  // An animated GIF is sanitized with every frame kept; the preview is ONE
  // JPEG. Without -frames:v 1 the image2 muxer refused frame 2 and every
  // animated GIF upload ended REJECTED.
  it('always asks ffmpeg for exactly one frame, for images and videos', () => {
    for (const a of [previewArgs('/s', '/p.jpg'), previewArgs('/s', '/p.jpg', { seekSeconds: 1 })]) {
      expect(a[a.indexOf('-frames:v') + 1]).toBe('1');
      expect(a.indexOf('-frames:v')).toBeGreaterThan(a.indexOf('-i'));
      expect(a[a.length - 1]).toBe('/p.jpg');
    }
    expect(previewArgs('/s', '/p.jpg', { seekSeconds: 1 }).slice(0, 3)).toEqual(['-y', '-ss', '00:00:01']);
  });
});

describe('previewSeekSeconds', () => {
  it('never seeks past the end of a clip shorter than a second', () => {
    expect(previewSeekSeconds(0.6)).toBeCloseTo(0.3);
    expect(previewArgs('/s', '/p.jpg', { seekSeconds: previewSeekSeconds(0.6) }).slice(0, 3)).toEqual(['-y', '-ss', '0.300']);
  });
  it('seeks 1s into a normal clip, and not at all when the duration is unknown', () => {
    expect(previewSeekSeconds(30)).toBe(1);
    expect(previewSeekSeconds(Number.NaN)).toBe(0);
    expect(previewSeekSeconds(0)).toBe(0);
    expect(previewArgs('/s', '/p.jpg', { seekSeconds: previewSeekSeconds(Number.NaN) })).not.toContain('-ss');
  });
});

// Frames stacked vertically (the layout sharp uses for an animation), each
// with a bar in a different place so no encoder merges them.
async function animation(w: number, h: number, n: number, fmt: 'gif' | 'webp') {
  const buf = Buffer.alloc(w * h * n * 3, 0);
  for (let i = 0; i < n; i++) {
    const x = (i * 7) % w;
    for (let y = 0; y < h; y++) for (let dx = 0; dx < 6 && x + dx < w; dx++) buf[(i * w * h + y * w + x + dx) * 3] = 255;
  }
  const img = sharp(buf, { raw: { width: w, height: h * n, channels: 3, pageHeight: h } as any });
  return fmt === 'gif' ? img.gif().toBuffer() : img.webp().toBuffer();
}

describe('sanitizeImage on animations', () => {
  it('keeps a many-frame GIF whose frames TOTAL over 50M pixels (sharp counts every frame)', async () => {
    // 480x480 x 220 frames = 50.7M pixels: refused outright before.
    const gif = await animation(480, 480, 220, 'gif');
    const out = await sanitizeImage(gif, 'image/gif');
    const meta = await sharp(out, { animated: true }).metadata();
    expect([meta.format, meta.pages, meta.pageHeight]).toEqual(['gif', 220, 480]);
  }, 60_000);

  it('keeps an animated WebP animated (it used to be flattened to frame 1, in place)', async () => {
    const webp = await animation(64, 48, 4, 'webp');
    expect((await sharp(webp, { animated: true }).metadata()).pages).toBe(4);
    const out = await sanitizeImage(webp, 'image/webp');
    const meta = await sharp(out, { animated: true }).metadata();
    expect([meta.format, meta.pages, meta.pageHeight]).toEqual(['webp', 4, 48]);
    // ...and its blurred preview is taken from a still of frame 1, which
    // ffmpeg can read (it cannot decode an animated WebP).
    const still = await sharp(await firstFrameStill(out)).metadata();
    expect([still.format, still.width, still.height, still.pages ?? 1]).toEqual(['png', 64, 48, 1]);
  });

  it('still refuses a per-frame decompression bomb and an absurd frame count', async () => {
    await expect(checkedImageShape(await animation(8, 8, MAX_FRAMES + 1, 'gif'))).rejects.toThrow('image_too_many_frames');
    const header = await sharp({ create: { width: 10_000, height: 6_000, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
    await expect(sanitizeImage(header, 'image/png')).rejects.toThrow('image_too_many_pixels');
  });
});
