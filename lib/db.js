import { createHash } from 'node:crypto';
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

// The admin queues' sort keys (lib/ncii-reports-store.js getNciiReportsPage,
// lib/reports-store.js getReportsPage). Defined HERE, and imported by those
// stores, because the queue indexes below are built on the very same
// expressions: Postgres only uses an expression index when the query's
// expression matches it exactly, so one copy is the only safe number.
export const NCII_PRIORITY_SQL = `(case when data->>'category' = 'minor' then 0 else 1 end)`;
export const REPORT_PRIORITY_SQL = `(case data->>'category' when 'minor' then 0 when 'non_consensual' then 1 else 2 end)`;

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
-- The index above compares the handle as stored, so '@alice' and 'alice'
-- could coexist -- and a referral link resolves whichever one a lookup hits.
-- Handles are normalized (leading '@' stripped) before they are written; this
-- index is the database-side guarantee that the normalized forms are unique
-- too. Same DO-block reasoning as above.
do $$
begin
  create unique index if not exists creators_handle_norm_unique_idx
    on creators ((regexp_replace(lower(btrim(data->>'handle')), '^@+', '')))
    where regexp_replace(btrim(coalesce(data->>'handle', '')), '^@+', '') <> '';
exception when others then
  raise warning 'creators_handle_norm_unique_idx not created: %', sqlerrm;
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
create index if not exists orders_tx_hash_idx on orders ((data->>'paymentTxHash'));

-- Claims a real on-chain payment before it's turned into anything of value.
-- Used by lib/deposit.js's creditDepositFromChain -- a fan converting real
-- USDG into a credits balance, the ONLY place a wallet payment is ever
-- verified now (see lib/chain-verify.js's sender check for why amount and
-- destination alone don't prove who paid). What must never happen is the
-- SAME hash being spent twice (replaying a real payment for a second
-- credit). The insert into this table happens first, inside the same
-- transaction as the balance credit -- a duplicate hash fails the insert on
-- the primary key and the whole transaction rolls back, so there is no
-- window between "check if used" and "mark used" for two concurrent
-- submissions of the same hash to both slip through.
create table if not exists used_payment_tx (
  tx_hash     text primary key,
  created_at  timestamptz not null default now()
);
-- Belt-and-suspenders: lib/deposit.js normalizes every tx hash to lowercase
-- before it ever reaches this table (Ethereum tx hashes are case-insensitive
-- at the RPC/node level, but a plain text primary key is not -- the same
-- real payment resubmitted with different letter-casing used to be treated
-- as a different hash and credited again). This index makes a second
-- call site that forgets to normalize fail loudly instead of silently
-- reopening that hole. Wrapped in a DO block, same reasoning as
-- creators_handle_unique_idx: if a real duplicate under different casing
-- was already inserted before this fix shipped, a bare CREATE UNIQUE INDEX
-- would throw and take the whole site down at boot rather than leaving one
-- pre-existing duplicate in place.
do $$
begin
  create unique index if not exists used_payment_tx_lower_idx on used_payment_tx (lower(tx_hash));
exception when others then
  raise warning 'used_payment_tx_lower_idx not created: %', sqlerrm;
end $$;

-- Credits: 1 credit = 1 US cent, an internal dollar balance so buying
-- something inside the platform needs no wallet at all -- a wallet is only
-- ever needed once, to convert real USDG into this balance (see
-- lib/credits-store.js). balance_cents is a running total rather than
-- something summed from the ledger on every read, updated only inside a
-- transaction alongside the ledger row that explains the change -- the
-- ledger is the audit trail, this table is the fast-path balance check a
-- charge has to make synchronously.
create table if not exists credit_balances (
  user_id       text primary key,
  balance_cents bigint not null default 0,
  updated_at    timestamptz not null default now()
);
-- Credits are closed-loop: a fan's deposit is spendable here and never
-- cashed back out. Only money a creator EARNED from someone else's spend may
-- leave as a payout, so the withdrawable part of a balance is tracked apart
-- from the total. It rises on 'earn', falls on a payout reservation, and a
-- charge consumes the non-withdrawable part of the balance first. Always
-- <= balance_cents. See lib/credits-store.js.
alter table credit_balances add column if not exists withdrawable_cents bigint not null default 0;

create table if not exists credit_ledger (
  id           bigint generated always as identity primary key,
  user_id      text not null,
  -- 'deposit' (real USDG -> credits), 'charge' (spent credits, negative),
  -- 'earn' (received another user's spend, positive), 'payout_reserved'
  -- (creator requested cash-out, negative), 'payout_paid' is NOT logged
  -- here -- it has no balance effect, see payout_requests below.
  type         text not null,
  amount_cents bigint not null,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on credit_ledger (user_id);

-- A creator's request to convert their earned balance back to real USDG.
-- Deliberately NOT auto-paid: the balance is debited the moment the
-- request is made (so it can't be spent twice while a payout is pending),
-- but sending the actual on-chain USDG is a manual admin action -- giving
-- the server itself standing permission to move real money out of a wallet
-- is a much bigger attack surface than a queue a human clears, the same
-- call already made for this platform's token-burn worker.
-- Blocks a retried/double-submitted checkout from charging twice. The client
-- generates one random key per checkout attempt and resends the SAME key on
-- a retry (a dropped response, a double-click before the button's own
-- disabled state lands) -- a fresh key is only ever minted for a genuinely
-- new attempt. The insert happens inside the SAME transaction as the actual
-- charge (see createOrdersFromCredits in lib/orders-store.js), so a losing
-- duplicate's insert hits this primary key and its whole transaction --
-- charge included -- rolls back, rather than checking "already used?" and
-- charging as two separate steps with a window between them.
--
-- The key is scoped to the buyer: the primary key is (buyer_id,
-- idempotency_key). Keyed on idempotency_key alone, a second account sending
-- a key another account had already claimed (two people on one browser, whose
-- in-flight checkout attempt outlived a logout) hit the conflict and was told
-- its own cart was "already paid" -- cleared and confirmed although nothing
-- was bought. Another buyer's key can now never read as this buyer's
-- duplicate. The DO block below migrates a table created with the old
-- single-column key; it is a no-op once the key is composite.
create table if not exists checkout_idempotency (
  idempotency_key  text not null,
  buyer_id         text not null,
  created_at       timestamptz not null default now(),
  primary key (buyer_id, idempotency_key)
);
do $$
declare
  pk_name text;
  pk_cols int;
begin
  select conname, array_length(conkey, 1) into pk_name, pk_cols
    from pg_constraint
   where conrelid = 'checkout_idempotency'::regclass and contype = 'p';
  if pk_name is not null and pk_cols = 1 then
    execute format('alter table checkout_idempotency drop constraint %I', pk_name);
    alter table checkout_idempotency add primary key (buyer_id, idempotency_key);
  end if;
end $$;

create table if not exists payout_requests (
  id            bigint generated always as identity primary key,
  user_id       text not null,
  amount_cents  bigint not null,
  status        text not null default 'pending', -- 'pending' | 'paid'
  payout_wallet text,
  tx_hash       text,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);
create index if not exists payout_requests_status_idx on payout_requests (status);
-- 'rejected' is a third status: an admin refusing a request (a bad wallet, a
-- banned account, suspected fraud) returns the reserved credits in the same
-- transaction that marks it, rather than leaving them debited forever.
alter table payout_requests add column if not exists rejected_at timestamptz;
alter table payout_requests add column if not exists reject_reason text;
-- One on-chain transfer pays one request. Without this, a single real tx hash
-- could be recorded as the proof for any number of payouts, so "paid" would
-- stop meaning anything when reconciling. DO block for the same boot-safety
-- reason as the indexes above.
do $$
begin
  create unique index if not exists payout_requests_tx_hash_lower_idx
    on payout_requests (lower(tx_hash)) where tx_hash is not null;
exception when others then
  raise warning 'payout_requests_tx_hash_lower_idx not created: %', sqlerrm;
end $$;

-- AgeChecker verification ids that have already been redeemed for an
-- age-verification cookie. Without this, one accepted verification id could
-- be replayed by any number of browsers, forever. Redeeming is an insert that
-- fails on the primary key the second time. See pages/api/age-verify/confirm.js.
create table if not exists age_verification_uses (
  uuid     text primary key,
  used_at  timestamptz not null default now()
);

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
-- The wall is read newest-first a page at a time, and the per-author daily cap
-- counts one author's recent posts on one wall (lib/wall-store.js).
create index if not exists wall_posts_creator_page_idx on wall_posts ((data->>'creatorId'), id desc);
create index if not exists wall_posts_author_idx on wall_posts ((data->>'authorId'), (data->>'creatorId'), created_at);

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
-- The admin REPORTS queue (a status page in priority order, newest first) and
-- the open counts: indexed, so a flood of junk filings is not a full scan and
-- sort on every queue page (round-13 social#1).
create index if not exists reports_queue_idx on reports ((data->>'status'), ${REPORT_PRIORITY_SQL}, id desc);

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
-- TAKEDOWN REQUESTS: the queue page (possible-minor first, then oldest) and
-- the badge's open count, both polled by the admin panel under a 48-hour
-- clock, on a table the public form writes to (round-13 social#1).
create index if not exists ncii_reports_queue_idx on ncii_reports ((data->>'status'), ${NCII_PRIORITY_SQL}, id);

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
-- One-off, idempotent cleanup for rows stored before /api/waitlist stopped
-- keeping location beyond a US state (Privacy Policy, Section 1): drop the
-- country from every row, and the region too where it was not a US state
-- (e.g. 'ON' for Ontario). Matches nothing once run, and new rows never
-- carry a country value.
update waitlist
   set data = case when upper(coalesce(data->>'country', '')) = 'US'
                   then data || jsonb_build_object('country', null)
                   else data || jsonb_build_object('country', null, 'state', null) end
 where data->>'country' is not null;

-- In-app notifications ("you made a sale", "your payout was paid"). Deliberately
-- database-only, no email -- nothing on this stack sends mail (see MEMORY.md's
-- creator-inbox-notifications note), and building a real in-app row first,
-- with a delivery channel as a later addition, is the exact "record first,
-- provider on top" shape the server/'s notification design already settled on
-- for the same reason: the provider is the piece most likely to be missing or
-- swapped, so nothing here should depend on one existing.
create table if not exists notifications (
  id          bigint generated always as identity primary key,
  user_id     text not null,
  type        text not null,
  message     text not null,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index if not exists notifications_user_idx on notifications (user_id, created_at desc);

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

-- Blob pathnames that may be orphaned files in the private media store. A row
-- is written when an upload token is issued (reason 'token': the browser may
-- upload and never finalize -- a closed tab, a dropped connection, a finalize
-- that 500s) and when a file deletion fails (reason 'delete_failed'). The
-- sweep in lib/media.js (sweepOrphanedMedia) takes 'token' rows older than an
-- hour and deletion rows at once, deletes the file if no creator or listing
-- record references it (and it is not preserved evidence), and drops the row. Nothing else lists the store, so this is the only record that such
-- a file exists at all.
--
-- Reason 'delete_pending' is written INSIDE the transaction that removes a
-- file's last reference (a creator deleted, a listing taken down, a gallery
-- item or avatar replaced), before the best-effort del() that follows the
-- commit. A throw or a function timeout part-way through those deletions
-- used to strand the rest with nothing pointing at them; now the sweep
-- finds them.
--
-- claimed_at / claim_token: the sweep CLAIMS rows by stamping them and deletes
-- each row only after its file is dealt with. It used to claim by deleting
-- the rows up front, so a throw or timeout after that commit lost every
-- claimed path for good (including failed takedown deletions). A claim older
-- than 15 minutes is treated as abandoned. Every writer that re-records a
-- path clears the claim, so a sweep that saw the path still referenced
-- cannot drop a row a removal has just re-recorded.
create table if not exists media_uploads (
  pathname    text primary key,
  reason      text not null default 'token',
  created_at  timestamptz not null default now()
);
alter table media_uploads add column if not exists claimed_at timestamptz;
alter table media_uploads add column if not exists claim_token text;
create index if not exists media_uploads_created_idx on media_uploads (created_at);

-- Tombstones for uploaded files this app has DELETED (lib/media-refs.js). A
-- finalize takes the file's advisory lock and refuses a pathname listed here,
-- so a late finalize can never record a reference to a file the orphan sweep
-- (or a rejected-upload cleanup, or a removal) already deleted. Pathnames are
-- random uuids and never reissued, so a row is never wrong later.
create table if not exists media_reaped (
  pathname   text primary key,
  reaped_at  timestamptz not null default now()
);

-- Evidence preservation (lib/media-preservation.js). A file removed over a
-- POSSIBLE MINOR report is quarantined here instead of deleted: 18 U.S.C.
-- 2258A requires the material to be preserved after a CyberTipline report.
-- A row here means: never delete this file (blob-cleanup and the orphan sweep
-- skip it) and never serve it (lib/media.js sendMedia answers 404); the only
-- reader is the admin-key export. evidence_pathname is where the file was
-- moved to (the evidence/ prefix), null until the move succeeds.
create table if not exists media_preservations (
  pathname           text primary key,
  report_id          text,
  reason             text not null,
  preserved_by       text not null default 'admin',
  preserved_at       timestamptz not null default now(),
  retain_until       timestamptz not null,
  evidence_pathname  text,
  moved_at           timestamptz,
  missing_at         timestamptz,
  last_exported_at   timestamptz,
  export_count       int not null default 0
);
create index if not exists media_preservations_report_idx on media_preservations (report_id);

-- Report holds (lib/media-preservation.js holdMediaForReport). A POSSIBLE
-- MINOR report filed against a listing puts its files on hold AT FILING, so
-- nothing -- the reported seller's own edits included -- can delete them
-- before an admin looks. A hold only stops DELETION (blob-cleanup, the orphan
-- sweep, the finalize error path all skip held files); unlike a preservation
-- it does not stop serving, so a malicious report cannot take content down.
-- Released when the report is dismissed; replaced by a preservation when the
-- content is removed.
create table if not exists media_holds (
  pathname    text not null,
  report_id   text not null,
  created_at  timestamptz not null default now(),
  primary key (pathname, report_id)
);
create index if not exists media_holds_report_idx on media_holds (report_id);

-- Audit trail for admin takedowns of one specific item (a listing, a DM, a
-- wall comment) -- pages/api/admin/content-takedown.js. One row per action,
-- never updated.
create table if not exists moderation_actions (
  id          bigint generated always as identity primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now()
);

-- Outbox of site -> server/ standing messages (lib/standing-outbox.js). One
-- row per site user id holding the LATEST undelivered standing; deleted only
-- after server/ answers 2xx, retried with backoff otherwise. standing_at is
-- when the site decided it (ms epoch), which server/ uses to ignore stale
-- messages.
create table if not exists server_standing_pushes (
  uid              text primary key,
  status           text not null,
  role             text not null default 'CREATOR',
  standing_at      bigint not null,
  suspended_until  bigint,
  attempts         int not null default 0,
  next_at          timestamptz not null default now(),
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists server_standing_pushes_next_idx on server_standing_pushes (next_at);
-- A version bumped on every enqueue, so a delivery that leased an older
-- decision can never delete (or mark failed) a newer one that landed while it
-- was in flight -- even one with the same status and stamp.
alter table server_standing_pushes add column if not exists version bigint not null default 0;

-- Global guessing budget for the age-gate bypass links (lib/bypass-guard.js):
-- one fixed-window counter per endpoint, shared by every serverless instance
-- and every client address. The per-IP limit in lib/rate-limit.js lives in one
-- instance's memory and an IPv6 host can rotate addresses freely, so this row
-- is what actually bounds how many keys anyone can try.
create table if not exists bypass_key_attempts (
  endpoint      text primary key,
  window_start  timestamptz not null default now(),
  attempts      int not null default 0
);

-- Login brakes (lib/login-guard.js): per-/64, per-/48 and per-account
-- counters plus the "dirty" markers, as fixed-window counters every
-- serverless instance shares. They used to live in lib/rate-limit.js's
-- in-memory map, where each instance had its own budget and flooding any
-- other public endpoint could evict them (round-10 gates-token#1). The key is
-- a SHA-256 of the logical key, so no typed identifier is stored.
create table if not exists login_attempts (
  key           text primary key,
  window_start  timestamptz not null default now(),
  attempts      int not null default 0
);
create index if not exists login_attempts_window_idx on login_attempts (window_start);

-- A creator's block of a WALL commenter (lib/messages-store.js
-- setWallBlocked), kept apart from DM blocks (conversations.blockedBy) so the
-- anonymity of wall comments survives it: a wall block is never reported on a
-- named DM thread, and a DM block made by user id never flags a wall comment
-- (round-10 social#0). owner_user_id / author_id are user ids.
create table if not exists wall_blocks (
  owner_user_id text not null,
  author_id     text not null,
  created_at    timestamptz not null default now(),
  primary key (owner_user_id, author_id)
);
create index if not exists wall_blocks_author_idx on wall_blocks (author_id);
-- Before wall blocks had their own table, a block with no conversation behind
-- it created an empty "block-only" pair row (createdByBlock, no blockKind).
-- Most came from the wall, and they cannot be told apart from a DM block by id
-- made on an empty conversation -- both mean "this account may not reach me",
-- which is exactly a wall block's effect, so they are moved there once.
with legacy as (
  select c.id, bl.b as owner, pi.p as other
    from conversations c
    cross join lateral jsonb_array_elements_text(coalesce(c.data->'blockedBy', '[]'::jsonb)) as bl(b)
    cross join lateral jsonb_array_elements_text(coalesce(c.data->'participantIds', '[]'::jsonb)) as pi(p)
   where c.data ? 'createdByBlock' and not c.data ? 'blockKind'
     and jsonb_array_length(coalesce(c.data->'messages', '[]'::jsonb)) = 0
     and pi.p <> bl.b
), moved as (
  insert into wall_blocks (owner_user_id, author_id)
    select owner, other from legacy
  on conflict do nothing
)
delete from conversations
 where data ? 'createdByBlock' and not data ? 'blockKind'
   and jsonb_array_length(coalesce(data->'messages', '[]'::jsonb)) = 0;
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
    // `sslmode=require` in the URL is respected by pg only for whether to
    // use TLS, not for verification, so be explicit -- and only when the
    // URL is not a local socket/localhost.
    //
    // rejectUnauthorized defaults to FALSE, unchanged from before, because
    // this container cannot open an outbound connection to the real
    // production Neon database to verify a stricter setting actually works
    // there -- flipping the default blind is exactly the "risks a total DB
    // outage" mistake this comment used to warn against.
    //
    // What changed: checked Neon's own docs rather than continuing to
    // assume a cert this container can't validate. Neon signs with the
    // public ISRG Root X1 (Let's Encrypt) cert -- already in Node's default
    // trust store -- and Neon's own docs recommend verify-full
    // (rejectUnauthorized: true) specifically because it protects against
    // MITM on the DB connection. So `rejectUnauthorized: false` is very
    // likely disabling a real protection for no reason that holds up
    // *for Neon specifically* -- but "very likely, per documentation" is
    // still not "verified against this exact deployment."
    //
    // DB_SSL_REJECT_UNAUTHORIZED=true opts into real verification without a
    // code change: a Vercel deploy immediately shows whether the real
    // connection still works, and unsetting the var reverts instantly if it
    // doesn't. Recommended next step once someone can watch a deploy.
    ...(/localhost|127\.0\.0\.1/.test(url)
      ? {}
      : { ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' } }),
  });
  pool.on('error', (err) => {
    // An idle client erroring must not take the process down.
    console.error('[db] idle client error:', err.message);
  });
  return pool;
}

// Derived from the schema text itself, so changing SCHEMA can never be
// forgotten-to-bump: any edit produces a new version and the next boot applies
// it once.
const SCHEMA_VERSION = createHash('sha256').update(SCHEMA).digest('hex').slice(0, 16);
// Arbitrary but fixed: every instance must take the SAME advisory lock.
const SCHEMA_LOCK_KEY = 724100417;

/**
 * Applies SCHEMA unless the database already records this exact version.
 *
 * Running the DDL unconditionally on every cold start (as this used to) takes
 * SHARE locks on a dozen tables in one implicit transaction, so a cold start
 * landing during a long write -- or several cold starts at once -- queued
 * every other query behind it. Now the common path is a single-row SELECT.
 * When the schema did change, exactly one instance applies it at a time
 * (advisory lock), with a lock_timeout so a stuck lock fails the request
 * instead of hanging the site; the failure is not cached, so the next
 * request simply tries again.
 */
async function applySchema() {
  const p = getPool();
  try {
    const { rows } = await p.query("select value from app_meta where key = 'schema_version'");
    if (rows[0] && rows[0].value === SCHEMA_VERSION) return;
  } catch (err) {
    // 42P01: app_meta does not exist yet (a brand-new database).
    if (err.code !== '42P01') throw err;
  }
  const client = await p.connect();
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '10s'");
    await client.query('select pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
    await client.query(SCHEMA);
    await client.query(
      `insert into app_meta (key, value) values ('schema_version', $1::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify(SCHEMA_VERSION)],
    );
    await client.query('commit');
  } catch (err) {
    try {
      await client.query('rollback');
    } catch {
      // The original error is the one worth surfacing.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Creates or upgrades the schema. Runs at most once per process, and is safe
 * to run concurrently from many instances -- every statement is
 * `if not exists`, and applySchema serializes real changes.
 */
export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = applySchema()
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
