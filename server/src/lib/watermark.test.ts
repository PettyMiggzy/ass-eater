import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { watermarkImage, watermarkFormat } from './watermark.js';

// A paid animated GIF used to be watermarked from frame 1 only and re-encoded
// as a JPEG, so every non-owner viewer got a still. It must stay animated.

async function animatedGif(frames: number, w = 64, h = 48) {
  // Frames stacked vertically, one colour each -- the layout sharp uses for
  // an animated image -- then encoded as a multi-page GIF.
  const pages = await Promise.all(Array.from({ length: frames }, (_, i) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: 40 * i, g: 100, b: 200 - 40 * i } } }).png().toBuffer()));
  const raw = await sharp({ create: { width: w, height: h * frames, channels: 3, background: '#000' } })
    .composite(pages.map((input, i) => ({ input, top: i * h, left: 0 })))
    .raw().toBuffer();
  return sharp(raw, { raw: { width: w, height: h * frames, channels: 3, pageHeight: h } as any }).gif().toBuffer();
}

describe('watermarkImage', () => {
  it('keeps every frame of an animated GIF and returns a GIF', async () => {
    const src = await animatedGif(3);
    expect((await sharp(src, { animated: true }).metadata()).pages).toBe(3);
    const out = await watermarkImage(src, 'fan_1 · abcd1234', 'image/gif');
    const meta = await sharp(out, { animated: true }).metadata();
    expect(meta.format).toBe('gif');
    expect(meta.pages).toBe(3);
    expect(meta.pageHeight).toBe(48);
    expect(watermarkFormat('image/gif')).toEqual({ ext: 'gif', contentType: 'image/gif' });
  });

  it('still returns a JPEG for a photo', async () => {
    const src = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#888' } }).jpeg().toBuffer();
    const out = await watermarkImage(src, 'fan_1 · abcd1234', 'image/jpeg');
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([80, 60]);
    expect(watermarkFormat('image/png').ext).toBe('jpg');
  });
});
