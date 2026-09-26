/**
 * THE lock order for media files and the listings that carry them
 * (server-only). Every path that takes both kinds of lock takes them in this
 * order, and must keep doing so:
 *
 *   1. (a creator row, then an ncii_reports / reports row, when the path
 *      touches those at all)
 *   2. the per-file advisory locks, 'media-file:<pathname>', in ONE globally
 *      sorted pass over every file the transaction is going to touch;
 *   3. listing rows, FOR UPDATE, in id order;
 *   4. any file first seen on a row read under its lock (added between the
 *      unlocked peek and the row lock) -- locked last, which is safe: the
 *      finalize that added it has committed and released its own lock.
 *
 * The per-file lock is the one the orphan sweep deletes under (lib/media.js),
 * deleteMediaQuietly re-checks under (lib/blob-cleanup.js), a finalize takes
 * before recording a reference (lib/media-refs.js lockMediaForFinalize), and
 * preserveMedia/holdMediaForReport take before quarantining
 * (lib/media-preservation.js). A path that took listing rows first and files
 * second (the possible-minor NCII resolve did, through
 * removeListingsForCreator) could deadlock against checkout or a listing
 * quarantine, which take files first -- Postgres aborted one of them and an
 * admin resolving a 48-hour takedown got a 500 (round-8 media#0/social#0).
 * This file is the one place that order is written down, so it stops
 * drifting one call site at a time.
 */
import { mediaPathnames } from './blob-cleanup';

/** Every file of one listing record (media and retainedMedia). */
export function listingFileItems(listing) {
  return [
    ...(Array.isArray(listing?.media) ? listing.media : []),
    ...(Array.isArray(listing?.retainedMedia) ? listing.retainedMedia : []),
  ];
}

/**
 * Takes the per-file advisory lock for every stored file in `items` (srcs,
 * Blob URLs or { src } objects -- not bare pathnames) not already in `held`,
 * sorted by pathname, on `client`'s
 * transaction. Returns `held`, extended. Re-taking a lock this transaction
 * already holds is a no-op in Postgres, so `held` only saves round trips.
 */
export async function lockMediaFiles(client, items, held = new Set()) {
  const pathnames = [...new Set(mediaPathnames(items))].filter((p) => !held.has(p)).sort();
  for (const p of pathnames) {
    await client.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [p]);
    held.add(p);
  }
  return held;
}

function listingScope({ ids, creatorId }) {
  if (Array.isArray(ids)) {
    const list = [...new Set(ids.map(String))].filter((id) => /^[1-9]\d{0,17}$/.test(id));
    return { where: 'id = any($1::bigint[])', params: [list], empty: !list.length };
  }
  if (creatorId !== null && creatorId !== undefined && String(creatorId) !== '') {
    return { where: `data->>'creatorId' = $1`, params: [String(creatorId)], empty: false };
  }
  throw new Error('lockListingsWithFiles needs ids or creatorId');
}

/**
 * Step 2 alone: peeks (unlocked) at the listings named by `ids` or owned by
 * `creatorId` and locks all their files, plus `extraItems`, in one sorted
 * pass. For a caller that then locks the rows itself (checkout locks its cart
 * rows one by one). Returns `held`.
 */
export async function lockFilesOfListings(client, { ids = null, creatorId = null, extraItems = [], held = new Set() } = {}) {
  const scope = listingScope({ ids, creatorId });
  const peek = scope.empty ? [] : (await client.query(`select data from listings where ${scope.where}`, scope.params)).rows;
  return lockMediaFiles(client, [...extraItems, ...peek.flatMap((r) => listingFileItems(r.data))], held);
}

/**
 * Steps 2-4: locks the files of the listings named by `ids` (or owned by
 * `creatorId`) plus `extraItems`, then the listing rows FOR UPDATE in id
 * order, then any file only visible on the locked rows. Returns
 * { rows: [{ id, data }], held }.
 */
export async function lockListingsWithFiles(client, { ids = null, creatorId = null, extraItems = [], held = new Set() } = {}) {
  await lockFilesOfListings(client, { ids, creatorId, extraItems, held });
  const scope = listingScope({ ids, creatorId });
  const rows = scope.empty
    ? []
    : (await client.query(`select id, data from listings where ${scope.where} order by id for update`, scope.params)).rows;
  await lockMediaFiles(client, rows.flatMap((r) => listingFileItems(r.data)), held);
  return { rows, held };
}
