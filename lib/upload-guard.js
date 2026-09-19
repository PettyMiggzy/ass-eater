/**
 * Shared limits for the raw-body upload endpoints.
 *
 * Both halves matter and neither is theoretical:
 *
 * - The MIME allowlist. Whatever is stored is served straight back from a
 *   public blob URL under the Content-Type it was saved with, and every blob
 *   in the store shares one origin. Uploading `text/html` therefore stores a
 *   document that renders on that origin -- stored XSS against every other
 *   blob there. SVG is an image that can carry script, so it is excluded for
 *   the same reason. Taking the header verbatim, as these routes used to,
 *   made that a one-line request.
 * - The size cap. `for await (const chunk of req)` with no ceiling buffers
 *   the entire body into memory before anything checks it.
 *
 * pages/api/marketplace/upload.js and pages/api/creator/submit.js already had
 * both; the four creator/admin gallery and avatar routes had neither. This is
 * that same check, in one place, so the next upload route inherits it.
 */

// Vercel's own production request-body limit is stricter than this; the cap
// here is what bounds any other deployment and local dev.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const ALLOWED_UPLOAD_TYPE = /^(image|video)\//;
const SVG_TYPE = /^image\/svg/;

/** Returns null (rather than throwing) once the body passes MAX_UPLOAD_BYTES. */
export async function readLimitedBody(req, max = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The content type to store the blob under, or null when it is not one we
 * accept. Parameters are stripped first -- browsers send
 * "video/mp4; codecs=..." and the whole header is what would get stored.
 */
export function acceptedUploadType(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_UPLOAD_TYPE.test(type) || SVG_TYPE.test(type)) return null;
  return type;
}

export const UPLOAD_TYPE_MESSAGE = 'Only image and video uploads are accepted.';
export const UPLOAD_SIZE_MESSAGE = 'That file is too large (50MB maximum).';
