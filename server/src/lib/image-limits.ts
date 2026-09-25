import sharp from 'sharp';

/**
 * Decode limits for untrusted images, frame-aware.
 *
 * sharp's `limitInputPixels` is checked against the WHOLE decoded image, and
 * with `animated: true` that is every frame stacked (width x pageHeight x
 * pages). One 50-megapixel limit sized for a still photo therefore refused
 * any ordinary animation past 50M pixels in total -- a 480x480 GIF of 220
 * frames -- and every such upload ended REJECTED. What is actually dangerous
 * is bounded separately instead:
 *  - one frame (the decompression-bomb case): MAX_FRAME_PIXELS, as before;
 *  - the frame count;
 *  - the whole animation, sized to fit the workers' memory cap (decoded RGBA
 *    is ~4 bytes/pixel: 100M pixels is ~400 MB, and the media unit runs two
 *    transcodes at once under MemoryMax=1200M).
 */
export const MAX_FRAME_PIXELS = 50_000_000;
export const MAX_FRAMES = 1_000;
export const MAX_ANIMATED_PIXELS = 100_000_000;

export type ImageShape = { width: number; pageHeight: number; pages: number };

/**
 * Reads the header (no pixel decode) and refuses anything over the limits
 * above. `pages` is 1 for a still image.
 */
export async function checkedImageShape(input: Buffer | string): Promise<ImageShape> {
  // limitInputPixels: false -- metadata() applies the limit too, and against
  // the stacked height; the real limits are checked right below.
  const meta = await sharp(input, { animated: true, limitInputPixels: false }).metadata();
  const width = meta.width ?? 0;
  const pages = Math.max(1, meta.pages ?? 1);
  const pageHeight = meta.pageHeight ?? (meta.height ? Math.floor(meta.height / pages) : 0);
  if (!width || !pageHeight) throw new Error('image_unreadable');
  if (width * pageHeight > MAX_FRAME_PIXELS) throw new Error('image_too_many_pixels');
  if (pages > MAX_FRAMES) throw new Error('image_too_many_frames');
  if (width * pageHeight * pages > MAX_ANIMATED_PIXELS) throw new Error('animation_too_large');
  return { width, pageHeight, pages };
}

/** GIFs are always decoded with their frames; a WebP only when it actually has more than one. */
export const keepsFrames = (mime: string, shape: ImageShape) =>
  mime === 'image/gif' || (mime === 'image/webp' && shape.pages > 1);
