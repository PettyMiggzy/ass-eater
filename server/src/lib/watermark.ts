import sharp from 'sharp';
import { createHash } from 'crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET } from './s3';

// Leak-deterrent watermark: a tiled, semi-transparent mark burned into the
// pixels themselves, showing the viewer's username and a short code that
// maps back to (mediaId, viewerId) if someone reports a leaked screenshot.
// This is a VISIBLE mark, not invisible/frequency-domain steganography --
// it survives screenshots, re-encoding, and most crops (it's tiled), but a
// determined viewer who crops tightly enough could still remove all of it.
// True forensic (invisible) video/image watermarking needs a dedicated
// vendor (e.g. NexGuard, Verimatrix) -- out of scope here.

export function traceCode(mediaId: string, viewerId: string) {
  return createHash('sha256').update(`${mediaId}:${viewerId}`).digest('hex').slice(0, 8);
}

async function tile(width: number, height: number, label: string) {
  const cell = 260;
  const cols = Math.ceil(width / cell) + 1, rows = Math.ceil(height / cell) + 1;
  let marks = '';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    marks += `<text x="${c * cell}" y="${r * cell + 40}" transform="rotate(-30 ${c * cell} ${r * cell + 40})"
      font-family="sans-serif" font-size="20" fill="white" fill-opacity="0.22">${label}</text>`;
  }
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${marks}</svg>`);
}

/** Returns a JPEG buffer with the watermark burned in. */
export async function watermarkImage(original: Buffer, label: string): Promise<Buffer> {
  const img = sharp(original).rotate(); // .rotate() with no args auto-orients from EXIF
  const { width = 1080, height = 1080 } = await img.metadata();
  const overlay = await tile(width, height, label);
  return img.composite([{ input: overlay, top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
}

const wmKey = (mediaId: string, viewerId: string) => `wm/${mediaId}/${viewerId}.jpg`;

/** Cached per (media, viewer) pair -- generated once, reused on subsequent views. */
export async function getOrCreateWatermarkedUrl(mediaId: string, sourceKey: string, viewerId: string, viewerLabel: string) {
  const key = wmKey(mediaId, viewerId);
  const exists = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })).then(() => true, () => false);
  if (!exists) {
    const src = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: sourceKey }));
    const original = Buffer.from(await src.Body!.transformToByteArray());
    const label = `${viewerLabel} · ${traceCode(mediaId, viewerId)}`;
    const watermarked = await watermarkImage(original, label);
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: watermarked, ContentType: 'image/jpeg' }));
  }
  return key;
}
