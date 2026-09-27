import { Readable, pipeline } from 'stream';
import { get, BlobNotFoundError } from '@vercel/blob';
import { requireAdminKey } from '../../../lib/admin-auth';
import { refuseCrossSite } from '../../../lib/same-origin';
import { refuseMalformedText } from '../../../lib/field-validation';
import { consumeAttempt, clientNetwork } from '../../../lib/rate-limit';
import { blobConfigured } from '../../../lib/media';
import {
  saveHouseSaleImage,
  getHouseSaleImage,
  parseHouseSaleSlot,
  HOUSE_SALE_IMAGE_MAX_BYTES,
  HOUSE_ERRORS,
} from '../../../lib/house-roster';

// The body is the raw image, read here with a hard cap -- not parsed.
export const config = { api: { bodyParser: false, responseLimit: false } };

const WINDOW_MS = 15 * 60 * 1000;
const MAX_UPLOADS = 60; // 48 slots in all; room for a few re-uploads
const MAX_VIEWS = 200;

/**
 * One of the AI house models' PAID photos (lib/house-roster.js), admin-key
 * gated. The owner makes these himself; they are never in git or public/.
 *
 *   POST /api/admin/house-sale-image?slug=<model slug>&n=<1..6>
 *     Header x-admin-key, Content-Type image/jpeg | image/png | image/webp,
 *     body = the image bytes (at most HOUSE_SALE_IMAGE_MAX_BYTES, 4MB).
 *     -> 200 { ok: true, slot: { slug, n, bytes, contentType, uploadedAt, replaced } }
 *     Uploads a new PRIVATE master and records it for that slot (replacing
 *     any earlier upload, which is kept). Listings pick it up on the next
 *     install of that model (POST /api/admin/house-roster).
 *     Errors: 400 house_bad_slot | house_bad_image, 413 house_image_too_large,
 *     415 house_bad_image (a type outside the three, or bytes that are not
 *     the declared type), 429, 503 house_blob_unconfigured.
 *
 *   GET /api/admin/house-sale-image?slug=<model slug>&n=<1..6>
 *     Header x-admin-key -> 200 the image bytes (Cache-Control: no-store),
 *     404 { code: 'house_slot_empty' } when nothing is uploaded. For the
 *     admin panel's "view" link, which fetches with the key in a header and
 *     opens the result as a local object URL -- the master has no URL of its
 *     own that /api/media would serve to anyone.
 */
export default async function handler(req, res) {
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (req.method === 'POST' && refuseCrossSite(req, res)) return;
  if (!requireAdminKey(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');

  const { limited, retryAfterSeconds } = consumeAttempt(
    `house-sale-image:${req.method === 'POST' ? 'up' : 'view'}:ip:${clientNetwork(req)}`,
    { limit: req.method === 'POST' ? MAX_UPLOADS : MAX_VIEWS, windowMs: WINDOW_MS },
  );
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' });
  }

  const slugParam = typeof req.query.slug === 'string' ? req.query.slug : null;
  const nParam = typeof req.query.n === 'string' ? req.query.n : null;

  try {
    const slot = parseHouseSaleSlot(slugParam, nParam);
    if (!blobConfigured()) {
      return res.status(503).json({ error: 'File storage is not configured.', code: HOUSE_ERRORS.BLOB_UNCONFIGURED });
    }

    if (req.method === 'GET') {
      const current = await getHouseSaleImage(slot.model.slug, slot.n);
      if (!current) return res.status(404).json({ error: 'Nothing is uploaded in that slot yet.', code: HOUSE_ERRORS.SLOT_EMPTY });
      let result;
      try {
        result = await get(current.pathname, { access: 'private' });
      } catch (err) {
        if (err instanceof BlobNotFoundError) return res.status(404).json({ error: 'That file is missing from storage. Upload it again.', code: HOUSE_ERRORS.SLOT_EMPTY });
        throw err;
      }
      if (!result || result.statusCode !== 200 || !result.stream) {
        return res.status(404).json({ error: 'That file is missing from storage. Upload it again.', code: HOUSE_ERRORS.SLOT_EMPTY });
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', current.contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      pipeline(Readable.fromWeb(result.stream), res, (err) => {
        if (err) {
          console.error('[admin/house-sale-image] stream failed', err && err.message);
          res.destroy(err);
        }
      });
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > HOUSE_SALE_IMAGE_MAX_BYTES) {
      req.resume();
      return res.status(413).json({ error: `That file is too large (${HOUSE_SALE_IMAGE_MAX_BYTES / (1024 * 1024)}MB maximum).`, code: HOUSE_ERRORS.IMAGE_TOO_LARGE });
    }
    const bytes = await readCapped(req, HOUSE_SALE_IMAGE_MAX_BYTES);
    if (bytes === null) {
      return res.status(413).json({ error: `That file is too large (${HOUSE_SALE_IMAGE_MAX_BYTES / (1024 * 1024)}MB maximum).`, code: HOUSE_ERRORS.IMAGE_TOO_LARGE });
    }
    const saved = await saveHouseSaleImage({
      slug: slot.model.slug,
      n: slot.n,
      bytes,
      contentType: req.headers['content-type'],
    });
    return res.status(200).json({ ok: true, slot: saved });
  } catch (err) {
    if (err && typeof err.code === 'string' && err.code.startsWith('house_') && Number.isInteger(err.status)) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('[admin/house-sale-image] unexpected error:', err);
    if (!res.headersSent) return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

/** The request body, or null once it passes `max` bytes (the rest is drained, not buffered). */
function readCapped(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
