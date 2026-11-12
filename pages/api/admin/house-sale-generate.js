import { requireAdminKey } from '../../../lib/admin-auth';
import { refuseCrossSite } from '../../../lib/same-origin';
import { refuseMalformedText } from '../../../lib/field-validation';
import { consumeAttempt, clientNetwork } from '../../../lib/rate-limit';
import { blobConfigured } from '../../../lib/media';
import { saveHouseSaleImage, parseHouseSaleSlot, HOUSE_ERRORS } from '../../../lib/house-roster';
import { isHouseClipSlot } from '../../../data/house-roster';
import { generateHouseSalePhoto, AI_CHAT_ERRORS, MAX_SCENE_TEXT } from '../../../lib/ai-chat';

// One image generation can take most of a minute.
export const config = { maxDuration: 60 };

const WINDOW_MS = 15 * 60 * 1000;
const MAX_GENERATIONS = 60;

/**
 * POST /api/admin/house-sale-generate   (header x-admin-key)
 *   body { slug, n, scene }
 *     slug   one of the AI house models
 *     n      a PHOTO slot, 1-6 (video slots are upload-only)
 *     scene  what the photo should show, 3..MAX_SCENE_TEXT characters
 *   -> 200 { ok: true, slot: { slug, n, bytes, contentType, uploadedAt, replaced } }
 *
 * Generates one paid photo of that model with the site's own image model --
 * the model's fixed look leads the prompt, exactly as for a fan's custom
 * photo (lib/ai-chat.js) -- and stores it in that slot as a private master,
 * replacing whatever was there (the old one is kept on record). The owner
 * then views it in the panel and regenerates or installs.
 *
 * The scene goes through the same two screens as a fan's request (word rules,
 * then the classifier) before anything is generated: nothing implying a
 * minor, no real person, nothing non-consensual.
 *   400 { code: 'ai_chat_refused' }   the scene was refused
 *   400 house_bad_slot                unknown model, or not a photo slot
 *   503 ai_chat_unavailable           no AI key, or the check could not be made
 *   502 ai_generation_failed          the image model failed
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

  const { limited, retryAfterSeconds } = consumeAttempt(`house-sale-generate:ip:${clientNetwork(req)}`, { limit: MAX_GENERATIONS, windowMs: WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many requests. Try again in a few minutes.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const scene = typeof body.scene === 'string' ? body.scene.trim() : '';
  try {
    const slot = parseHouseSaleSlot(body.slug, typeof body.n === 'number' ? body.n : String(body.n ?? ''));
    if (isHouseClipSlot(slot.n)) {
      return res.status(400).json({ error: 'Video slots are upload-only. Generate works for photo slots 1 to 6.', code: HOUSE_ERRORS.BAD_SLOT });
    }
    if (scene.length < 3) return res.status(400).json({ error: 'Describe what the photo should show.' });
    if (scene.length > MAX_SCENE_TEXT) return res.status(400).json({ error: `Keep the description under ${MAX_SCENE_TEXT} characters.` });
    if (!blobConfigured()) {
      return res.status(503).json({ error: 'File storage is not configured.', code: HOUSE_ERRORS.BLOB_UNCONFIGURED });
    }
    const bytes = await generateHouseSalePhoto({ slug: slot.model.slug, scene });
    const saved = await saveHouseSaleImage({ slug: slot.model.slug, n: slot.n, bytes, contentType: 'image/jpeg' });
    return res.status(200).json({ ok: true, slot: saved });
  } catch (err) {
    if (err && typeof err.code === 'string' && err.code.startsWith('house_') && Number.isInteger(err.status)) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    if (err && Object.values(AI_CHAT_ERRORS).includes(err.code) && Number.isInteger(err.status)) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('[admin/house-sale-generate] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
