/**
 * THE lock order for media files and the listings that carry them
 * (server-only). Every path that takes both kinds of lock takes them in this
 * order, and must keep doing so:
 *
 *   1. account rows, when the path touches them at all: login (users) rows,
 *      then creator rows, each in id order, then an ncii_reports / reports
 *      row. Checkout takes the buyer's and sellers' users and creators rows
 *      FOR SHARE here, before any file (lib/orders-store.js placeOrders) --
 *      it used to reach them only inside transferWithFee, after the files and
 *      listing rows, the reverse of an NCII resolve or a creator deletion
 *      (round-9 money#0);
 *   2. the per-file advisory locks, 'media-file:<pathname>', in ONE globally
 *      sorted pass over every file the transaction is going to touch;
 *   3. listing rows, FOR UPDATE, in id order;
 *   4. any file first seen on a row read under its lock (added between the
 *      unlocked peek and the row lock). This is NOT simply safe to block on:
 *      the finalize that added it has committed, but a THIRD transaction
 *      that peeked after that finalize may hold the new file (it sorts first
 *      half the time) while waiting on a file this one holds -- a deadlock
 *      (round-9 media#1). So a late file is never waited for:
 *      lockListingsWithFiles rolls back to a savepoint taken before step 2
 *      (releasing its file and row locks) and starts over with the new file
 *      in the sorted pass; checkout, whose file locks span the whole cart,
 *      try-locks it and retries the whole transaction if it is busy.
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
 * Takes the per-file lock for every file in `items` not already in `held`
 * WITHOUT waiting. Returns true when all were taken (and adds them to
 * `held`), false as soon as one is busy -- the caller must then give up its
 * locks and start over (see step 4 in the header), never wait.
 */
export async function tryLockMediaFiles(client, items, held = new Set()) {
  const pathnames = [...new Set(mediaPathnames(items))].filter((p) => !held.has(p)).sort();
  for (const p of pathnames) {
    const { rows } = await client.query(`select pg_try_advisory_xact_lock(hashtext('media-file:' || $1)) as ok`, [p]);
    if (!rows[0]?.ok) return false;
    held.add(p);
  }
  return true;
}

/** Thrown when a late file stays busy through every restart (retryable). */
export const MEDIA_LOCK_BUSY = 'MEDIA_LOCK_BUSY';
const RESTARTS = 5;
let savepointSeq = 0;

/**
 * Steps 2-4: locks the files of the listings named by `ids` (or owned by
 * `creatorId`) plus `extraItems`, then the listing rows FOR UPDATE in id
 * order. If the locked rows carry a file the sorted pass did not (a finalize
 * committed in between), everything taken here is released by rolling back to
 * a savepoint and the pass starts over with that file included, so no file is
 * ever waited for out of sorted order. `client` must be inside a transaction.
 * Returns { rows: [{ id, data }], held }.
 */
export async function lockListingsWithFiles(client, { ids = null, creatorId = null, extraItems = [], held = new Set() } = {}) {
  const scope = listingScope({ ids, creatorId });
  const before = new Set(held);
  let extra = [...extraItems];
  for (let attempt = 1; ; attempt++) {
    const sp = `oa_media_locks_${++savepointSeq}`;
    await client.query(`savepoint ${sp}`);
    const taken = new Set(before);
    await lockFilesOfListings(client, { ids, creatorId, extraItems: extra, held: taken });
    const rows = scope.empty
      ? []
      : (await client.query(`select id, data from listings where ${scope.where} order by id for update`, scope.params)).rows;
    const late = rows
      .flatMap((r) => listingFileItems(r.data))
      .filter((item) => mediaPathnames([item]).some((p) => !taken.has(p)));
    if (!late.length) {
      await client.query(`release savepoint ${sp}`);
      for (const p of taken) held.add(p);
      return { rows, held };
    }
    if (attempt < RESTARTS) {
      // Releases the file and row locks taken since the savepoint; the next
      // pass locks the late files in their sorted place.
      await client.query(`rollback to savepoint ${sp}`);
      await client.query(`release savepoint ${sp}`);
      extra = [...extra, ...late];
      continue;
    }
    // Still changing after every restart: take the late files only if they
    // are free right now, never by waiting.
    if (await tryLockMediaFiles(client, late, taken)) {
      await client.query(`release savepoint ${sp}`);
      for (const p of taken) held.add(p);
      return { rows, held };
    }
    await client.query(`rollback to savepoint ${sp}`);
    await client.query(`release savepoint ${sp}`);
    throw Object.assign(new Error('Those files are busy -- try again in a moment.'), { code: MEDIA_LOCK_BUSY });
  }
}
