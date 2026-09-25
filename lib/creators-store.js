import { creators as seedCreators } from '../data/creators';
import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import { deleteMediaQuietly, recordPendingDeletions } from './blob-cleanup';
import { lockMediaForFinalize } from './media-refs';
import { removeListingsForCreator } from './listings-store';
import { FOUNDING_LIMIT } from './founding';
import { enqueueStandingPushes } from './standing-outbox';
import { purgeUserContent } from './users-store';
import { snapshotReportedContentBeforeDelete } from './reports-store';
import {
  toPublicCreator,
  effectiveCreatorStatus,
  isPubliclyVisible,
  sanitizeSocials,
  sanitizeTags,
  sanitizeCategories,
  sanitizeAge,
  sanitizeLocation,
  UnderageProfile,
  toPublicListing,
  isValidListingPreview,
  LISTING_LIMITS,
  isDemoCreator,
  isDemoListing,
  listingHasDeliverable,
} from './creator-status';

// Re-exported so server-side callers can keep importing them from the store.
// CLIENT code must import them from './creator-status' instead -- importing
// this module in the browser pulls in the Postgres driver and fails the build.
export {
  toPublicCreator,
  effectiveCreatorStatus,
  isPubliclyVisible,
  sanitizeSocials,
  sanitizeTags,
  sanitizeCategories,
  sanitizeAge,
  sanitizeLocation,
  UnderageProfile,
  toPublicListing,
  isValidListingPreview,
  LISTING_LIMITS,
  isDemoCreator,
  isDemoListing,
  listingHasDeliverable,
};

/**
 * The launch demo roster is inserted once, the first time this runs against
 * an empty database, and never again.
 *
 * "Never again" is the important half. The old blob version treated a
 * missing manifest as "fall back to the seed roster", which meant wiping
 * every creator made the fake demo ones reappear as though they were real --
 * and worse, the first write after that persisted them alongside real
 * accounts. Recording the seeding in app_meta means an admin who deliberately
 * wipes everything (deleteAllCreators with includeSeed) gets an empty site,
 * not a repopulated demo one.
 */
async function seedOnce(client) {
  const { rows } = await client.query(`select 1 from app_meta where key = 'creators_seeded'`);
  if (rows.length) return;

  for (const creator of seedCreators) {
    const { id, ...rest } = creator;
    await client.query('insert into creators (id, data) values ($1, $2) on conflict (id) do nothing', [
      String(id),
      rest,
    ]);
  }
  await client.query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb) on conflict (key) do nothing`);
}

/**
 * Moves creators_id_seq past the highest numeric id already in the table.
 *
 * Run on EVERY process start, not only inside seedOnce: a database seeded
 * before this step existed (production's was) has the demo rows at explicit
 * ids 1..6 and a sequence still at 1, so the next real creator's
 * nextval() collided with a seed row on creators_pkey and the signup failed.
 * seedOnce returns early on an already-seeded database, so it never got the
 * chance to fix that.
 *
 * Only ever moves the sequence FORWARD (the WHERE compares against its current
 * position). Moving it back to max(id) after a creator was deleted would hand
 * the deleted creator's id to the next signup, and that id is still referenced
 * by their old listings, orders and violations.
 */
async function advanceCreatorIdSequence(client) {
  await client.query(
    `select setval('creators_id_seq', m.max_id)
       from (select coalesce(max(id::bigint), 0) as max_id from creators where id ~ '^[0-9]{1,18}$') m,
            creators_id_seq s
      where m.max_id > (case when s.is_called then s.last_value else s.last_value - 1 end)`,
  );
}

let seeded = null;
function ensureSeeded() {
  if (!seeded) {
    seeded = withTransaction(async (client) => {
      await seedOnce(client);
      await advanceCreatorIdSequence(client);
    }).catch((err) => {
      seeded = null; // don't cache a transient failure
      throw err;
    });
  }
  return seeded;
}

export async function getCreators() {
  await ensureSeeded();
  // The secondary sort key used to be plain `id` (text), so once real
  // (non-seed) ids passed single digits it sorted lexically -- "10" before
  // "2" -- once the sequence produced ten-plus real creators. Cast to
  // bigint for the numeric-looking ids (the only kind this store ever
  // assigns) so the order is numeric; any future non-numeric id still falls
  // back to the plain text sort, matching the first clause's own fallback.
  const { rows } = await query(
    `select id, data from creators
      order by (id ~ '^[0-9]+$') desc,
               case when id ~ '^[0-9]+$' then id::bigint end,
               id`,
  );
  return rowsToRecords(rows);
}

async function getCreatorById(creatorId) {
  const { rows } = await query('select id, data from creators where id = $1', [String(creatorId)]);
  return rows.length ? rowToRecord(rows[0]) : null;
}

export const GALLERY_CAP_EXCEEDED = 'gallery_cap_exceeded';

/**
 * Appends one gallery item.
 *
 * `knownGallery` is a snapshot the client captured when it STARTED this
 * upload -- if a second upload started before the first one's response came
 * back, that snapshot is stale (missing the first upload's item), and
 * appending to it would silently drop that item. It is therefore only a
 * last-resort fallback for a record with no gallery array at all; the append
 * itself is done by the database against the stored value, so two uploads
 * landing together both survive.
 *
 * `cap`, when given, is enforced inside the same UPDATE (so two uploads racing
 * at 49 of 50 cannot both land) and throws `.code === GALLERY_CAP_EXCEEDED`.
 * An item whose `src` is already in the gallery is not appended twice (a
 * retried finalize is a no-op).
 */
export async function addGalleryItem(creatorId, item, knownGallery, cap = null) {
  await ensureSeeded();
  const capValue = Number.isInteger(cap) && cap > 0 ? cap : null;
  const src = item && typeof item.src === 'string' ? item.src : null;
  // Under the file's lock, and refused if the file was already deleted (the
  // orphan sweep reaped it) -- lib/media-refs.js lockMediaForFinalize.
  return withTransaction(async (client) => {
    await lockMediaForFinalize(client, src);
    const { rows } = await client.query(
      `update creators
          set data = jsonb_set(
                jsonb_set(
                  data,
                  '{gallery}',
                  case when jsonb_typeof(data->'gallery') = 'array' then data->'gallery' else $3::jsonb end || $2::jsonb
                ),
                '{media}',
                to_jsonb(jsonb_array_length(
                  case when jsonb_typeof(data->'gallery') = 'array' then data->'gallery' else $3::jsonb end || $2::jsonb
                ))
              ),
              updated_at = now()
        where id = $1
          and ($4::int is null or jsonb_array_length(
                case when jsonb_typeof(data->'gallery') = 'array' then data->'gallery' else $3::jsonb end) < $4::int)
          and ($5::text is null or not (
                case when jsonb_typeof(data->'gallery') = 'array' then data->'gallery' else '[]'::jsonb end
                @> jsonb_build_array(jsonb_build_object('src', $5::text))))
        returning id, data`,
      [String(creatorId), JSON.stringify([item]), JSON.stringify(Array.isArray(knownGallery) ? knownGallery : []), capValue, src],
    );
    if (rows.length) return rowToRecord(rows[0]);

    const { rows: cur } = await client.query('select id, data from creators where id = $1', [String(creatorId)]);
    if (!cur.length) throw new Error('Creator not found');
    const current = rowToRecord(cur[0]);
    const gallery = Array.isArray(current.gallery) ? current.gallery : [];
    if (src && gallery.some((g) => g && g.src === src)) return current;
    throw Object.assign(new Error('Gallery is full'), { code: GALLERY_CAP_EXCEEDED });
  });
}

export async function addPendingCreator(profile) {
  await ensureSeeded();
  const { id: _ignored, ...rest } = profile || {};
  const newCreator = {
    status: 'pending',
    // NOT locked -- `locked` means token-gated (lib/token-gate.js), and
    // defaulting it on blurs a real creator's photos behind a gate they
    // never asked for. Same fix as pages/api/auth/signup.js.
    locked: false,
    trending: false,
    ...rest,
  };
  const { rows } = await query(
    `insert into creators (id, data) values (nextval('creators_id_seq')::text, $1) returning id, data`,
    [newCreator],
  );
  return rowToRecord(rows[0]);
}

export const FOUNDING_SLOTS_FULL = 'founding_slots_full';

/**
 * Merges `fields` into a creator record.
 *
 * `foundingSlot` is for a save that GRANTS Founding Creator ('require' for a
 * hand grant, 'try' for the automatic grant at approval). The 100-slot cap is
 * then checked and the write made inside ONE transaction holding an advisory
 * lock, so two approvals landing at 99 cannot both take the last slot (the
 * cap used to be read-all-creators-then-update with nothing in between).
 * Banned creators do not hold a slot (lib/founding.js countFounding).
 * 'require' throws `.code === FOUNDING_SLOTS_FULL` when full; 'try' drops the
 * grant (founding / foundingSince) and saves everything else.
 */
export async function updateCreatorProfile(creatorId, fields, { foundingSlot = null } = {}) {
  await ensureSeeded();
  const { id: _ignored, ...rest } = fields || {};
  const write = async (runner, patch) => {
    const { rows } = await runner.query(
      `update creators set data = data || $2::jsonb, updated_at = now()
        where id = $1 returning id, data`,
      [String(creatorId), JSON.stringify(patch)],
    );
    if (!rows.length) throw new Error('Creator not found');
    return rowToRecord(rows[0]);
  };
  if (!foundingSlot || rest.founding !== true) return write({ query }, rest);

  return withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('onlyone:founding-slots'))`);
    const { rows } = await client.query(
      `select count(*)::int as n from creators
        where coalesce((data->>'founding')::boolean, false)
          and coalesce(data->>'status', '') <> 'banned'
          and id <> $1`,
      [String(creatorId)],
    );
    let patch = rest;
    if (rows[0].n >= FOUNDING_LIMIT) {
      if (foundingSlot === 'require') {
        throw Object.assign(new Error(`All ${FOUNDING_LIMIT} Founding Creator slots are taken.`), { code: FOUNDING_SLOTS_FULL });
      }
      const { founding: _f, foundingSince: _s, ...others } = rest;
      patch = others;
    }
    return write(client, patch);
  });
}

/**
 * Replaces the avatar and deletes the previous file once the change has
 * committed. The old one used to stay in storage forever (every avatar change
 * wrote a new file and nothing removed the last). The previous value is read
 * under a row lock in the same transaction, so two replacements racing each
 * delete exactly the file they replaced.
 */
export async function setCreatorAvatar(creatorId, url, { performers = null, beforeChange } = {}) {
  await ensureSeeded();
  const { creator, previous } = await withTransaction(async (client) => {
    // A new uploaded photo is finalized under its file lock (see
    // addGalleryItem); a placeholder or site image needs none.
    await lockMediaForFinalize(client, url);
    const { rows } = await client.query('select data->>\'img\' as img from creators where id = $1 for update', [String(creatorId)]);
    if (!rows.length) throw new Error('Creator not found');
    // Runs on this locked transaction with the photo being replaced (an
    // admin takedown's evidence preservation and its record on the takedown
    // request, pages/api/admin/avatar.js), so it commits with the change or
    // not at all -- the same shape removeGalleryItem's beforeRemove has.
    if (typeof beforeChange === 'function') await beforeChange(client, rows[0].img || null);
    // `avatarPerformers` is the §2257 "does anyone else appear" attestation
    // for THIS avatar file (lib/performer-attestation.js), the same shape a
    // gallery item's `performers` has. Replaced with the photo, so it always
    // describes the current one (null for a placeholder / site image).
    const { rows: updated } = await client.query(
      `update creators set data = data || jsonb_build_object('img', $2::text, 'avatarPerformers', $3::jsonb), updated_at = now()
        where id = $1 returning id, data`,
      [String(creatorId), url, performers ? JSON.stringify(performers) : null],
    );
    const old = rows[0].img && rows[0].img !== url ? rows[0].img : null;
    // Recorded for deletion in this same commit (see recordPendingDeletions).
    if (old) await recordPendingDeletions(old, client);
    return { creator: rowToRecord(updated[0]), previous: old };
  });
  if (previous) await deleteMediaQuietly(previous);
  return creator;
}

export const GALLERY_ITEM_GONE = 'gallery_item_gone';

/**
 * Removes one gallery item, addressed by its `src` -- a stable identity --
 * rather than by position. Positional deletes let a stale view (the admin
 * panel open while the creator edits, or two devices) remove a DIFFERENT
 * photo from the one clicked, leaving the reported one up and reporting
 * success. `index` is only a hint: it is used when the item at that index has
 * that same src (the common case, and it disambiguates two identical srcs),
 * otherwise the item is found by src. No match throws GALLERY_ITEM_GONE.
 *
 * The row is locked for the duration, and the file itself is deleted after
 * the change commits.
 */
export async function removeGalleryItem(creatorId, { src, index, beforeRemove } = {}) {
  await ensureSeeded();
  if (typeof src !== 'string' || !src) {
    throw Object.assign(new Error('That item is no longer in the gallery'), { code: GALLERY_ITEM_GONE });
  }
  const { creator, removed } = await withTransaction(async (client) => {
    const { rows } = await client.query('select id, data from creators where id = $1 for update', [String(creatorId)]);
    if (!rows.length) throw new Error('Creator not found');
    const current = rowToRecord(rows[0]);
    const base = Array.isArray(current.gallery) ? [...current.gallery] : [];
    let at = Number.isInteger(index) && index >= 0 && index < base.length && base[index]?.src === src ? index : -1;
    if (at === -1) at = base.findIndex((item) => item && item.src === src);
    if (at === -1) {
      throw Object.assign(new Error('That item is no longer in the gallery'), { code: GALLERY_ITEM_GONE });
    }
    const [gone] = base.splice(at, 1);
    // Runs on this locked transaction once the item is confirmed present
    // (an evidence preservation, pages/api/admin/gallery-delete.js), so it
    // commits with the removal or not at all.
    if (typeof beforeRemove === 'function') await beforeRemove(client, gone);
    const { rows: updated } = await client.query(
      `update creators set data = data || $2::jsonb, updated_at = now()
        where id = $1 returning id, data`,
      [String(creatorId), JSON.stringify({ gallery: base, media: base.length })],
    );
    // Only delete the file if no other gallery entry still points at it;
    // recorded for deletion in this same commit (see recordPendingDeletions).
    const doomed = !base.some((item) => item && item.src === gone.src);
    if (doomed) await recordPendingDeletions(gone, client);
    return { creator: rowToRecord(updated[0]), removed: doomed ? gone : null };
  });
  if (removed) await deleteMediaQuietly(removed);
  return creator;
}

/**
 * `client` is optional: pass one from db.js's withTransaction() to run this
 * insert as part of a larger transaction (see pages/api/auth/signup.js,
 * which has to create the creator profile and the login account that owns
 * it atomically -- committed together or not at all).
 */
export async function createCreator(profile, client = null) {
  await ensureSeeded();
  // `id` is deliberately stripped: the column is the id, and letting a
  // caller's `...profile` spread supply one is how the admin "create model"
  // endpoint could previously produce two creators sharing an id.
  const { id: _ignored, ...rest } = profile || {};
  const newCreator = {
    name: 'New Model',
    handle: '@newmodel',
    img: '/images/mascot.png',
    video: null,
    price: '$9.99 / month',
    // NOT locked -- `locked` means token-gated (lib/token-gate.js), and
    // defaulting it on blurs a real creator's photos behind a gate they
    // never asked for. Same fix as pages/api/auth/signup.js.
    locked: false,
    trending: false,
    bio: '',
    gallery: [],
    ...rest,
  };
  const runner = client || { query };
  const { rows } = await runner.query(
    `insert into creators (id, data) values (nextval('creators_id_seq')::text, $1) returning id, data`,
    [newCreator],
  );
  return rowToRecord(rows[0]);
}

export const CREATOR_HAS_OBLIGATIONS = 'creator_has_obligations';

/**
 * Money and fulfilment still attached to a creator: the credit balance and
 * pending payout requests of their login account(s), and paid physical orders
 * not yet shipped. Deleting the creator deletes the login, and credit_balances
 * / payout_requests are keyed by that user id with no foreign key -- so a
 * silent delete stranded real, custodial money with nobody able to log in to
 * cash it out, and left paid orders unfulfillable.
 */
export async function getCreatorObligations(creatorIds, client = null) {
  const ids = (Array.isArray(creatorIds) ? creatorIds : [creatorIds]).map(String);
  const runner = client || { query };
  const out = new Map(ids.map((id) => [id, { creatorId: id, balanceCents: 0, pendingPayouts: 0, pendingPayoutCents: 0, pendingShipments: 0 }]));
  if (!ids.length) return out;
  const { rows: money } = await runner.query(
    `select u.data->>'creatorId' as creator_id,
            coalesce(sum(b.balance_cents), 0)::bigint as balance_cents
       from users u
       left join credit_balances b on b.user_id = u.id
      where u.data->>'creatorId' = any($1::text[])
      group by 1`,
    [ids],
  );
  for (const r of money) out.get(r.creator_id).balanceCents = Number(r.balance_cents);
  const { rows: payouts } = await runner.query(
    `select u.data->>'creatorId' as creator_id, count(*)::int as n, coalesce(sum(p.amount_cents), 0)::bigint as cents
       from users u join payout_requests p on p.user_id = u.id
      where u.data->>'creatorId' = any($1::text[]) and p.status = 'pending'
      group by 1`,
    [ids],
  );
  for (const r of payouts) {
    out.get(r.creator_id).pendingPayouts = r.n;
    out.get(r.creator_id).pendingPayoutCents = Number(r.cents);
  }
  const { rows: ships } = await runner.query(
    `select data->>'creatorId' as creator_id, count(*)::int as n
       from orders
      where data->>'creatorId' = any($1::text[]) and data->>'status' = 'pending_shipment'
      group by 1`,
    [ids],
  );
  for (const r of ships) out.get(r.creator_id).pendingShipments = r.n;
  return out;
}

function hasObligations(o) {
  return !!o && (o.balanceCents > 0 || o.pendingPayouts > 0 || o.pendingShipments > 0);
}

// The deleted creator's login account goes with it (an account whose creator
// profile is gone can do nothing). A plain "no matching creator" sweep rather
// than a delete keyed on one id, so it self-heals any earlier deletion too.
// Same statement as users-store's deleteOrphanedCreatorUsers, run on the
// deletion's own transaction so the two cannot come apart.
// Returns the deleted users' ids, so the caller can tell server/ those
// accounts are gone (lib/server-api.js pushUserStanding) -- once the user row
// is deleted there is nothing left to look the uid up by.
async function deleteOrphanedUsers(client) {
  const { rows } = await client.query(
    `delete from users
      where data->>'creatorId' is not null
        and not exists (select 1 from creators where creators.id = users.data->>'creatorId')
      returning id`,
  );
  return rows.map((r) => String(r.id));
}

// What a deleted creator's login wrote or saved goes with it, exactly as for a
// fan (lib/users-store.js purgeUserContent: their wall comments, sent DMs,
// favorites, notifications) -- plus every comment on their own wall, which has
// no page left to be shown on. Reported items are copied onto their reports
// first. Financial and moderation records stay. Runs on the deletion's own
// transaction, BEFORE the creator row goes (the login is found through it).
async function purgeCreatorContent(client, creatorIds) {
  const ids = creatorIds.map(String);
  if (!ids.length) return;
  const { rows: logins } = await client.query(
    `select id from users where data->>'creatorId' = any($1::text[])`,
    [ids],
  );
  for (const { id: uid } of logins) await purgeUserContent(client, String(uid));
  for (const cid of ids) {
    await snapshotReportedContentBeforeDelete(client, { wallCreatorId: cid });
  }
  await client.query(`delete from wall_posts where data->>'creatorId' = any($1::text[])`, [ids]);
}

function creatorMedia(creator) {
  if (!creator) return [];
  return [creator.img, creator.video, ...(Array.isArray(creator.gallery) ? creator.gallery : [])];
}

/**
 * Deletes one creator, their login account, their listings' availability and
 * every media file they uploaded -- EXCEPT the files of listings a buyer has
 * already paid for, which stay so /orders can keep delivering them (the media
 * route serves a paid listing's files to its buyers even once the seller's
 * record is gone).
 *
 * Refused (throws `.code === CREATOR_HAS_OBLIGATIONS`, with `.obligations`)
 * when the creator still has a credit balance, a pending payout or an
 * unshipped paid order, unless `force` is passed -- in which case the same
 * figures come back as `stranded` so the admin has a record of exactly what
 * was left behind. Suspend or ban instead to keep the money reachable.
 *
 * Returns { creators, stranded, removedUserIds } -- the site login ids that
 * went with it. Each is queued for server/ as banned in the same commit; the
 * caller delivers them (lib/server-api.js deliverFor).
 */
export async function deleteCreator(creatorId, { force = false } = {}) {
  await ensureSeeded();
  const id = String(creatorId);
  const { deleted, obligations, files, removedUserIds } = await withTransaction(async (client) => {
    const { rows } = await client.query('select id, data from creators where id = $1 for update', [id]);
    if (!rows.length) return { deleted: null, obligations: null, files: [], removedUserIds: [] };
    const obligations = (await getCreatorObligations([id], client)).get(id);
    if (hasObligations(obligations) && !force) {
      throw Object.assign(new Error('This creator still has money or unshipped orders attached.'), {
        code: CREATOR_HAS_OBLIGATIONS,
        obligations: [obligations],
      });
    }
    const deleted = rowToRecord(rows[0]);
    await purgeCreatorContent(client, [id]);
    await client.query('delete from creators where id = $1', [id]);
    const removedUserIds = await deleteOrphanedUsers(client);
    // Their server/ accounts are told 'banned' through the durable outbox,
    // queued in this same commit -- with the site login gone there is
    // nothing left to retry from otherwise (lib/standing-outbox.js).
    await enqueueStandingPushes(removedUserIds.map((uid) => ({ uid, status: 'banned', role: 'CREATOR' })), client);
    // Listings a buyer has paid for keep their files (see
    // removeListingsForCreator's keepPaid): deleting the seller must not
    // destroy what fans already bought. Same transaction as the creator row,
    // and every file about to be deleted is recorded for the orphan sweep in
    // it too -- the deletions after the commit used to be the only record
    // those files existed, so a throw or a timeout part-way left the
    // creator's content in storage with nothing pointing at it for good.
    const { files: listingFiles } = await removeListingsForCreator(id, { keepPaid: true, client });
    const files = [...creatorMedia(deleted), ...listingFiles];
    await recordPendingDeletions(files, client);
    return { deleted, obligations, files, removedUserIds };
  });
  if (deleted) await deleteMediaQuietly(files);
  return {
    creators: await getCreators(),
    stranded: deleted && hasObligations(obligations) ? [obligations] : [],
    removedUserIds: removedUserIds || [],
  };
}

/**
 * Defaults to wiping only real (non-seed) creators, so a routine cleanup
 * can't accidentally erase the launch demo roster along with everything
 * else -- pass includeSeed=true explicitly to also remove the seed rows.
 *
 * Creators with money or unshipped orders attached are SKIPPED (and listed in
 * `skipped`) unless `force` is passed, in which case they are deleted and
 * listed in `stranded`. Returns { creators, skipped, stranded, removedUserIds }.
 */
export async function deleteAllCreators(includeSeed, { force = false } = {}) {
  await ensureSeeded();
  const { deleted, skipped, stranded, files, removedUserIds } = await withTransaction(async (client) => {
    const { rows } = await client.query(
      includeSeed
        ? 'select id, data from creators for update'
        : `select id, data from creators where coalesce((data->>'seed')::boolean, false) = false for update`,
    );
    const candidates = rowsToRecords(rows);
    const obligations = await getCreatorObligations(candidates.map((c) => String(c.id)), client);
    const toDelete = [];
    const skipped = [];
    const stranded = [];
    for (const c of candidates) {
      const o = obligations.get(String(c.id));
      if (hasObligations(o)) {
        if (!force) {
          skipped.push({ ...o, name: c.name || null });
          continue;
        }
        stranded.push({ ...o, name: c.name || null });
      }
      toDelete.push(c);
    }
    const files = [];
    if (toDelete.length) {
      await purgeCreatorContent(client, toDelete.map((c) => String(c.id)));
      await client.query('delete from creators where id = any($1::text[])', [toDelete.map((c) => String(c.id))]);
    }
    const removedUserIds = await deleteOrphanedUsers(client);
    await enqueueStandingPushes(removedUserIds.map((uid) => ({ uid, status: 'banned', role: 'CREATOR' })), client);
    // As in deleteCreator: listings and the file records in the same commit.
    for (const c of toDelete) {
      const { files: listingFiles } = await removeListingsForCreator(String(c.id), { keepPaid: true, client });
      files.push(...creatorMedia(c), ...listingFiles);
    }
    await recordPendingDeletions(files, client);
    return { deleted: toDelete, skipped, stranded, files, removedUserIds };
  });
  if (deleted.length) await deleteMediaQuietly(files);
  return { creators: await getCreators(), skipped, stranded, removedUserIds };
}

const SUSPENSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Confirmed-content-violation enforcement ladder (decided 2026-09-17): the
 * first confirmed violation (currently: a non-consensual/deepfake report an
 * admin reviews and confirms) gets a 30-day suspension; a second gets a
 * permanent ban.
 *
 * Two cases the plain ladder got wrong, both handled in the statement below:
 *  - A PENDING applicant is not suspended. effectiveCreatorStatus() reads a
 *    lapsed suspension as 'active', so "suspended for 30 days" scheduled an
 *    applicant nobody had approved -- no §2257 record, signup text never
 *    screened -- to go public on its own a month later. They stay pending
 *    (still hidden, still needing an admin's approval) with the violation
 *    counted, so the next one bans them. Same rule as pages/api/admin/
 *    profile.js, which refuses pending -> suspended by hand.
 *  - An already-BANNED creator stays banned. A creator banned by hand (count
 *    0) used to be "downgraded" to a 30-day suspension by their first
 *    confirmed report.
 *
 * This is the ONLY implementation of the ladder. The NCII resolve path
 * (lib/ncii-reports-store.js) calls it with its own transaction client; it
 * used to carry a private copy without either guard above, and that copy was
 * the one production actually ran.
 *
 * A ban also ends Founding Creator status (founding false, foundingSince
 * cleared, foundingRevokedAt stamped) so a banned founder stops holding one of
 * the 100 slots -- the same rule pages/api/admin/profile.js applies to a ban
 * set by hand.
 *
 * Money: credits are custodial. A creator's earned credits are held in
 * credit_balances until paid out, and a suspension or ban FREEZES that
 * balance and any pending payout requests -- enforced in lib/credits-store.js
 * (transferWithFee refuses a frozen payer with ACCOUNT_FROZEN; requestPayout
 * refuses anyone not active; markPayoutPaid refuses a frozen account's payout
 * with PAYOUT_FROZEN unless an admin explicitly overrides, and rejectPayout
 * returns it to the still-frozen balance). A banned account's unpaid balance
 * is never paid out, which is the forfeiture Terms section 7 describes. None
 * of that is decided here; this only sets the status those checks read.
 *
 * The count is incremented by the database in the same statement that reads
 * it, so two admins confirming reports at the same moment cannot both read
 * "0 previous violations" and each apply a first-offence suspension to what
 * should have been a ban.
 *
 * `client` (optional) runs the UPDATE on a caller's transaction, so the count,
 * the status and whatever the caller commits with it (a takedown report's
 * resolution) are one commit. `reportId` (optional) makes it idempotent per
 * report: the id is recorded on the creator in the same statement, and a
 * report id already recorded is never counted again, however the resolve is
 * retried -- the creator comes back unchanged.
 *
 * On a ban, the creator's listings are taken down -- but only when this runs
 * on its own connection. With a `client`, the takedown (which deletes files
 * and cannot be rolled back) is left to the caller to run AFTER its commit;
 * the ban is enforced without it (a banned seller is hidden everywhere and
 * checkout refuses them).
 */
export async function applyContentViolation(creatorId, client = null, { reportId = null } = {}) {
  await ensureSeeded();
  const run = client ? (t, p) => client.query(t, p) : query;
  const report = reportId === null || reportId === undefined || reportId === '' ? null : String(reportId);
  const { rows } = await run(
    `update creators
        set data = data || (
              case
                when coalesce((data->>'contentViolationCount')::int, 0) + 1 >= 2
                  or data->>'status' = 'banned'
                  then jsonb_build_object(
                    'contentViolationCount', coalesce((data->>'contentViolationCount')::int, 0) + 1,
                    'status', 'banned',
                    'suspendedUntil', null,
                    -- A ban ends Founding Creator status and frees the slot
                    -- (see the doc comment above).
                    'founding', false,
                    'foundingSince', null,
                    'foundingRevokedAt', case when coalesce((data->>'founding')::boolean, false)
                                              then to_jsonb($4::text) else data->'foundingRevokedAt' end
                  )
                when data->>'status' = 'pending'
                  then jsonb_build_object(
                    'contentViolationCount', coalesce((data->>'contentViolationCount')::int, 0) + 1,
                    'status', 'pending',
                    'suspendedUntil', null
                  )
                else jsonb_build_object(
                    'contentViolationCount', coalesce((data->>'contentViolationCount')::int, 0) + 1,
                    'status', 'suspended',
                    'suspendedUntil', $2::text
                  )
              end
            ) || (
              case when $3::text is null then '{}'::jsonb
                   else jsonb_build_object(
                     'appliedNciiReportIds',
                     coalesce(data->'appliedNciiReportIds', '[]'::jsonb) || jsonb_build_array($3::text))
              end
            ),
            updated_at = now()
      where id = $1
        and ($3::text is null or not (coalesce(data->'appliedNciiReportIds', '[]'::jsonb) ? $3::text))
      returning id, data`,
    [String(creatorId), new Date(Date.now() + SUSPENSION_MS).toISOString(), report, new Date().toISOString()],
  );
  if (!rows.length) {
    const { rows: again } = await run('select id, data from creators where id = $1', [String(creatorId)]);
    if (!again.length) throw new Error('Creator not found');
    // Already counted for this report: idempotent, nothing changed.
    return rowToRecord(again[0]);
  }
  const creator = rowToRecord(rows[0]);

  // A permanent ban takes their listings off sale too, marks them as a
  // moderation removal (the owner can never relist them) and deletes their
  // files. Hiding the creator was not enough on its own: every public surface
  // resolved a listing's seller separately, so a banned creator's merch stayed
  // live with a working Buy button. Done only on a ban, never on a
  // suspension -- a suspension lifts by itself after 30 days and marking
  // listings removed would quietly turn a 30-day penalty into a permanent one.
  if (creator.status === 'banned' && !client) {
    await removeListingsForCreator(String(creatorId), { moderation: true });
  }

  return creator;
}

export { getCreatorById };

