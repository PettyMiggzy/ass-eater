import { requireAdminKey } from '../../../lib/admin-auth';
import { sweepOrphanedMedia, blobConfigured, pendingDeletionCounts } from '../../../lib/media';
import { movePreservedToEvidence } from '../../../lib/media-preservation';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * POST /api/admin/media-sweep -- reap orphaned media files now.
 * Header x-admin-key. JSON { limit? } (1..500, default 200)
 *   -> 200 { ok: true, checked, deleted, kept, failed, remaining,
 *            outstanding: { deleteFailed, deletePending, oldestAt } }
 * GET /api/admin/media-sweep -> 200 { ok: true, outstanding } (counts only)
 *
 * Deletes files that were uploaded with a token but never finalized (once
 * they are over an hour old) and retries removals and failed deletions
 * straight away, as long as no creator or listing record references them and
 * they are not preserved evidence (lib/media.js sweepOrphanedMedia). The same
 * sweep runs daily from the Vercel cron (/api/cron/maintenance) and in small
 * batches on every upload token request; this is for running it now. Safe to
 * call repeatedly: it stops at a time budget rather than being killed
 * part-way, and `remaining` counts rows it claimed but handed back
 * unprocessed -- call again while it is above 0. `outstanding` is what is
 * still waiting to be deleted afterwards: a takedown whose file keeps failing
 * to delete shows up there rather than only in a log.
 */
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdminKey(req, res)) return;

  if (req.method === 'GET') {
    try {
      return res.status(200).json({ ok: true, outstanding: await pendingDeletionCounts() });
    } catch (err) {
      console.error('[admin/media-sweep] count failed:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  if (!blobConfigured()) return res.status(503).json({ error: 'Media storage is not configured.' });

  const raw = req.body && typeof req.body === 'object' ? req.body.limit : undefined;
  const limit = Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, 500) : 200;
  try {
    const summary = await sweepOrphanedMedia({ limit });
    const evidence = await movePreservedToEvidence({ limit: 50 });
    const outstanding = await pendingDeletionCounts();
    return res.status(200).json({ ok: true, ...summary, evidence, outstanding });
  } catch (err) {
    console.error('[admin/media-sweep] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
