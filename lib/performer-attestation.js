import { query } from './db';

/**
 * §2257 co-performers: who appears in an uploaded file.
 *
 * /2257 says the platform keeps its own record for performers appearing in
 * content here, and the only record a creator is checked for is their own
 * (verified before approval, pages/api/admin/profile.js). So every upload
 * finalize -- gallery and marketplace, creator and admin -- now requires an
 * explicit answer to "does anyone besides the account holder appear in this
 * file?", sent as `othersAppear: true | false`. No answer, no upload.
 *
 * The rule, chosen over a "held pending review" state because it needs no
 * second, half-published kind of media that every serving path would have to
 * learn to hide:
 *   - `othersAppear: false` -- the creator attests it is only them. Stored on
 *     the item as `performers: { othersAppear: false, attestedAt }`.
 *   - `othersAppear: true` on the CREATOR's own finalize is refused (and the
 *     uploaded file deleted by the caller): content with a co-performer can
 *     only be published once the platform holds a §2257 record, with an ID on
 *     file, for every other person in it -- which is an admin step
 *     (team@onlyone1.fun). Creators cannot see or cite performer records.
 *   - `othersAppear: true` on the ADMIN finalize must list
 *     `coPerformerRecordIds`: each must be a non-archived performer record
 *     with an ID attached or held offline, and NOT one linked to the creator
 *     the file is for (their own record evidences nobody else). Stored on
 *     the item.
 *
 * Returns { attestation } or { status, error }.
 */
export const OTHERS_APPEAR_REQUIRED_MESSAGE =
  'Tell us whether anyone besides you appears in this file (othersAppear: true or false) before it can be published.';
export const CO_PERFORMER_REFUSED_MESSAGE =
  "Content showing anyone besides you can't be published yet: OnlyOne must hold an age/ID record for every person in it first. Email team@onlyone1.fun to add a co-performer's record, and an admin can publish it for you.";

export async function resolvePerformerAttestation(body, { admin = false, creatorId = null } = {}) {
  const othersAppear = body?.othersAppear;
  if (othersAppear !== true && othersAppear !== false) {
    return { status: 400, error: OTHERS_APPEAR_REQUIRED_MESSAGE };
  }
  const attestedAt = new Date().toISOString();
  if (othersAppear === false) return { attestation: { othersAppear: false, attestedAt } };
  if (!admin) return { status: 403, error: CO_PERFORMER_REFUSED_MESSAGE };

  const raw = body?.coPerformerRecordIds;
  const ids = Array.isArray(raw)
    ? [...new Set(raw.filter((v) => (typeof v === 'string' || typeof v === 'number') && /^[1-9]\d{0,17}$/.test(String(v))).map(String))]
    : [];
  if (!ids.length || ids.length !== (Array.isArray(raw) ? raw.length : 0) || ids.length > 20) {
    return { status: 400, error: 'List the §2257 record id of every other person who appears (coPerformerRecordIds).' };
  }
  const { rows } = await query(
    `select id::text as id, data->>'creatorId' as creator_id from performer_records
      where id::text = any($1::text[])
        and coalesce(data->>'status', 'active') <> 'archived'
        and (data->>'documentLocation' = 'offline'
             or (data->>'documentLocation' = 'in-app' and id_document is not null))`,
    [ids],
  );
  if (rows.length !== ids.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    return { status: 409, error: `No active §2257 record with an ID on file for: ${missing.join(', ')}.` };
  }
  // A record linked to THIS creator is their own and evidences nobody else:
  // ticking it answered "yes, someone else appears" while the platform held
  // no record for that other person. The admin finalize routes always pass
  // the creator id; without one, a co-performer answer is refused outright.
  if (creatorId === null || creatorId === undefined || String(creatorId) === '') {
    return { status: 400, error: 'Missing creator for the co-performer check.' };
  }
  const own = rows.filter((r) => r.creator_id !== null && String(r.creator_id) === String(creatorId)).map((r) => r.id);
  if (own.length) {
    return {
      status: 409,
      error: `Record ${own.map((id) => `#${id}`).join(', ')} is this creator's own §2257 record. List the record of every OTHER person who appears.`,
    };
  }
  return { attestation: { othersAppear: true, coPerformerRecordIds: ids, attestedAt } };
}
