import sharp from 'sharp';
import { createHash } from 'crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET, objectExists } from './s3.js';
import { checkedImageShape, keepsFrames, MAX_ANIMATED_PIXELS, MAX_FRAME_PIXELS } from './image-limits.js';

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
  mime === 'image/gif' ? { ext: 'gif', contentType: 'image/gif' } as const
    : mime === 'image/webp' ? { ext: 'webp', contentType: 'image/webp' } as const
      : { ext: 'jpg', contentType: 'image/jpeg' } as const;

/**
 * Returns the image with the watermark burned in. Any aspect ratio. JPEG,
 * except for a GIF or a WebP, which stay a GIF / WebP with EVERY frame
 * marked: the transcode worker keeps an animation's frames on purpose
 * (transcode-steps.ts sanitizeImage), but this used to decode only frame 1
 * and re-encode it as a JPEG, so every fan who paid for an animation
 * received one still frame -- cached, so every later view too.
 *
 * Decoded under the same frame-aware limits as the transcode
 * (lib/image-limits.ts): sharp's own default counts every frame stacked.
 */
export async function watermarkImage(original: Buffer, label: string, mime = 'image/jpeg'): Promise<Buffer> {
  let shape = await checkedImageShape(original);
  if (keepsFrames(mime, shape)) {
    // Animated: sharp lays the frames out top to bottom, each pageHeight
    // tall. ONE overlay, one frame tall, tiled down the whole strip -- it
    // lands on every frame. (It used to be one composite layer per frame, up
    // to 1,000 of them, which is what made a 300 KB GIF peak near 1 GB.)
    //
    // This runs inside the internet-facing API, per viewer, so it works to a
    // far smaller budget than the transcode worker's decode limits: an
    // animation over WM_MAX_ANIMATED_PIXELS in total (or wider than
    // WM_MAX_EDGE) is scaled down first. The viewer still gets every frame.
    let img = sharp(original, { animated: true, limitInputPixels: MAX_ANIMATED_PIXELS });
    let timing: { delay?: number[]; loop?: number } = {};
    const scale = Math.min(1,
      Math.sqrt(WM_MAX_ANIMATED_PIXELS / (shape.width * shape.pageHeight * shape.pages)),
      WM_MAX_EDGE / Math.max(shape.width, shape.pageHeight));
    if (scale < 1) {
      // Scaled to RAW frames (every frame kept, one lossy encode at the
      // end); raw pixels carry no frame timing, so it is carried over.
      const meta = await sharp(original, { animated: true, limitInputPixels: MAX_ANIMATED_PIXELS }).metadata();
      timing = { ...(meta.delay ? { delay: meta.delay } : {}), ...(meta.loop !== undefined ? { loop: meta.loop } : {}) };
      const { data, info } = await sharp(original, { animated: true, limitInputPixels: MAX_ANIMATED_PIXELS })
        .resize({ width: Math.max(1, Math.floor(shape.width * scale)) })
        .raw().toBuffer({ resolveWithObject: true });
      const pageHeight = info.pageHeight ?? info.height;
      img = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels, premultiplied: !!info.premultiplied, pageHeight } as any });
      shape = { width: info.width, pageHeight, pages: Math.max(1, Math.round(info.height / pageHeight)) };
    }
    const overlay = await tile(shape.width, shape.pageHeight, label);
    const out = img.composite([{ input: overlay, tile: true, gravity: 'northwest' }]);
    return mime === 'image/gif' ? out.gif(timing).toBuffer() : out.webp({ quality: 88, ...timing }).toBuffer();
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
  //
  // Stills larger than WM_MAX_EDGE on their long side (a 48 MP phone photo
  // is 8000x6000) are scaled down to it first: at full size the decode, the
  // full-frame SVG overlay and the composite peaked around 550 MB for ONE
  // viewer, in the API process. The intermediate is RAW pixels, not an
  // encoded image, so there is still only one lossy encode; resizing in the
  // same pipeline also lets libjpeg shrink on load.
  const img = sharp(original, { autoOrient: true, limitInputPixels: MAX_FRAME_PIXELS });
  const { autoOrient } = await img.metadata();
  let base = img, width = autoOrient.width, height = autoOrient.height;
  if (Math.max(width, height) > WM_MAX_EDGE) {
    const { data, info } = await img
      .resize({ width: WM_MAX_EDGE, height: WM_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .raw().toBuffer({ resolveWithObject: true });
    base = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels, premultiplied: !!info.premultiplied } });
    width = info.width; height = info.height;
  }
  const overlay = await tile(width, height, label);
  const out = base.composite([{ input: overlay, top: 0, left: 0 }]);
  return mime === 'image/webp' ? out.webp({ quality: 88 }).toBuffer() : out.jpeg({ quality: 88 }).toBuffer();
}

// --- API-side budget --------------------------------------------------------
//
// Watermarks are generated on demand in the API process (GET /media/:id/url),
// which shares a 2 GB droplet with Postgres and Redis. The transcode
// worker's decode limits (lib/image-limits.ts) are sized for ITS memory cap,
// not for this, so:
//  - the output is capped (long edge WM_MAX_EDGE; animations
//    WM_MAX_ANIMATED_PIXELS in total), see watermarkImage;
//  - at most WATERMARK_CONCURRENCY generations run at once (default 1), with
//    a short bounded wait queue beyond which a request is refused 503 and
//    retried by the client;
//  - concurrent requests for the SAME copy share one generation.
/** Long edge of a watermarked copy, in pixels. */
export const WM_MAX_EDGE = 2560;
/** Total pixels (all frames) of a watermarked animation. */
export const WM_MAX_ANIMATED_PIXELS = 20_000_000;
const WM_CONCURRENCY = Math.max(1, Math.min(4, Number.parseInt(process.env.WATERMARK_CONCURRENCY ?? '', 10) || 1));
const WM_MAX_WAITING = 16;

let wmRunning = 0;
const wmWaiters: Array<() => void> = [];
async function withWatermarkSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (wmRunning >= WM_CONCURRENCY) {
    if (wmWaiters.length >= WM_MAX_WAITING) throw Object.assign(new Error('watermark_busy'), { statusCode: 503 });
    await new Promise<void>((resolve) => wmWaiters.push(resolve));
  } else {
    wmRunning++;
  }
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiter (wmRunning unchanged), or free it.
    const next = wmWaiters.shift();
    if (next) next(); else wmRunning--;
  }
}
const wmInFlight = new Map<string, Promise<string>>();

// The extension follows the output format, so a GIF's cached copy can never
// be mistaken for (or collide with) an old single-frame .jpg of it.
const wmKey = (mediaId: string, viewerId: string, mime: string) => `wm/${mediaId}/${viewerId}.${watermarkFormat(mime).ext}`;
/** Every cached watermarked copy of one media row lives under this prefix (takedowns delete it whole). */
export const wmPrefix = (mediaId: string) => `wm/${mediaId}/`;

/**
 * Cached per (media, viewer) pair -- generated once, reused on subsequent
 * views. `mediaId` is the ROOT media id (a mass-DM copy's sourceMediaId, see
 * modules/media.ts): every copy of one drop is the same image, and keying by
 * the root keeps a takedown to one prefix instead of one per subscriber.
 */
export async function getOrCreateWatermarkedUrl(mediaId: string, sourceKey: string, viewerId: string, viewerLabel: string, mime = 'image/jpeg') {
  const key = wmKey(mediaId, viewerId, mime);
  // HEAD, not GET: an unread GetObject body pins one of the SDK's 50 pooled
  // sockets per cache hit, and every repeat view is a cache hit. objectExists
  // also only treats a real not-found as "missing" -- a 403 or throttle used
  // to trigger a pointless regeneration.
  if (await objectExists(key)) return key;
  // One generation per key at a time: parallel requests for the same copy
  // (a viewer's page firing several fetches) all await the first one.
  const running = wmInFlight.get(key);
  if (running) return running;
  const job = withWatermarkSlot(async () => {
    if (await objectExists(key)) return key;   // made by a request that finished while this one queued
    const src = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: sourceKey }));
    const original = Buffer.from(await src.Body!.transformToByteArray());
    const label = `${viewerLabel} · ${traceCode(mediaId, viewerId)}`;
    const watermarked = await watermarkImage(original, label, mime);
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: watermarked, ContentType: watermarkFormat(mime).contentType }));
    return key;
  }).finally(() => { wmInFlight.delete(key); });
  wmInFlight.set(key, job);
  return job;
}

/** Test hook: the in-process concurrency bookkeeping. */
export const _watermarkLoad = () => ({ running: wmRunning, waiting: wmWaiters.length, inFlight: wmInFlight.size });
