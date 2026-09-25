import sharp from 'sharp';
import { createHash } from 'crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET, objectExists } from './s3.js';

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

/** Output format of a watermarked copy, by source mime. */
export const watermarkFormat = (mime: string) =>
  mime === 'image/gif' ? { ext: 'gif', contentType: 'image/gif' } as const : { ext: 'jpg', contentType: 'image/jpeg' } as const;

/**
 * Returns the image with the watermark burned in. Any aspect ratio. JPEG,
 * except for a GIF, which stays a GIF with EVERY frame marked: the transcode
 * worker keeps an animated GIF's frames on purpose (transcode-steps.ts
 * sanitizeImage), but this used to decode only frame 1 and re-encode it as a
 * JPEG, so every fan who paid for an animation received one still frame --
 * cached, so every later view too.
 */
export async function watermarkImage(original: Buffer, label: string, mime = 'image/jpeg'): Promise<Buffer> {
  if (mime === 'image/gif') {
    // Animated: sharp lays the frames out top to bottom, each pageHeight
    // tall. One overlay per frame, positioned on its page.
    const img = sharp(original, { animated: true });
    const meta = await img.metadata();
    const pages = Math.max(1, meta.pages ?? 1);
    const pageHeight = meta.pageHeight ?? meta.height;
    const overlay = await tile(meta.width, pageHeight, label);
    const layers = Array.from({ length: pages }, (_, i) => ({ input: overlay, top: i * pageHeight, left: 0 }));
    return img.composite(layers).gif().toBuffer();
  }
  // metadata().width/height are the *stored* size and ignore EXIF orientation,
  // and a phone portrait photo is stored landscape behind an orientation flag
  // -- so sizing the overlay from those made it wider than the displayed image
  // and sharp refused the composite ("Image to composite must have same
  // dimensions or smaller"), failing every such upload outright.
  // metadata().autoOrient is the size the image actually has once the flag is
  // applied, which is what the { autoOrient: true } pipeline below produces.
  //
  // Measured this way rather than by rotating into an intermediate buffer
  // first: toBuffer() with no format re-encodes (JPEG in, JPEG back out at
  // sharp's default quality) before the final .jpeg() here, and two lossy
  // passes over a paid photo is a real quality hit -- the result is cached per
  // (media, viewer), so the degraded copy is what every later view serves.
  const img = sharp(original, { autoOrient: true });
  const { autoOrient } = await img.metadata();
  const overlay = await tile(autoOrient.width, autoOrient.height, label);
  return img.composite([{ input: overlay, top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
}

// The extension follows the output format, so a GIF's cached copy can never
// be mistaken for (or collide with) an old single-frame .jpg of it.
const wmKey = (mediaId: string, viewerId: string, mime: string) => `wm/${mediaId}/${viewerId}.${watermarkFormat(mime).ext}`;
/** Every cached watermarked copy of one media row lives under this prefix (takedowns delete it whole). */
export const wmPrefix = (mediaId: string) => `wm/${mediaId}/`;

/** Cached per (media, viewer) pair -- generated once, reused on subsequent views. */
export async function getOrCreateWatermarkedUrl(mediaId: string, sourceKey: string, viewerId: string, viewerLabel: string, mime = 'image/jpeg') {
  const key = wmKey(mediaId, viewerId, mime);
  // HEAD, not GET: an unread GetObject body pins one of the SDK's 50 pooled
  // sockets per cache hit, and every repeat view is a cache hit. objectExists
  // also only treats a real not-found as "missing" -- a 403 or throttle used
  // to trigger a pointless regeneration.
  if (!(await objectExists(key))) {
    const src = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: sourceKey }));
    const original = Buffer.from(await src.Body!.transformToByteArray());
    const label = `${viewerLabel} · ${traceCode(mediaId, viewerId)}`;
    const watermarked = await watermarkImage(original, label, mime);
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: watermarked, ContentType: watermarkFormat(mime).contentType }));
  }
  return key;
}
