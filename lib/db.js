import pg from 'pg';

const { Pool, types } = pg;

// node-postgres returns int8 (bigint) as a STRING by default, to avoid
// silently losing precision above 2^53. The identity columns here are row
// counters for reports, violations, takedown requests and wall comments --
// they will not reach 9 quadrillion -- and every caller and stored record
// treated these ids as numbers before Postgres existed. Parsing them back to
// Number keeps that contract exactly, instead of quietly changing the type of
// every id the app has ever handed out.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));

/**
 * Postgres access for the live site.
 *
 * WHY THIS REPLACED THE BLOB JSON FILES. Every store used to be a single
 * JSON file in Vercel Blob, read whole and written whole. That had two
 * problems, both of which actually bit:
 *
 *  1. PRIVACY. Blob objects are served from a public URL. The store's
 *     hostname appears in every image URL on the site, and the manifest
 *     paths were fixed ("data/creators.json"), so anyone could fetch the
 *     raw file. Verified against production on 2026-09-18:
 *     data/creators.json returned 200 to an anonymous request, including
 *     walletAddress and payoutMethod -- the exact fields toPublicCreator()
 *     strips from page props. users.json (password hashes), messages.json
 *     (every private DM) and ncii-reports.json (victim identities) would
 *     have been readable the same way the moment they existed.
 *  2. LOST WRITES. Read-whole-file / write-whole-file has no atomicity.
 *     An ETag precondition was bolted on and helped, but the underlying
 *     shape stayed wrong, and a mishandled read failure silently wrote an
 *     empty list over a whole manifest -- see MEMORY.md.
 *
 * Postgres fixes both at the root: nothing is ever served at a URL, and a
 * write is a row-level UPDATE inside a transaction rather than a
 * whole-file overwrite.
 *
 * SHAPE. Each store keeps its record as a `data` jsonb column with a real
 * `id` primary key, rather than being fully normalised into typed columns.
 * That is a deliberate trade, not laziness: it fixes both problems above
 * while leaving every record the exact same JavaScript object the pages
 * and API routes already expect, so the migration does not also become a
 * rewrite of every caller. Fields that get filtered or sorted on have
 * expression indexes. Normalise later if real queries need it.
 *
 * Deliberately NOT duplicating fields into their own columns beside
 * `data`: two copies of the same value drift, and the drift is silent.
 */

const SCHEMA = `
create table if not exists creators (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists creators_handle_idx on creators ((lower(data->>'handle')));
-- A handle is how a creator is addressed and how a referral link resolves
-- (pages/api/auth/signup.js matches ?ref= against it), so two creators
-- holding the same one means referral credit goes to whichever row a
-- .find() happens to hit first. Enforced in the database rather than by a
-- read-then-check, which two concurrent saves both pass.
--
-- Partial, and created inside a DO block that swallows its own failure on
-- purpose: this schema runs at startup on every boot, and if existing rows
-- already collide, a bare CREATE UNIQUE INDEX throws and takes the whole
-- site down rather than leaving one duplicate handle in place. The blank
-- exclusion is because "no handle set yet" is a real state for a pending
-- application and is not a collision with another blank one.
do $$
begin
  create unique index if not exists creators_handle_unique_idx
    on creators ((lower(btrim(data->>'handle'))))
    where btrim(coalesce(data->>'handle', '')) <> '';
exception when others then
  raise warning 'creators_handle_unique_idx not created: %', sqlerrm;
end $$;
-- New creator ids come from a sequence rather than "max(existing) + 1"
-- computed in JavaScript, which two concurrent signups could both read
-- before either wrote. Seeding advances it past the demo roster's ids.
create sequence if not exists creators_id_seq as bigint start 1;

-- One row per one-time setup step, so a step that must happen exactly once
-- (seeding the demo roster) can record that it did. Without this, an admin
-- wiping every creator including the seeds would have them silently
-- reappear on the next read.
create table if not exists app_meta (
  key         text primary key,
  value       jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists creators_status_idx on creators ((data->>'status'));

create table if not exists users (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);
-- The login identifier is unique case-insensitively AND ignoring
-- surrounding whitespace. This is a real constraint rather than a
-- read-then-check in application code, so two simultaneous signups for the
-- same address cannot both succeed.
--
-- btrim as well as lower, and it has to match normalizeIdentifier() in
-- users-store.js exactly: that function trims, so if the index did not,
-- " a@b.com" and "a@b.com" would be two rows the constraint allows but one
-- lookup matches -- which login resolves by picking whichever came back
-- first.
create unique index if not exists users_email_lower_idx on users ((lower(btrim(data->>'email'))));
create index if not exists users_creator_id_idx on users ((data->>'creatorId'));

create table if not exists listings (
  -- Identity rather than an application-generated id: these used to be
  -- numbered "highest existing + 1", computed in JavaScript from a list read
  -- moments earlier, which is the same collision the user-id fix already had
  -- to undo. The database assigns these now, so two at once cannot collide.
  id          bigint generated always as identity primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists listings_creator_idx on listings ((data->>'creatorId'));
create index if not exists listings_status_idx on listings ((data->>'status'));

create table if not exists orders (
  -- Identity rather than an application-generated id: these used to be
  -- numbered "highest existing + 1", computed in JavaScript from a list read
  -- moments earlier, which is the same collision the user-id fix already had
  -- to undo. The database assigns these now, so two at once cannot collide.
  id          bigint generated always as identity primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists orders_buyer_idx on orders ((data->>'buyerId'));
create index if not exists orders_creator_idx on orders ((data->>'creatorId'));

create table if not exists conversations (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
-- Participant lookup has to hit an index, not scan every conversation on
-- the platform, once there is real message volume.
create index if not exists conversations_participants_idx on conversations using gin ((data->'participantIds'));

create table if not exists wall_posts (
  id          bigint generated always as identity primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists wall_posts_creator_idx on wall_posts ((data->>'creatorId'));

create table if not exists favorites (
  fan_id      text not null,
  creator_id  text not null,
  created_at  timestamptz not null default now(),
  primary key (fan_id, creator_id)
);
create index if not exists favorites_fan_idx on favorites (fan_id);

create table if not exists reports (
  id          bigint generated always as identity primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

create table if not exists violations (
  id          bigint generated always as identity primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists violations_user_idx on violations ((data->>'userId'));

create table if not exists ncii_reports (
  id          bigint generated always as identity primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

-- Pre-launch notify-me list. One row per address, so two people signing up
-- at the same moment cannot overwrite each other.
--
-- The unique index is what makes a repeat signup idempotent rather than a
-- read-then-check race, and it HAS TO stay in step with
-- normalizeWaitlistEmail() in lib/waitlist-store.js: that trims and
-- lowercases, so this index trims and lowercases too. If one side stops
-- doing either, " A@b.com" and "a@b.com" become two rows that one lookup
-- matches -- the same trap already documented on the users table.
create table if not exists waitlist (
  id          bigint generated always as identity primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);
create unique index if not exists waitlist_email_idx on waitlist (lower(btrim(data->>'email')));
create index if not exists waitlist_created_idx on waitlist (created_at desc);

-- 18 U.S.C. §2257 performer records. See lib/performer-records-store.js for
-- what goes in which column and why.
--
-- id_document is its own column rather than a field inside the data blob
-- for one specific reason: it holds an encrypted scan of a government ID,
-- several megabytes of it, and the record list must be readable without
-- dragging every performer's ID document into memory. Listing selects the
-- data column only; the document is fetched one row at a time by its own
-- admin endpoint.
create table if not exists performer_records (
  id           bigint generated always as identity primary key,
  data         jsonb not null,
  id_document  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- The statute requires records be retrievable by every name a performer has
-- worked under and by where the content appears, so those two are the index.
create index if not exists performer_records_aliases_idx on performer_records using gin ((data->'aliases'));
create index if not exists performer_records_urls_idx on performer_records using gin ((data->'contentUrls'));
create index if not exists performer_records_status_idx on performer_records ((data->>'status'));
`;

let pool = null;
let schemaReady = null;

function connectionString() {
  // Vercel's Postgres integrations expose several names depending on which
  // one is attached; accept any of them rather than making the deployment
  // depend on picking the right alias.
  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.DATABASE_POSTGRES_URL;
  if (!url) {
    throw new Error(
      'No Postgres connection string. Set DATABASE_URL (or POSTGRES_URL) -- the site stores every account, listing, message and takedown report there.',
    );
  }
  return url;
}

export function isDatabaseConfigured() {
  return Boolean(
    process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      process.env.DATABASE_POSTGRES_URL,
  );
}

function getPool() {
  if (pool) return pool;
  const url = connectionString();
  pool = new Pool({
    connectionString: url,
    // Serverless: many short-lived instances, each wanting connections. Keep
    // each instance's pool tiny and let the provider's pooler do the real
    // multiplexing -- a big per-instance pool is how a serverless app
    // exhausts a Postgres connection limit.
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Managed Postgres (Neon, Supabase, RDS) terminates TLS with a cert this
    // container has no root for. `sslmode=require` in the URL is respected
    // by pg only for whether to use TLS, not for verification, so be
    // explicit -- and only when the URL is not a local socket/localhost.
    ...(/localhost|127\.0\.0\.1/.test(url) ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  pool.on('error', (err) => {
    // An idle client erroring must not take the process down.
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

/**
 * Creates the schema if it is not there yet. Runs at most once per process,
 * and is safe to run concurrently from many instances -- every statement is
 * `if not exists`.
 */
export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(SCHEMA)
      .catch((err) => {
        // Don't cache a failure: a transient connection problem at boot
        // would otherwise poison every later request in this instance.
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

export async function query(text, params) {
  await ensureSchema();
  return getPool().query(text, params);
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction(fn) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // The rollback failing is not the error worth surfacing -- the
      // original one is.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A stored row back into the plain object the rest of the app expects.
 * `id` lives in its own column (so it can be a real primary key and, where
 * relevant, a real identity sequence) and is merged back in on read. It is
 * merged FIRST so a stale `id` inside `data` can never shadow the real one.
 */
export function rowToRecord(row) {
  if (!row) return null;
  // `row.id` is already the right type: text for the text-keyed tables,
  // Number for the identity-keyed ones (see the int8 parser above). Don't
  // coerce it again -- a text id that happens to look numeric must stay a
  // string, or two different creators ("07" and "7") could collide.
  return { ...row.data, id: row.id };
}

export function rowsToRecords(rows) {
  return rows.map(rowToRecord);
}

/** Test/maintenance helper: closes the pool so a script can exit. */
export async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    schemaReady = null;
    await p.end();
  }
}
