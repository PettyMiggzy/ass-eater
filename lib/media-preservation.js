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
import { rename, get, BlobNotFoundError } from '@vercel/blob';
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
  return pathnames;
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
 * evidence prefix. Best effort, never throws; `renameFile` is injectable for
 * tests. Returns { moved, missing, failed }.
 */
export async function movePreservedToEvidence({ limit = 50, renameFile = rename } = {}) {
  const summary = { moved: 0, missing: 0, failed: 0 };
  if (!process.env.BLOB_READ_WRITE_TOKEN && renameFile === rename) return summary;
  let rows;
  try {
    ({ rows } = await query(
      `select pathname, report_id from media_preservations
        where evidence_pathname is null and missing_at is null
        order by preserved_at limit $1`,
      [Math.max(1, Math.min(Number(limit) || 50, 500))],
    ));
  } catch (err) {
    console.error('[media-preservation] could not list files to move', err && err.message);
    return summary;
  }
  for (const r of rows) {
    const target = evidencePathnameFor(r.report_id, r.pathname);
    try {
      await renameFile(r.pathname, target, { access: 'private', addRandomSuffix: false });
      await query('update media_preservations set evidence_pathname = $2, moved_at = now() where pathname = $1', [r.pathname, target]);
      summary.moved++;
    } catch (err) {
      if (err instanceof BlobNotFoundError) {
        // Deleted before it could be preserved (an earlier removal, or never
        // uploaded). Recorded, so the admin view says so plainly.
        await query('update media_preservations set missing_at = now() where pathname = $1', [r.pathname]).catch(() => {});
        summary.missing++;
      } else {
        console.error('[media-preservation] could not move to evidence', r.pathname, err && err.message);
        summary.failed++;
      }
    }
  }
  return summary;
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
 * that cannot be read is not an export. A file found missing is marked
 * (missing_at) and answered 404, as is anything that is not a preserved
 * pathname.
 */
export async function sendPreservedMedia(res, pathname) {
  res.setHeader('Cache-Control', 'private, no-store');
  const notFound = () => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
  };
  const { rows } = await query(
    'select pathname, evidence_pathname from media_preservations where pathname = $1 and missing_at is null',
    [String(pathname)],
  );
  if (!rows.length) return notFound();
  const source = rows[0].evidence_pathname || rows[0].pathname;
  let result;
  try {
    result = await get(source, { access: 'private' });
  } catch (err) {
    if (!(err instanceof BlobNotFoundError)) throw err;
    result = null;
  }
  if (!result || result.statusCode !== 200 || !result.stream) {
    if (!result || result.statusCode === 404) {
      await query('update media_preservations set missing_at = coalesce(missing_at, now()) where pathname = $1', [rows[0].pathname])
        .catch((err) => console.error('[media-preservation] could not mark missing', source, err && err.message));
    }
    return notFound();
  }
  await query(
    'update media_preservations set last_exported_at = now(), export_count = export_count + 1 where pathname = $1',
    [rows[0].pathname],
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
