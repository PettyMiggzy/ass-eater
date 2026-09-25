import { setCreatorAvatar, getCreatorById } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { mediaSrc, parseMediaPathname, verifyUploadedBlob, deleteBlobQuietly, MediaRejected } from '../../../lib/media';
import { resolvePerformerAttestation } from '../../../lib/performer-attestation';
import { preserveMediaForReport, NCII_REPORT_NOT_FOUND } from '../../../lib/ncii-reports-store';

const AVATAR_PLACEHOLDER = '/images/avatar-placeholder.png';

/**
 * POST /api/admin/avatar -- set or take down a creator's profile photo.
 * Header x-admin-key.
 *
 *   JSON { creatorId, pathname, othersAppear, coPerformerRecordIds? } -> 200 { ok: true, creator }
 *     finalize an avatar upload (token from POST /api/media/upload-token with
 *     the admin key and { purpose: 'avatar', creatorId, ... }). The §2257
 *     co-performer answer is required, with the admin rules: othersAppear
 *     true must list a record id (with an ID on file) for every other person
 *     (lib/performer-attestation.js).
 *   JSON { creatorId, remove: true, preserveForNciiReportId? } -> 200 { ok: true, creator, removed, preserved }
 *     TAKE DOWN the current photo: resets it to the neutral placeholder and
 *     deletes the old file from storage. The avatar is the most public image
 *     on the site (every browse card), and a reported one used to be
 *     removable only by uploading some other image as the creator's face or
 *     deleting the whole account. `removed` is false when there was no
 *     uploaded photo to delete (already a placeholder or a site image).
 *     With `preserveForNciiReportId` (a photo reported as possibly showing a
 *     minor) the file is quarantined for that report first
 *     (lib/media-preservation.js) and is then kept, never deleted; if the
 *     preservation fails nothing is removed.
 *
 * Both go through setCreatorAvatar, which locks the row and deletes the file
 * it replaced after the change commits.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { creatorId, pathname, remove } = req.body && typeof req.body === 'object' ? req.body : {};
  if ((typeof creatorId !== 'string' && typeof creatorId !== 'number') || !String(creatorId)) {
    return res.status(400).json({ error: 'Missing creator id' });
  }

  if (remove === true) {
    const preserveFor = req.body.preserveForNciiReportId;
    const wantsPreserve = preserveFor !== undefined && preserveFor !== null && preserveFor !== '';
    if (wantsPreserve && !/^[1-9][0-9]{0,17}$/.test(String(preserveFor))) {
      return res.status(400).json({ error: 'Invalid takedown report id' });
    }
    try {
      const existing = await getCreatorById(String(creatorId));
      if (!existing) return res.status(404).json({ error: 'Creator not found' });
      const removed = typeof existing.img === 'string' && existing.img.startsWith('/api/media/');
      let preserved = false;
      if (wantsPreserve && removed) {
        preserved = (await preserveMediaForReport(String(preserveFor), [existing.img])).preserved.length > 0;
      }
      const creator = await setCreatorAvatar(String(creatorId), AVATAR_PLACEHOLDER);
      return res.status(200).json({ ok: true, creator, removed, preserved });
    } catch (err) {
      if (err.code === NCII_REPORT_NOT_FOUND) return res.status(404).json({ error: 'Takedown report not found. Nothing was removed.' });
      console.error('[admin/avatar] remove failed:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }
  const parsed = parseMediaPathname(pathname);
  if (!parsed || parsed.purpose !== 'avatar' || parsed.creatorId !== String(creatorId)) {
    return res.status(400).json({ error: "That upload is not this creator's profile photo." });
  }

  try {
    if (!(await getCreatorById(String(creatorId)))) {
      await deleteBlobQuietly(pathname);
      return res.status(404).json({ error: 'Creator not found' });
    }
    const attested = await resolvePerformerAttestation(req.body, { admin: true, creatorId: String(creatorId) });
    if (attested.error) {
      await deleteBlobQuietly(pathname);
      return res.status(attested.status).json({ error: attested.error });
    }
    await verifyUploadedBlob(pathname, 'avatar');
    const creator = await setCreatorAvatar(String(creatorId), mediaSrc(pathname), { performers: attested.attestation });
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    if (err instanceof MediaRejected) return res.status(err.status).json({ error: err.message });
    console.error('[admin/avatar] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
