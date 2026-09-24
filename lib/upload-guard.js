/**
 * What may be stored as creator media, and how big it may be.
 *
 * Uploads no longer pass through an API route's request body. Vercel rejects
 * any function body over 4.5MB before the handler even runs, which made every
 * phone video (and many phone photos) impossible to upload, and the platform's
 * non-JSON 413 surfaced in the dashboard as a JSON parse error. The browser now
 * uploads straight to the (PRIVATE) Blob store with a short-lived client token
 * that lib/media.js issues for one server-chosen pathname, and a small JSON
 * "finalize" call records the file. See lib/media.js for the whole flow.
 *
 * The allowlist still matters, twice over:
 *   - The upload token only permits the ONE declared type, so the browser
 *     cannot store something else under it.
 *   - Finalize re-reads the stored blob's real content type and size with
 *     head() and deletes it if either is out of bounds, so a token used
 *     outside our own client still cannot land a disallowed file.
 * SVG is excluded because it is an image that can carry script, and nothing
 * text/html-like is ever accepted. Types are listed explicitly rather than
 * matched with /^(image|video)\//, so a novel "image/x-something" a browser
 * might render unexpectedly is not accepted by accident.
 */

export const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export const VIDEO_TYPES = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

const MB = 1024 * 1024;

/** Per-purpose ceilings. Avatars are images only. */
export const MAX_AVATAR_BYTES = 10 * MB;
export const MAX_IMAGE_BYTES = 25 * MB;
export const MAX_VIDEO_BYTES = 50 * MB;

// Kept for anything still importing the old name; the per-type ceilings above
// are what is actually enforced.
export const MAX_UPLOAD_BYTES = MAX_VIDEO_BYTES;

export const UPLOAD_PURPOSES = ['gallery', 'avatar', 'listing'];

/** Normalises "video/mp4; codecs=..." to "video/mp4"; null for non-strings. */
export function normalizeContentType(value) {
  if (typeof value !== 'string') return null;
  return value.split(';')[0].trim().toLowerCase() || null;
}

/**
 * The media kind ('image' | 'video') a content type is accepted as for this
 * purpose, or null when it is not accepted at all.
 */
export function mediaKindFor(purpose, contentType) {
  const type = normalizeContentType(contentType);
  if (!type) return null;
  if (IMAGE_TYPES[type]) return 'image';
  if (VIDEO_TYPES[type] && purpose !== 'avatar') return 'video';
  return null;
}

/** File extension for an accepted type (the pathname is server-generated, never the upload's own name). */
export function extensionFor(contentType) {
  const type = normalizeContentType(contentType);
  return IMAGE_TYPES[type] || VIDEO_TYPES[type] || null;
}

export function maxBytesFor(purpose, contentType) {
  if (purpose === 'avatar') return MAX_AVATAR_BYTES;
  return mediaKindFor(purpose, contentType) === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

export const UPLOAD_TYPE_MESSAGE = 'Only JPEG, PNG, WebP, GIF, AVIF or HEIC photos and MP4, MOV or WebM videos are accepted.';
export const AVATAR_TYPE_MESSAGE = 'Profile photos must be an image (JPEG, PNG, WebP, GIF, AVIF or HEIC).';

export function uploadSizeMessage(purpose, contentType) {
  return `That file is too large (${Math.round(maxBytesFor(purpose, contentType) / MB)}MB maximum).`;
}

// Legacy message constant kept for callers that still import it.
export const UPLOAD_SIZE_MESSAGE = `That file is too large (${MAX_VIDEO_BYTES / MB}MB maximum).`;
