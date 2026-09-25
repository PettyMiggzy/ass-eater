import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdnSignedUrl, cdnPreviewUrlOrNull, objectExists, s3 } from './s3.js';

afterEach(() => { vi.restoreAllMocks(); delete process.env.BUNNY_CDN_HOST; delete process.env.BUNNY_TOKEN_KEY; });

describe('cdnSignedUrl', () => {
  it('puts an HLS directory token in the PATH so relative playlist/segment URLs inherit it', () => {
    process.env.BUNNY_CDN_HOST = 'cdn.example.com'; process.env.BUNNY_TOKEN_KEY = 'k';
    const url = cdnSignedUrl('/media/o/m/hls/master.m3u8', 900, '/media/o/m/hls/');
    expect(url).toMatch(/^https:\/\/cdn\.example\.com\/bcdn_token=[A-Za-z0-9_-]+&token_path=%2Fmedia%2Fo%2Fm%2Fhls%2F&expires=\d+\/media\/o\/m\/hls\/master\.m3u8$/);
    expect(url).not.toContain('?');
    // A relative segment reference resolves inside the signed path.
    expect(new URL('p0.m3u8', url).pathname).toMatch(/^\/bcdn_token=.*\/media\/o\/m\/hls\/p0\.m3u8$/);
  });

  it('keeps the query-string token for a single file', () => {
    process.env.BUNNY_CDN_HOST = 'cdn.example.com'; process.env.BUNNY_TOKEN_KEY = 'k';
    expect(cdnSignedUrl('/raw/u/x', 900)).toMatch(/^https:\/\/cdn\.example\.com\/raw\/u\/x\?token=[A-Za-z0-9_-]+&expires=\d+$/);
  });

  it('throws instead of building https://undefined/...', () => {
    process.env.BUNNY_TOKEN_KEY = 'k';
    expect(() => cdnSignedUrl('/x')).toThrow(/BUNNY_CDN_HOST/);
  });
});

describe('cdnPreviewUrlOrNull', () => {
  it('signs the blurred preview when the pull zone has Token Authentication (a token key is set)', () => {
    process.env.BUNNY_CDN_HOST = 'cdn.example.com'; process.env.BUNNY_TOKEN_KEY = 'k';
    expect(cdnPreviewUrlOrNull('/media/o/m/preview.jpg')).toMatch(/^https:\/\/cdn\.example\.com\/media\/o\/m\/preview\.jpg\?token=[A-Za-z0-9_-]+&expires=\d+$/);
  });
  it('is null with no CDN host, and unsigned only when there is no token key to sign with', () => {
    expect(cdnPreviewUrlOrNull('/p.jpg')).toBeNull();
    process.env.BUNNY_CDN_HOST = 'cdn.example.com';
    expect(cdnPreviewUrlOrNull('/p.jpg')).toBe('https://cdn.example.com/p.jpg');
  });
});

describe('objectExists', () => {
  it('uses HEAD, and only a real not-found means missing', async () => {
    const send = vi.spyOn(s3, 'send');
    send.mockResolvedValueOnce({} as never);
    expect(await objectExists('a')).toBe(true);
    expect((send.mock.calls[0][0] as any).constructor.name).toBe('HeadObjectCommand');

    send.mockRejectedValueOnce(Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }) as never);
    expect(await objectExists('b')).toBe(false);

    send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }) as never);
    await expect(objectExists('c')).rejects.toThrow('denied');
  });
});
