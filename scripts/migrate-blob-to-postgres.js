/**
 * One-time copy of the site's data out of the Vercel Blob JSON manifests and
 * into Postgres.
 *
 * Run it once, after DATABASE_URL is set and before (or right as) the
 * Postgres-backed build goes live:
 *
 *   DATABASE_URL=...  BLOB_READ_WRITE_TOKEN=...  node scripts/migrate-blob-to-postgres.js
 *
 * It prints what it would do and changes nothing unless you pass --apply:
 *
 *   ... node scripts/migrate-blob-to-postgres.js --apply
 *
 * Safe to run more than once. Every insert is "on conflict do nothing", so a
 * second run adds only what a first run missed and never duplicates or
 * overwrites a record that already exists in Postgres. It never deletes
 * anything, and it never touches the blobs -- the old manifests are left
 * exactly where they are, so this is reversible by simply not deploying.
 *
 * AFTERWARDS, and this is the part that actually closes the hole: the blob
 * manifests are still publicly readable at their URLs. Delete them from the
 * Vercel Blob dashboard once you have confirmed the site is reading from
 * Postgres. Copying the data does not un-publish the copy that is already
 * out there.
 */

const { head } = require('@vercel/blob');

const APPLY = process.argv.includes('--apply');

// Manifest path -> how to put one record into Postgres.
// `id` describes where the row's primary key comes from:
//   'record'   -> the record's own id (creators, users)
//   'identity' -> assigned by the database, the old id is dropped
//   'pair'     -> conversations, keyed by their existing composite id
const TABLES = [
  { path: 'data/creators.json', table: 'creators', id: 'record' },
  { path: 'data/users.json', table: 'users', id: 'record' },
  { path: 'data/listings.json', table: 'listings', id: 'identity' },
  { path: 'data/marketplace-orders.json', table: 'orders', id: 'identity' },
  { path: 'data/messages.json', table: 'conversations', id: 'pair' },
  { path: 'data/wall-posts.json', table: 'wall_posts', id: 'identity' },
  { path: 'data/reports.json', table: 'reports', id: 'identity' },
  { path: 'data/violations.json', table: 'violations', id: 'identity' },
  { path: 'data/ncii-reports.json', table: 'ncii_reports', id: 'identity' },
  { path: 'data/favorites.json', table: 'favorites', id: 'favorites' },
];

async function readManifest(path) {
  try {
    const info = await head(path);
    const res = await fetch(`${info.url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} reading ${path}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error(`${path} is not a JSON array`);
    return data;
  } catch (err) {
    if (/does not exist/i.test(String(err?.message)) && !/store does not exist/i.test(String(err?.message))) {
      return null; // never written -- nothing to migrate
    }
    throw err;
  }
}

async function main() {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    throw new Error('Set DATABASE_URL (or POSTGRES_URL) before running this.');
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('Set BLOB_READ_WRITE_TOKEN so the old manifests can be read.');
  }

  // Loaded lazily so the checks above fail with a clear message first.
  const { query, closePool } = await import('../lib/db.js');

  console.log(APPLY ? 'APPLYING migration.\n' : 'DRY RUN -- nothing will be written. Pass --apply to migrate.\n');

  let totalRead = 0;
  let totalWritten = 0;

  for (const spec of TABLES) {
    const records = await readManifest(spec.path);
    if (records === null) {
      console.log(`${spec.path.padEnd(32)} not present -- skipped`);
      continue;
    }
    totalRead += records.length;

    if (!APPLY) {
      const { rows } = await query(`select count(*)::int as c from ${spec.table}`);
      console.log(`${spec.path.padEnd(32)} ${String(records.length).padStart(5)} records  ->  ${spec.table} (currently ${rows[0].c})`);
      continue;
    }

    let written = 0;
    for (const record of records) {
      if (spec.id === 'favorites') {
        const r = await query(
          'insert into favorites (fan_id, creator_id) values ($1, $2) on conflict do nothing',
          [String(record.fanId), String(record.creatorId)],
        );
        written += r.rowCount;
        continue;
      }
      const { id, ...rest } = record;
      if (spec.id === 'identity') {
        // The old id is deliberately dropped: these tables assign their own,
        // and keeping a stale one inside `data` would shadow nothing but
        // confuse anyone reading a row later.
        const r = await query(`insert into ${spec.table} (data) values ($1)`, [rest]);
        written += r.rowCount;
      } else {
        const r = await query(
          `insert into ${spec.table} (id, data) values ($1, $2) on conflict (id) do nothing`,
          [String(id), rest],
        );
        written += r.rowCount;
      }
    }
    totalWritten += written;
    console.log(`${spec.path.padEnd(32)} ${String(records.length).padStart(5)} read -> ${String(written).padStart(5)} inserted into ${spec.table}`);
  }

  if (APPLY) {
    // Creators carry real ids from the old manifest, so the sequence that
    // hands out new ones has to start above every one of them or the next
    // signup collides with an existing creator.
    await query(
      `select setval('creators_id_seq', greatest((select coalesce(max((id)::bigint), 0) from creators where id ~ '^[0-9]+$'), 1))`,
    );
    // The demo roster was already inserted by whatever wrote these manifests;
    // mark seeding done so the app does not add it a second time.
    await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb) on conflict (key) do nothing`);
    console.log(`\nDone. ${totalRead} records read, ${totalWritten} inserted.`);
    console.log('\nNEXT, and do not skip it: the old manifests are STILL PUBLICLY READABLE');
    console.log('at their blob URLs. Delete them in the Vercel Blob dashboard once the');
    console.log('site is confirmed to be reading from Postgres. Copying the data does not');
    console.log('un-publish the copy already out there.');
  } else {
    console.log(`\n${totalRead} records would be migrated. Re-run with --apply.`);
  }

  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
