import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
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

/**
 * Bunny CDN Token Authentication. For HLS, pass `dir` so every .ts/.m4s segment under it is covered.
 * Algorithm: base64url(sha256(key + signedPath + expires [+ "token_path=" + dir])) — mirrors Bunny's reference impl.
 */
export function cdnSignedUrl(path: string, ttlSec = 600, dir?: string) {
  const key = process.env.BUNNY_TOKEN_KEY!;
  const host = process.env.BUNNY_CDN_HOST!;
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  const signedPath = dir ?? path;
  const base = key + signedPath + expires + (dir ? `token_path=${dir}` : '');
  const token = createHash('sha256').update(base).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const q = `token=${token}&expires=${expires}` + (dir ? `&token_path=${encodeURIComponent(dir)}` : '');
  return `https://${host}${path}?${q}`;
}

/** Public, unsigned URL for blurred previews / avatars */
export const cdnPublicUrl = (path: string) => `https://${process.env.BUNNY_CDN_HOST}${path}`;
