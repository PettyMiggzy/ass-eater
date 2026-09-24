import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { hlsArgs, sanitizeImage } from './transcode-steps.js';

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
