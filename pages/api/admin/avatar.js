import { setCreatorAvatar, getCreatorById } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { mediaSrc, parseMediaPathname, verifyUploadedBlob, deleteUnfinalizedUpload, MediaRejected } from '../../../lib/media';
import { resolvePerformerAttestation } from '../../../lib/performer-attestation';
import { preserveMediaForReportTx, recordNciiTakedown, nciiReportExists, normalizeNciiCategory, NCII_REPORT_NOT_FOUND } from '../../../lib/ncii-reports-store';
import { movePreservedToEvidence } from '../../../lib/media-preservation';
import { MEDIA_UPLOAD_EXPIRED, MEDIA_UPLOAD_EXPIRED_MESSAGE } from '../../../lib/media-refs';
import { refuseMalformedText } from '../../../lib/field-validation';

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
 *   JSON { creatorId, remove: true, preserveForNciiReportId?, nciiReportId? } -> 200 { ok: true, creator, removed, preserved }
 *     TAKE DOWN the current photo: resets it to the neutral placeholder and
 *     deletes the old file from storage. The avatar is the most public image
 *     on the site (every browse card), and a reported one used to be
 *     removable only by uploading some other image as the creator's face or
 *     deleting the whole account. `removed` is false when there was no
 *     uploaded photo to delete (already a placeholder or a site image).
 *     With `preserveForNciiReportId` (a photo reported as possibly showing a
 *     minor) the file is quarantined for that report first
 *     (lib/media-preservation.js) and is then kept, never deleted; if the
 *     preservation fails nothing is removed. `nciiReportId` (implied by
 *     `preserveForNciiReportId`) records the removal on that takedown request
 *     so it can be resolved as 'removed'; an unknown id removes nothing (404).
 *     A request filed as a POSSIBLE MINOR quarantines the photo even when
 *     only `nciiReportId` is given.
 *
 * Both go through setCreatorAvatar, which locks the row and deletes the file
 * it replaced after the change commits.
 */
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
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
    const attributeTo = req.body.nciiReportId;
    const wantsRecord = attributeTo !== undefined && attributeTo !== null && attributeTo !== '';
    if (wantsRecord && !/^[1-9][0-9]{0,17}$/.test(String(attributeTo))) {
      return res.status(400).json({ error: 'Invalid takedown report id' });
    }
    const recordOn = wantsPreserve ? String(preserveFor) : wantsRecord ? String(attributeTo) : null;
    try {
      const existing = await getCreatorById(String(creatorId));
      if (!existing) return res.status(404).json({ error: 'Creator not found' });
      const request = recordOn ? await nciiReportExists(recordOn) : null;
      if (recordOn && !request) {
        return res.status(404).json({ error: 'Takedown report not found. Nothing was removed.' });
      }
      // A request filed as a POSSIBLE MINOR is evidence: the photo is
      // quarantined even when the admin only attributed the removal to it.
      const quarantine = wantsPreserve || (request && normalizeNciiCategory(request.category) === 'minor');
      let removed = false;
      let preserved = false;
      // The preservation and the record on the takedown request run inside
      // setCreatorAvatar's locked transaction, on the photo actually being
      // replaced: they commit with the removal or not at all. Recorded
      // afterwards, a failure left the photo gone with nothing on the request
      // (and a vanished request was reported as "nothing was removed").
      const creator = await setCreatorAvatar(String(creatorId), AVATAR_PLACEHOLDER, {
        beforeChange: async (client, oldImg) => {
          removed = typeof oldImg === 'string' && oldImg.startsWith('/api/media/');
          if (quarantine && removed) {
            preserved = (await preserveMediaForReportTx(client, recordOn, [oldImg])).length > 0;
          }
          if (recordOn) {
            // 'removed' whenever the displayed photo actually changed -- a
            // seed /images photo taken off display counts, even though there
            // was no uploaded file to delete.
            const changed = typeof oldImg === 'string' && oldImg !== '' && oldImg !== AVATAR_PLACEHOLDER;
            await recordNciiTakedown(recordOn, {
              type: 'avatar',
              target: { creatorId: String(creatorId), src: changed ? oldImg : null },
              result: changed ? 'removed' : 'already_gone',
              preserved: preserved ? 1 : 0,
            }, client);
          }
        },
      });
      if (preserved) await movePreservedToEvidence({ limit: 20 });
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
      await deleteUnfinalizedUpload(pathname);
      return res.status(404).json({ error: 'Creator not found' });
    }
    const attested = await resolvePerformerAttestation(req.body, { admin: true, creatorId: String(creatorId) });
    if (attested.error) {
      await deleteUnfinalizedUpload(pathname);
      return res.status(attested.status).json({ error: attested.error });
    }
    await verifyUploadedBlob(pathname, 'avatar');
    const creator = await setCreatorAvatar(String(creatorId), mediaSrc(pathname), { performers: attested.attestation });
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    if (err instanceof MediaRejected) return res.status(err.status).json({ error: err.message });
    // The upload was already deleted (reaped by the sweep, or refused and
    // tombstoned earlier): same 409 as every other finalize route, so the
    // admin is told to upload again instead of retrying a dead pathname.
    if (err.code === MEDIA_UPLOAD_EXPIRED) return res.status(409).json({ error: MEDIA_UPLOAD_EXPIRED_MESSAGE });
    console.error('[admin/avatar] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
