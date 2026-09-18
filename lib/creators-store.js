import { creators as seedCreators } from '../data/creators';
import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import {
  toPublicCreator,
  effectiveCreatorStatus,
  isPubliclyVisible,
  sanitizeSocials,
  sanitizeTags,
} from './creator-status';

// Re-exported so server-side callers can keep importing them from the store.
// CLIENT code must import them from './creator-status' instead -- importing
// this module in the browser pulls in the Postgres driver and fails the build.
export { toPublicCreator, effectiveCreatorStatus, isPubliclyVisible, sanitizeSocials, sanitizeTags };

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
  // Move the id sequence past the seeds so a new creator never collides with one.
  await client.query(
    `select setval('creators_id_seq', greatest((select coalesce(max((id)::bigint), 0) from creators where id ~ '^[0-9]+$'), 1))`,
  );
  await client.query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb) on conflict (key) do nothing`);
}

let seeded = null;
function ensureSeeded() {
  if (!seeded) {
    seeded = withTransaction(seedOnce).catch((err) => {
      seeded = null; // don't cache a transient failure
      throw err;
    });
  }
  return seeded;
}

export async function getCreators() {
  await ensureSeeded();
  const { rows } = await query(`select id, data from creators order by (id ~ '^[0-9]+$') desc, id`);
  return rowsToRecords(rows);
}

async function getCreatorById(creatorId) {
  const { rows } = await query('select id, data from creators where id = $1', [String(creatorId)]);
  return rows.length ? rowToRecord(rows[0]) : null;
}

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
 */
export async function addGalleryItem(creatorId, item, knownGallery) {
  await ensureSeeded();
  const { rows } = await query(
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
      returning id, data`,
    [String(creatorId), JSON.stringify([item]), JSON.stringify(Array.isArray(knownGallery) ? knownGallery : [])],
  );
  if (!rows.length) throw new Error('Creator not found');
  return rowToRecord(rows[0]);
}

export async function addPendingCreator(profile) {
  await ensureSeeded();
  const { id: _ignored, ...rest } = profile || {};
  const newCreator = {
    status: 'pending',
    locked: true,
    trending: false,
    subs: '0',
    posts: 0,
    media: profile?.gallery?.length || 0,
    likes: '0',
    ...rest,
  };
  const { rows } = await query(
    `insert into creators (id, data) values (nextval('creators_id_seq')::text, $1) returning id, data`,
    [newCreator],
  );
  return rowToRecord(rows[0]);
}

export async function updateCreatorProfile(creatorId, fields) {
  await ensureSeeded();
  const { id: _ignored, ...rest } = fields || {};
  const { rows } = await query(
    `update creators set data = data || $2::jsonb, updated_at = now()
      where id = $1 returning id, data`,
    [String(creatorId), JSON.stringify(rest)],
  );
  if (!rows.length) throw new Error('Creator not found');
  return rowToRecord(rows[0]);
}

export async function setCreatorAvatar(creatorId, url) {
  return updateCreatorProfile(creatorId, { img: url });
}

/**
 * Removes the gallery item at `index`.
 *
 * Positional by nature, so this locks the row for the duration rather than
 * computing against a value read earlier: two quick delete clicks used to be
 * able to resolve against the same stale array and remove the wrong photo,
 * with both reporting success. `knownGallery` stays a last-resort fallback
 * only, for the same reason as addGalleryItem.
 */
export async function removeGalleryItem(creatorId, index, knownGallery) {
  await ensureSeeded();
  return withTransaction(async (client) => {
    const { rows } = await client.query('select id, data from creators where id = $1 for update', [String(creatorId)]);
    if (!rows.length) throw new Error('Creator not found');
    const current = rowToRecord(rows[0]);
    const base = Array.isArray(current.gallery)
      ? [...current.gallery]
      : Array.isArray(knownGallery)
        ? [...knownGallery]
        : [];
    base.splice(index, 1);
    const { rows: updated } = await client.query(
      `update creators set data = data || $2::jsonb, updated_at = now()
        where id = $1 returning id, data`,
      [String(creatorId), JSON.stringify({ gallery: base, media: base.length })],
    );
    return rowToRecord(updated[0]);
  });
}

export async function createCreator(profile) {
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
    subs: '0',
    price: '1M $ONLYASS',
    locked: true,
    trending: false,
    bio: '',
    posts: 0,
    media: 0,
    likes: '0',
    gallery: [],
    ...rest,
  };
  const { rows } = await query(
    `insert into creators (id, data) values (nextval('creators_id_seq')::text, $1) returning id, data`,
    [newCreator],
  );
  return rowToRecord(rows[0]);
}

export async function deleteCreator(creatorId) {
  await ensureSeeded();
  await query('delete from creators where id = $1', [String(creatorId)]);
  return getCreators();
}

// Defaults to wiping only real (non-seed) creators, so a routine cleanup
// can't accidentally erase the launch demo roster along with everything
// else -- pass includeSeed=true explicitly to also remove the seed rows.
export async function deleteAllCreators(includeSeed) {
  await ensureSeeded();
  if (includeSeed) {
    await query('delete from creators');
  } else {
    await query(`delete from creators where coalesce((data->>'seed')::boolean, false) = false`);
  }
  return getCreators();
}

const SUSPENSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Confirmed-content-violation enforcement ladder (decided 2026-09-17): the
 * first confirmed violation (currently: a non-consensual/deepfake report an
 * admin reviews and confirms) gets a 30-day suspension; a second gets a
 * permanent ban. "Forfeit funds owed" is a real, separate step that only
 * has something to act on once a custodial balance exists -- this live
 * site's payments are direct wallet-to-wallet transfers with no
 * platform-held balance (see Terms of Service Section 5), so a ban here
 * has no funds of the platform's to seize. The equivalent needs building
 * into server/'s ledger once that stack is the one taking payments.
 *
 * The count is incremented by the database in the same statement that reads
 * it, so two admins confirming reports at the same moment cannot both read
 * "0 previous violations" and each apply a first-offence suspension to what
 * should have been a ban.
 */
export async function applyContentViolation(creatorId) {
  await ensureSeeded();
  const { rows } = await query(
    `update creators
        set data = data || (
              case
                when coalesce((data->>'contentViolationCount')::int, 0) + 1 >= 2
                  then jsonb_build_object(
                    'contentViolationCount', coalesce((data->>'contentViolationCount')::int, 0) + 1,
                    'status', 'banned',
                    'suspendedUntil', null
                  )
                else jsonb_build_object(
                    'contentViolationCount', coalesce((data->>'contentViolationCount')::int, 0) + 1,
                    'status', 'suspended',
                    'suspendedUntil', $2::text
                  )
              end
            ),
            updated_at = now()
      where id = $1
      returning id, data`,
    [String(creatorId), new Date(Date.now() + SUSPENSION_MS).toISOString()],
  );
  if (!rows.length) throw new Error('Creator not found');
  return rowToRecord(rows[0]);
}

export { getCreatorById };

