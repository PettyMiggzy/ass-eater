import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'crypto';

export const s3 = new S3Client({
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: !!process.env.S3_FORCE_PATH_STYLE,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
});
export const BUCKET = process.env.S3_BUCKET!;

export const presignPut = (Key: string, ContentType: string, ContentLength: number) =>
  getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key, ContentType, ContentLength }), { expiresIn: 900 });

export const presignGet = (Key: string, ttl = 300) =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key }), { expiresIn: ttl });

export const headObject = (Key: string) => s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
export const deleteObject = (Key: string) => s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }));

/** True for an S3 "no such key" answer (HEAD reports it as NotFound/404, GET as NoSuchKey). */
export function isNotFound(e: any): boolean {
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Does `Key` exist? HEAD, never GET: a GetObject response body is a live
 * stream holding its pooled socket until read or destroyed, and the SDK's
 * pool is 50 sockets. Only a real not-found answers false; any other failure
 * (403, throttling, an outage) is thrown rather than mistaken for "missing".
 */
export async function objectExists(Key: string): Promise<boolean> {
  try { await headObject(Key); return true; }
  catch (e) { if (isNotFound(e)) return false; throw e; }
}

/** Deletes every object under `prefix` (which should end in '/'). Returns how many went. */
export async function deletePrefix(prefix: string): Promise<number> {
  if (!prefix || !prefix.endsWith('/')) throw new Error(`deletePrefix: refusing unterminated prefix "${prefix}"`);
  let token: string | undefined; let n = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    const keys = (page.Contents ?? []).map((o) => o.Key!).filter(Boolean);
    if (keys.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
      n += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return n;
}

function cdnHost(): string {
  const host = process.env.BUNNY_CDN_HOST;
  // Without this, every URL came out as https://undefined/... and failed in
  // the browser instead of here.
  if (!host) throw new Error('BUNNY_CDN_HOST is not set');
  return host;
}

/**
 * Bunny CDN Token Authentication. Algorithm (Bunny's reference impl):
 * base64url(sha256(key + signedPath + expires [+ "token_path=" + dir])).
 *
 * For a single file the token rides in the query string. For HLS, pass `dir`:
 * the token then goes IN THE PATH (/bcdn_token=...&token_path=...&expires=.../file),
 * Bunny's directory-token form. That is not cosmetic. The playlists reference
 * their variants and segments by relative URL, and a player resolves those
 * against the playlist URL WITHOUT its query string (RFC 3986) -- so with a
 * query-string token every request after master.m3u8 went out unsigned and
 * was refused. A path-embedded token is inherited by every relative URL
 * under it.
 */
export function cdnSignedUrl(path: string, ttlSec = 600, dir?: string) {
  const key = process.env.BUNNY_TOKEN_KEY;
  if (!key) throw new Error('BUNNY_TOKEN_KEY is not set');
  const host = cdnHost();
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  const signedPath = dir ?? path;
  const base = key + signedPath + expires + (dir ? `token_path=${dir}` : '');
  const token = createHash('sha256').update(base).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (dir) return `https://${host}/bcdn_token=${token}&token_path=${encodeURIComponent(dir)}&expires=${expires}${path}`;
  return `https://${host}${path}?token=${token}&expires=${expires}`;
}

/** Unsigned URL -- only valid on a pull zone WITHOUT Token Authentication. */
export const cdnPublicUrl = (path: string) => `https://${cdnHost()}${path}`;

/** How long a blurred preview URL stays valid. Longer than a media URL: it is a teaser, not the content. */
export const PREVIEW_URL_TTL_SEC = 6 * 3600;

/**
 * URL for an OPTIONAL extra (a blurred preview on a refusal): null when no
 * CDN is configured, so a missing BUNNY_CDN_HOST cannot turn a 403 into a 500.
 *
 * Signed whenever BUNNY_TOKEN_KEY is set. Bunny's Token Authentication is a
 * pull-zone-wide switch, and the deploy kit turns it on (.env.example), so an
 * unsigned https://<host>/<previewKey> was refused by the CDN and every
 * paywall showed a broken image instead of its teaser. Unsigned only when no
 * token key exists, i.e. the zone has no token auth to satisfy.
 */
export const cdnPreviewUrlOrNull = (path: string) => {
  if (!process.env.BUNNY_CDN_HOST) return null;
  return process.env.BUNNY_TOKEN_KEY ? cdnSignedUrl(path, PREVIEW_URL_TTL_SEC) : cdnPublicUrl(path);
};

/**
 * Best-effort Bunny cache purge for everything under `path` (wildcard). A
 * takedown that deletes the origin still leaves copies at the edge until
 * they expire; this evicts them. Needs BUNNY_API_KEY (the account API key,
 * not the token-auth key). Returns false when it could not purge, so the
 * caller can report it rather than claim the content is gone everywhere.
 */
export async function purgeCdnPrefix(path: string): Promise<boolean> {
  const apiKey = process.env.BUNNY_API_KEY;
  const host = process.env.BUNNY_CDN_HOST;
  if (!apiKey || !host) return false;
  try {
    const url = `https://${host}${path}*`;
    const r = await fetch(`https://api.bunny.net/purge?url=${encodeURIComponent(url)}&async=false`, {
      method: 'POST', headers: { AccessKey: apiKey },
    });
    return r.ok;
  } catch {
    return false;
  }
}
