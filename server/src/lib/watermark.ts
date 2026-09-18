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

// The label is interpolated into SVG markup, so it has to be escaped -- today
// it's a username (auth.ts restricts those to [a-z0-9_]) plus a hex code, but
// this shouldn't silently break the mark the day either of those loosens up.
const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function tile(width: number, height: number, label: string) {
  // Sized off the image rather than fixed, so the mark stays legible on a
  // 4000px photo and still fits inside a small one. The ratios reproduce the
  // original fixed 20px font / 260px cell at the ~1080px it was tuned for.
  const font = Math.max(12, Math.round(Math.max(width, height) * 0.0185));
  const cell = font * 13, baseline = font * 2;
  const cols = Math.ceil(width / cell) + 1, rows = Math.ceil(height / cell) + 1;
  const text = escapeXml(label);
  let marks = '';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    marks += `<text x="${c * cell}" y="${r * cell + baseline}" transform="rotate(-30 ${c * cell} ${r * cell + baseline})"
      font-family="sans-serif" font-size="${font}" fill="white" fill-opacity="0.22">${text}</text>`;
  }
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${marks}</svg>`);
}

/** Returns a JPEG buffer with the watermark burned in. Any aspect ratio. */
export async function watermarkImage(original: Buffer, label: string): Promise<Buffer> {
  // Auto-orient (.rotate() with no args applies the EXIF orientation) and
  // settle the pixels before measuring. metadata() reports the *stored* size
  // and ignores pending operations, and a phone portrait photo is stored
  // landscape behind an orientation flag -- so sizing the overlay from
  // metadata() made it wider than the rotated image and sharp refused the
  // composite ("Image to composite must have same dimensions or smaller"),
  // failing every such upload outright. info is the real post-rotation size.
  const { data: upright, info } = await sharp(original).rotate().toBuffer({ resolveWithObject: true });
  const overlay = await tile(info.width, info.height, label);
  return sharp(upright).composite([{ input: overlay, top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
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
