/**
 * Evidence preservation for media removed over a POSSIBLE MINOR report
 * (server-only).
 *
 * Every other removal path deletes the file (lib/blob-cleanup.js), which is
 * right for a TAKE IT DOWN request: the law wants it gone. For content that
 * may show someone under 18 it is exactly wrong. 18 U.S.C. 2258A requires a
 * provider that learns of apparent child sexual abuse material to report it
 * to NCMEC's CyberTipline and to PRESERVE the reported material (for one year
 * after the report). The resolve path used to ban the creator and delete
 * every file in the same request, and the admin panel then asked the admin to
 * "preserve what you removed" -- which by then was gone, unless they had
 * downloaded suspected CSAM to their own machine first.
 *
 * So these files are QUARANTINED instead of deleted:
 *
 *   - A row in media_preservations (lib/db.js) is written in the SAME
 *     transaction as the removal, keyed by the file's original pathname,
 *     linked to the report, with who/when/why and a retain_until one year
 *     out (PRESERVATION_DAYS). The file's media_uploads row (the orphan
 *     sweep's to-do list) is dropped in that transaction too.
 *   - Nothing deletes a preserved file: lib/blob-cleanup.js deleteMediaQuietly
 *     and recordPendingDeletions skip preserved pathnames, and
 *     lib/media.js sweepOrphanedMedia never claims one.
 *   - Any listing selling one is taken off sale in that same transaction
 *     (status 'removed', moderationRemoved), and checkout refuses a listing
 *     with a preserved file (listingMediaBlocked), taking the same per-file
 *     locks first so a quarantine and a sale can never interleave. A report
 *     HOLD does not affect sales -- only deletion.
 *   - Nothing serves one: lib/media.js sendMedia (the only way /api/media
 *     sends a file) answers 404 for a preserved pathname -- to the owner and
 *     to admins too. The only reader is GET /api/admin/preserved-media, which
 *     takes the admin key header (never the media cookie) and sends the file
 *     as a download.
 *   - After the commit the file is MOVED to `evidence/<report>/<pathname>`
 *     (movePreservedToEvidence), e.g. evidence/ncii-12/<pathname>. That prefix is not one lib/media.js
 *     parseMediaPathname accepts nor one the sweep records, so even a
 *     preservation row removed by hand would not make it servable again. A
 *     move that fails is retried by the scheduled sweep
 *     (/api/cron/maintenance); until then the file stays at its original path,
 *     still blocked by the row above.
 *
 * Retention: nothing here ever deletes a preserved file, including after
 * retain_until. Deleting evidence is a decision for the owner and counsel,
 * not a timer.
 */
import { rename, get, head, BlobNotFoundError } from '@vercel/blob';
import { Readable, pipeline } from 'stream';
import { query, withTransaction } from './db';
import { mediaPathnames } from './blob-cleanup';

export const PRESERVATION_DAYS = 365;
export const EVIDENCE_PREFIX = 'evidence/';

// Only files this app issues (lib/media.js's layout) can be preserved by path.
const OUR_PATH_RE = /^(avatars|gallery|listings)\//;

/**
 * Preservation rows name the report they belong to as '<kind>:<id>' --
 * 'ncii:12' for a takedown request (ncii_reports), 'report:5' for an
 * in-product report (reports). Two separate id sequences, so the kind is part
 * of the key.
 */
export function reportRef(kind, id) {
  return `${kind === 'report' ? 'report' : 'ncii'}:${String(id ?? '').replace(/[^0-9]/g, '')}`;
}

export function evidencePathnameFor(reportId, pathname) {
  const tag = String(reportId ?? 'unlinked').replace(/:/g, '-').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || 'unlinked';
  return `${EVIDENCE_PREFIX}${tag}/${pathname}`;
}

/**
 * Records `items` (srcs, URLs or { src } objects) as preserved evidence for
 * `reportId`, on the caller's transaction `client` when given (so the
 * preservation commits with the removal it protects). Idempotent: a file
 * already preserved keeps its first record, and its retain_until is only ever
 * pushed later. Returns the preserved pathnames.
 */
export async function preserveMedia(items, { reportId = null, reason, preservedBy = 'admin', client = null } = {}) {
  const pathnames = mediaPathnames(items).filter((p) => OUR_PATH_RE.test(p));
  if (!pathnames.length) return [];
  // The advisory locks below only hold for a transaction: without a caller
  // transaction, run in one of our own.
  if (!client) return withTransaction((c) => preserveMedia(items, { reportId, reason, preservedBy, client: c }));
  const runner = client;
  const why = String(reason || 'possible minor report').slice(0, 500);
  // The same per-file advisory lock the orphan sweep deletes under
  // (lib/media.js sweepOrphanedMedia), taken in a fixed order: a sweep
  // mid-delete on one of these files finishes first, and one that has not
  // started waits for this commit and then sees the preservation.
  for (const p of [...new Set(pathnames)].sort()) {
    await runner.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [p]);
  }
  // Off the orphan sweep's to-do list in the same commit: a 'delete_pending'
  // row written by the removal a moment ago must not be what deletes it.
  await runner.query('delete from media_uploads where pathname = any($1::text[])', [pathnames]);
  await runner.query(
    `insert into media_preservations (pathname, report_id, reason, preserved_by, retain_until)
       select p, $2::text, $3::text, $4::text, now() + ($5::int * interval '1 day')
         from unnest($1::text[]) as p
       on conflict (pathname) do update
         set retain_until = greatest(media_preservations.retain_until, excluded.retain_until)`,
    [pathnames, reportId === null || reportId === undefined ? null : String(reportId), why, String(preservedBy).slice(0, 100), PRESERVATION_DAYS],
  );
  // A quarantined file is never served again -- not to buyers either -- so a
  // listing that sells it must come off sale in this same commit. It used to
  // stay 'active': the admin quarantined a possibly-minor listing's files
  // first (the documented order) and fans kept buying it, paying
  // non-refundable credits for files /api/media then 404'd, while the
  // reported listing stayed in /marketplace.
  await takeListingsOffSaleFor(pathnames, runner);
  return pathnames;
}

/**
 * Every listing (other than a SOLD one -- 'sold' is terminal and is what its
 * order points back to) whose media or retainedMedia includes one of
 * `pathnames` is set to status 'removed' with `moderationRemoved: true` (so
 * the owner cannot relist it) and `quarantinedAt`. Files are NOT marked
 * deleted: they are evidence. Runs on the caller's transaction. Returns the
 * listing ids taken off sale.
 */
async function takeListingsOffSaleFor(pathnames, client) {
  if (!pathnames.length) return [];
  // A cheap text prefilter (a pathname appears verbatim in its src), then an
  // exact check through the same src parser every deletion path uses.
  const { rows } = await client.query(
    `select id, data from listings
      where coalesce(data->>'status', '') <> 'sold'
        and exists (select 1 from unnest($1::text[]) as p where strpos(data::text, p) > 0)
      order by id
      for update`,
    [pathnames],
  );
  const wanted = new Set(pathnames);
  const ids = rows
    .filter((r) => mediaPathnames([
      ...(Array.isArray(r.data?.media) ? r.data.media : []),
      ...(Array.isArray(r.data?.retainedMedia) ? r.data.retainedMedia : []),
    ]).some((p) => wanted.has(p)))
    .map((r) => String(r.id));
  if (!ids.length) return [];
  await client.query(
    `update listings
        set data = data || jsonb_build_object('status', 'removed', 'moderationRemoved', true,
                                              'quarantinedAt', coalesce(data->>'quarantinedAt', $2::text)),
            updated_at = now()
      where id::text = any($1::text[])`,
    [ids, new Date().toISOString()],
  );
  return ids;
}

/**
 * Is any file of this listing preserved evidence? Checkout refuses such a
 * listing (defense in depth: preserveMedia already takes it off sale in its
 * own commit, and a preserved file is never served).
 *
 * A report HOLD deliberately does NOT count. It used to: a hold blocked
 * checkout while /marketplace, the profile and the list API kept offering the
 * listing, so one account filing possible-minor reports (20 a minute) could
 * freeze sales of any listing on the site, indefinitely and unexplained. A
 * hold stops deletion only (see the section below); taking reported content
 * off sale is what an admin's PRESERVATION does, and that does block here.
 * Throws on a database error -- the caller must not sell on a failed check.
 */
export async function listingMediaBlocked(listing, client = null) {
  const pathnames = mediaPathnames([
    ...(Array.isArray(listing?.media) ? listing.media : []),
    ...(Array.isArray(listing?.retainedMedia) ? listing.retainedMedia : []),
  ]);
  if (!pathnames.length) return false;
  const runner = client || { query };
  const { rows } = await runner.query(
    'select 1 from media_preservations where pathname = any($1::text[]) limit 1',
    [pathnames],
  );
  return rows.length > 0;
}

/** The subset of `pathnames` that is preserved. Throws on a database error. */
export async function preservedSubset(pathnames, client = null) {
  const list = (Array.isArray(pathnames) ? pathnames : []).filter((p) => typeof p === 'string' && p);
  if (!list.length) return new Set();
  const runner = client || { query };
  const { rows } = await runner.query(
    'select pathname from media_preservations where pathname = any($1::text[])',
    [list],
  );
  return new Set(rows.map((r) => r.pathname));
}

// ---------------------------------------------------------------------------
// Report holds (media_holds, lib/db.js)
// ---------------------------------------------------------------------------
// A POSSIBLE MINOR report filed against a listing used to protect nothing
// until an admin resolved it: the reported seller could delete the files in
// the meantime (removeListingMediaForOwner, a new upload's error path), and by
// the time reports-resolve preserved `listing.media` there was nothing left.
// A hold is written in the SAME transaction as the report. It stops every
// deletion path (lib/blob-cleanup.js deleteMediaQuietly and
// recordPendingDeletions' post-commit delete, lib/media.js sweepOrphanedMedia
// and deleteUnfinalizedUpload) but NOT serving and NOT selling
// (listingMediaBlocked ignores holds) -- whether reported content also
// comes down while a report is unverified is an owner decision, and a hold
// that hid content would let any account take a listing down with one report.
// Released when the report is dismissed; superseded by a preservation when
// the content is removed (reports-resolve preserves the held files first).

/**
 * Holds `items` (srcs, URLs or { src } objects) for report `reportId`
 * ('report:5'), on the caller's transaction `client`, under the same
 * per-file advisory lock the orphan sweep deletes under, so a sweep mid-delete
 * finishes first and one not yet started sees the hold. Idempotent. Returns
 * the held pathnames.
 */
export async function holdMediaForReport(items, reportId, client) {
  const pathnames = [...new Set(mediaPathnames(items).filter((p) => OUR_PATH_RE.test(p)))].sort();
  if (!pathnames.length || !reportId) return [];
  if (!client) return withTransaction((c) => holdMediaForReport(items, reportId, c));
  for (const p of pathnames) {
    await client.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [p]);
  }
  await client.query(
    `insert into media_holds (pathname, report_id)
       select p, $2::text from unnest($1::text[]) as p
       on conflict do nothing`,
    [pathnames, String(reportId)],
  );
  return pathnames;
}

/** Releases every hold report `reportId` placed. Returns how many. */
export async function releaseHoldsForReport(reportId, client = null) {
  const runner = client || { query };
  const { rowCount } = await runner.query('delete from media_holds where report_id = $1', [String(reportId)]);
  return rowCount || 0;
}

/** The pathnames report `reportId` holds. */
export async function heldPathsForReport(reportId, client = null) {
  const runner = client || { query };
  const { rows } = await runner.query('select pathname from media_holds where report_id = $1 order by pathname', [String(reportId)]);
  return rows.map((r) => r.pathname);
}

/**
 * Is this pathname preserved evidence? Fails CLOSED: if the lookup itself
 * fails the answer is "yes", so a database hiccup can never be what serves
 * quarantined content.
 */
export async function isMediaPreserved(pathname) {
  if (typeof pathname !== 'string' || !pathname) return false;
  if (pathname.startsWith(EVIDENCE_PREFIX)) return true;
  try {
    return (await preservedSubset([pathname])).has(pathname);
  } catch (err) {
    console.error('[media-preservation] lookup failed; treating as preserved', pathname, err && err.message);
    return true;
  }
}

/**
 * Moves preserved files that are still at their original pathname into the
 * evidence prefix. Best effort, never throws; `renameFile` and `headFile` are
 * injectable for tests. Returns { moved, missing, failed }.
 *
 * Several callers run this at the same time (every resolve path, the admin
 * preserved-media action, the daily cron), and a rename is not idempotent: the
 * second rename of a file the first one already moved answers not-found. That
 * used to be recorded as `missing_at` -- marking evidence that sat intact
 * under evidence/ as destroyed, after which the export refused it. So each row
 * is now CLAIMED under the per-file advisory lock and re-read inside it (a row
 * another caller has finished is skipped), and a not-found rename first checks
 * whether the file is already at its evidence path (a move whose bookkeeping
 * UPDATE failed): if so that is recorded as the move, and only a file found in
 * neither place is marked missing -- and only while no evidence path is
 * recorded.
 */
export async function movePreservedToEvidence({ limit = 50, renameFile = rename, headFile = head } = {}) {
  const summary = { moved: 0, missing: 0, failed: 0 };
  if (!process.env.BLOB_READ_WRITE_TOKEN && renameFile === rename) return summary;
  let rows;
  try {
    ({ rows } = await query(
      `select pathname from media_preservations
        where evidence_pathname is null and missing_at is null
        order by preserved_at limit $1`,
      [Math.max(1, Math.min(Number(limit) || 50, 500))],
    ));
  } catch (err) {
    console.error('[media-preservation] could not list files to move', err && err.message);
    return summary;
  }
  for (const { pathname } of rows) {
    try {
      const outcome = await withTransaction(async (client) => {
        await client.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [pathname]);
        const { rows: cur } = await client.query(
          `select pathname, report_id from media_preservations
            where pathname = $1 and evidence_pathname is null and missing_at is null
            for update`,
          [pathname],
        );
        if (!cur.length) return 'skipped'; // another caller finished it
        const target = evidencePathnameFor(cur[0].report_id, pathname);
        try {
          await renameFile(pathname, target, { access: 'private', addRandomSuffix: false });
        } catch (err) {
          if (!(err instanceof BlobNotFoundError)) throw err;
          // Not at the source. Already moved (a rename whose UPDATE below
          // never committed), or really gone?
          if (await blobExists(headFile, target)) {
            await client.query(
              'update media_preservations set evidence_pathname = $2, moved_at = coalesce(moved_at, now()) where pathname = $1',
              [pathname, target],
            );
            return 'moved';
          }
          // Deleted before it could be preserved (an earlier removal, or never
          // uploaded). Recorded, so the admin view says so plainly.
          await client.query(
            'update media_preservations set missing_at = now() where pathname = $1 and evidence_pathname is null',
            [pathname],
          );
          return 'missing';
        }
        await client.query('update media_preservations set evidence_pathname = $2, moved_at = now() where pathname = $1', [pathname, target]);
        return 'moved';
      });
      if (outcome === 'moved') summary.moved++;
      else if (outcome === 'missing') summary.missing++;
    } catch (err) {
      console.error('[media-preservation] could not move to evidence', pathname, err && err.message);
      summary.failed++;
    }
  }
  return summary;
}

// head() answers the blob's metadata or throws BlobNotFoundError. Any other
// failure is thrown: "could not tell" must never be recorded as "missing".
async function blobExists(headFile, pathname) {
  try {
    await headFile(pathname);
    return true;
  } catch (err) {
    if (err instanceof BlobNotFoundError) return false;
    throw err;
  }
}

export async function listPreservedMedia({ reportId = null } = {}) {
  const { rows } = await query(
    `select pathname, report_id, reason, preserved_by, preserved_at, retain_until,
            evidence_pathname, moved_at, missing_at, last_exported_at, export_count
       from media_preservations
      where ($1::text is null or report_id = $1::text)
      order by preserved_at desc, pathname
      limit 1000`,
    [reportId === null || reportId === undefined ? null : String(reportId)],
  );
  return rows.map((r) => ({
    pathname: r.pathname,
    reportId: r.report_id,
    reason: r.reason,
    preservedBy: r.preserved_by,
    preservedAt: r.preserved_at,
    retainUntil: r.retain_until,
    evidencePathname: r.evidence_pathname,
    movedAt: r.moved_at,
    missingAt: r.missing_at,
    lastExportedAt: r.last_exported_at,
    exportCount: r.export_count,
  }));
}

/**
 * Sends one preserved file as a download (admin export). Every export that
 * actually delivers the file is counted and timestamped on the row -- a file
 * that cannot be read is not an export. Anything that is not a preserved
 * pathname is a 404.
 *
 * The file is looked for at its recorded evidence path, then its original
 * path, then the evidence path it WOULD have been moved to: a move whose
 * bookkeeping never committed (or a row wrongly marked missing by an older
 * concurrent move) still leaves the evidence exportable, and the row is
 * corrected when it is found there. Only a file found nowhere is marked
 * missing. `getFile` is injectable for tests.
 */
export async function sendPreservedMedia(res, pathname, { getFile = get } = {}) {
  res.setHeader('Cache-Control', 'private, no-store');
  const notFound = () => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
  };
  const { rows } = await query(
    'select pathname, report_id, evidence_pathname, missing_at from media_preservations where pathname = $1',
    [String(pathname)],
  );
  if (!rows.length) return notFound();
  const row = rows[0];
  const fallback = evidencePathnameFor(row.report_id, row.pathname);
  const candidates = [...new Set([row.evidence_pathname, row.pathname, fallback].filter(Boolean))];
  let result = null;
  let source = null;
  for (const candidate of candidates) {
    let r;
    try {
      r = await getFile(candidate, { access: 'private' });
    } catch (err) {
      if (!(err instanceof BlobNotFoundError)) throw err;
      r = null;
    }
    if (r && r.statusCode === 200 && r.stream) {
      result = r;
      source = candidate;
      break;
    }
    if (r && r.statusCode !== 404) return notFound(); // an unreadable answer is not "missing"
  }
  if (!result) {
    await query('update media_preservations set missing_at = coalesce(missing_at, now()) where pathname = $1', [row.pathname])
      .catch((err) => console.error('[media-preservation] could not mark missing', row.pathname, err && err.message));
    return notFound();
  }
  // Found somewhere the row did not say: correct it.
  const correction = source === fallback && row.evidence_pathname !== fallback
    ? query(
      'update media_preservations set evidence_pathname = $2, moved_at = coalesce(moved_at, now()), missing_at = null where pathname = $1',
      [row.pathname, fallback],
    )
    : row.missing_at
      ? query('update media_preservations set missing_at = null where pathname = $1', [row.pathname])
      : null;
  if (correction) await correction.catch((err) => console.error('[media-preservation] could not correct row', row.pathname, err && err.message));
  await query(
    'update media_preservations set last_exported_at = now(), export_count = export_count + 1 where pathname = $1',
    [row.pathname],
  );
  const file = source.split('/').pop();
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const len = result.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  pipeline(Readable.fromWeb(result.stream), res, (err) => {
    if (err) {
      console.error('[media-preservation] export stream failed', source, err && err.message);
      res.destroy(err);
    }
  });
}
