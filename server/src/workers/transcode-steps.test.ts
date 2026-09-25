import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { hlsArgs, sanitizeImage, previewArgs, previewSeekSeconds } from './transcode-steps.js';

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
