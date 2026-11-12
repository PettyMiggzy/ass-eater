import { requireAdminKey } from '../../../lib/admin-auth';
import { refuseCrossSite } from '../../../lib/same-origin';
import { refuseMalformedText } from '../../../lib/field-validation';
import { consumeAttempt, clientNetwork } from '../../../lib/rate-limit';
import { blobConfigured, issueUploadToken } from '../../../lib/media';
import { prepareHouseSaleClipUpload, registerHouseSaleClip, HOUSE_ERRORS } from '../../../lib/house-roster';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_CALLS = 200;

/**
 * POST /api/admin/house-sale-clip   (header x-admin-key)
 *
 * A house model's paid VIDEO clip (slots 7-9), uploaded straight from the
 * admin's browser to private storage so it is not held to the ~4MB a file
 * posted through a function may be (lib/house-roster.js).
 *
 *   { action: 'token', slug, n, contentType: 'video/mp4', size }
 *     -> 200 { pathname, clientToken, maxBytes, validUntil }
 *     A token good for ONE server-chosen pathname in that slot, MP4 only, up
 *     to the size limit. The browser uploads with it, then calls:
 *
 *   { action: 'finalize', slug, n, pathname }
 *     -> 200 { ok: true, slot: { slug, n, bytes, contentType, uploadedAt, replaced } }
 *     Checks the stored file (really an MP4, within the limit, in that slot)
 *     and records it. The model's video listings pick it up on its next
 *     install.
 *
 * Errors: 400 house_bad_slot | house_bad_image, 404 house_slot_empty (the
 * file never arrived), 413 house_image_too_large, 415 house_bad_image, 429,
 * 503 house_blob_unconfigured.
 */
export default async function handler(req, res) {
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (refuseCrossSite(req, res)) return;
  if (!requireAdminKey(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');

  const { limited, retryAfterSeconds } = consumeAttempt(`house-sale-clip:ip:${clientNetwork(req)}`, { limit: MAX_CALLS, windowMs: WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const n = typeof body.n === 'number' ? body.n : String(body.n ?? '');
  try {
    if (body.action === 'token') {
      const prep = prepareHouseSaleClipUpload({ slug: body.slug, n, contentType: body.contentType, size: body.size });
      if (!blobConfigured()) {
        return res.status(503).json({ error: 'File storage is not configured.', code: HOUSE_ERRORS.BLOB_UNCONFIGURED });
      }
      const { clientToken, validUntil } = await issueUploadToken({ pathname: prep.pathname, contentType: prep.contentType, maxBytes: prep.maxBytes });
      return res.status(200).json({ pathname: prep.pathname, clientToken, maxBytes: prep.maxBytes, validUntil });
    }
    if (body.action === 'finalize') {
      if (!blobConfigured()) {
        return res.status(503).json({ error: 'File storage is not configured.', code: HOUSE_ERRORS.BLOB_UNCONFIGURED });
      }
      const saved = await registerHouseSaleClip({ slug: body.slug, n, pathname: body.pathname });
      return res.status(200).json({ ok: true, slot: saved });
    }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    if (err && typeof err.code === 'string' && err.code.startsWith('house_') && Number.isInteger(err.status)) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('[admin/house-sale-clip] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
