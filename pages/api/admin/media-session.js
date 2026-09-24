import { requireAdminKey } from '../../../lib/admin-auth';
import { adminMediaCookieHeader, clearAdminMediaCookieHeader, createAdminMediaToken, ADMIN_MEDIA_MAX_AGE_SECONDS } from '../../../lib/media';

/**
 * POST /api/admin/media-session (header x-admin-key) -> 200 { ok: true, expiresInSeconds }
 *   Sets the oa_admin_media cookie (HttpOnly, SameSite=Strict, Path=/api/media,
 *   2h) so the admin panel's <img>/<video> tags -- which cannot send the admin
 *   header -- can load any creator's private media for review. Call it once
 *   after unlocking the panel and again before the 2 hours run out.
 * DELETE /api/admin/media-session -> 200 { ok: true } clears it (no key needed).
 *
 * The cookie is bound to the current ADMIN_UPLOAD_KEY: rotating the key
 * invalidates every outstanding one.
 */
export default async function handler(req, res) {
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearAdminMediaCookieHeader());
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  try {
    res.setHeader('Set-Cookie', adminMediaCookieHeader(createAdminMediaToken()));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, expiresInSeconds: ADMIN_MEDIA_MAX_AGE_SECONDS });
  } catch (err) {
    console.error('[admin/media-session] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
