import { removeGalleryItem, GALLERY_ITEM_GONE } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { preserveMediaForReportTx, NCII_REPORT_NOT_FOUND } from '../../../lib/ncii-reports-store';
import { movePreservedToEvidence } from '../../../lib/media-preservation';

/**
 * POST /api/admin/gallery-delete
 * Header x-admin-key. JSON { creatorId, src, index?, preserveForNciiReportId? }
 *   -> 200 { ok: true, creator, preserved: boolean } | 409 when that item is no longer there
 *
 * `preserveForNciiReportId`: the item is reported as possibly showing a
 * minor. It is QUARANTINED for that takedown report (lib/media-
 * preservation.js -- kept, never served, never deleted) inside the same
 * locked transaction that takes it out of the gallery, after the item is
 * confirmed to be there: removing it cannot destroy the evidence 18 U.S.C.
 * 2258A requires be preserved, a failed preservation removes nothing, and a
 * stale or wrong `src` (409) quarantines nothing.
 *
 * See pages/api/me/gallery-delete.js. This is the path an admin uses to take a
 * reported photo down, so it matters most here that the item removed is the
 * one that was clicked -- the admin panel's roster is loaded once and goes
 * stale while creators keep editing -- and that the file itself is deleted
 * from storage, not just the reference (removeGalleryItem does both).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { creatorId, src, index: rawIndex } = req.body && typeof req.body === 'object' ? req.body : {};
  if ((typeof creatorId !== 'string' && typeof creatorId !== 'number') || !String(creatorId)) {
    return res.status(400).json({ error: 'Missing creatorId' });
  }
  if (typeof src !== 'string' || !src || src.length > 2048) {
    return res.status(400).json({ error: 'Missing the item to delete' });
  }
  const index = Number.isInteger(rawIndex) ? rawIndex : undefined;
  const preserveFor = req.body.preserveForNciiReportId;
  if (preserveFor !== undefined && preserveFor !== null && preserveFor !== '' && !/^[1-9][0-9]{0,17}$/.test(String(preserveFor))) {
    return res.status(400).json({ error: 'Invalid takedown report id' });
  }

  try {
    let preserved = false;
    const wantsPreserve = preserveFor !== undefined && preserveFor !== null && preserveFor !== '';
    const creator = await removeGalleryItem(String(creatorId), {
      src,
      index,
      beforeRemove: wantsPreserve
        ? async (client, gone) => {
          preserved = (await preserveMediaForReportTx(client, String(preserveFor), [gone])).length > 0;
        }
        : undefined,
    });
    if (preserved) await movePreservedToEvidence({ limit: 20 });
    return res.status(200).json({ ok: true, creator, preserved });
  } catch (err) {
    if (err.code === NCII_REPORT_NOT_FOUND) return res.status(404).json({ error: 'Takedown report not found. Nothing was removed.' });
    if (err.code === GALLERY_ITEM_GONE) {
      return res.status(409).json({ error: 'That item is no longer in the gallery. Refresh and try again.' });
    }
    if (err.message === 'Creator not found') return res.status(404).json({ error: 'Creator not found' });
    console.error('[admin/gallery-delete] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
