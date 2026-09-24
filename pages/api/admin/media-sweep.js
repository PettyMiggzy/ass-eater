import { requireAdminKey } from '../../../lib/admin-auth';
import { sweepOrphanedMedia, blobConfigured } from '../../../lib/media';

/**
 * POST /api/admin/media-sweep -- reap orphaned media files now.
 * Header x-admin-key. JSON { limit? } (1..500, default 200)
 *   -> 200 { ok: true, checked, deleted, kept, failed }
 *
 * Deletes files that were uploaded with a token but never finalized, and
 * retries deletions that failed earlier, once they are over an hour old and
 * no creator or listing record references them (lib/media.js
 * sweepOrphanedMedia). The same sweep runs in small batches on every upload
 * token request; this is for running it in full, e.g. after a quiet spell or
 * from a scheduled job. Safe to call repeatedly.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdminKey(req, res)) return;
  if (!blobConfigured()) return res.status(503).json({ error: 'Media storage is not configured.' });

  const raw = req.body && typeof req.body === 'object' ? req.body.limit : undefined;
  const limit = Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, 500) : 200;
  try {
    const summary = await sweepOrphanedMedia({ limit });
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error('[admin/media-sweep] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
