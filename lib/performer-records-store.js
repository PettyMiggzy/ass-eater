import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import {
  encryptRecordField,
  decryptRecordField,
  encryptRecordDocument,
  decryptRecordDocument,
  recordsEncryptionProblem,
} from './crypto';
import { effectiveCreatorStatus } from './creator-status';
import { sliceText } from './unicode-text';

/**
 * 18 U.S.C. §2257 / 28 C.F.R. §75 performer records.
 *
 * What the statute actually asks a producer to keep, and what this stores:
 * every performer's legal name, date of birth, every other name they have
 * ever worked under, a copy of a government-issued photo ID, the date the
 * content was produced, and where it appears -- indexed so that a record can
 * be found from any alias or any URL. Records are kept for seven years.
 *
 * THE SPLIT BETWEEN ENCRYPTED AND PLAINTEXT IS THE WHOLE DESIGN, so it is
 * worth being explicit about where the line is and why it is there:
 *
 *   Encrypted (legal identity): legal name, date of birth, ID number, and
 *   the ID document itself. A database dump must not hand over a list of
 *   real people who perform in adult content, matched to their ID numbers.
 *   That is the single worst thing this platform could leak -- worse than
 *   passwords, which can be changed.
 *
 *   Plaintext (the index): stage names/aliases and the content URLs. These
 *   are already public -- a stage name is on the creator's own profile and
 *   the URL is a page on this site -- so encrypting them buys nothing, and
 *   they are exactly what the law requires the records be searchable by.
 *   Encrypting them would mean decrypting every record on every lookup,
 *   which is how a compliance index quietly stops being usable.
 *
 * Nothing here is ever served from a public URL. Vercel Blob (where creator
 * photos and video live) is world-readable by design -- an ID scan must
 * never go near it. Documents live in Postgres, encrypted, and are readable
 * only through an admin-key-gated endpoint that streams them with
 * Cache-Control: no-store.
 *
 * This is record-keeping, not legal advice, and it is not a substitute for
 * an attorney who works in this industry.
 */

/**
 * 28 C.F.R. §75.4 -- seven years from the date the record was CREATED or
 * last AMENDED or added to (round-20 legal-journeys#0). It used to be counted
 * from the content's production date, so a record created today for
 * back-catalogue content produced in 2019 showed "keep until 2026-03-01" --
 * a date already past, which an operator following it could have archived or
 * purged years early. Now: at creation, the later of now and the production
 * date, plus seven years; on every amendment (updatePerformerRecord,
 * attachPerformerDocument, archivePerformerRecord) it moves to at least now
 * plus seven years, never earlier (RETAIN_UNTIL_BUMP_SQL). lib/db.js raised
 * rows written before this. Nothing deletes or purges on this date: it is a
 * floor for the operator, shown as "keep at least until".
 */
const RETENTION_YEARS = 7;
// The retainUntil an amendment leaves: the later of the stored one and now +
// seven years, as the same ISO string createPerformerRecord writes.
const RETAIN_UNTIL_BUMP_SQL = `jsonb_build_object('retainUntil', to_char(greatest(
    coalesce(case when data->>'retainUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then (data->>'retainUntil')::timestamptz end, '-infinity'::timestamptz),
    now() + interval '${RETENTION_YEARS} years') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;

/**
 * Deliberately generous but not unbounded. A phone photo of a driver's
 * licence is normally 1-3MB; Vercel caps a serverless request body at
 * roughly 4.5MB regardless of what this says, so a larger limit here would
 * only turn a clear error into a confusing platform-level one.
 */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

const ALLOWED_DOCUMENT_TYPE = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;

export class RecordsNotConfigured extends Error {
  constructor(reason) {
    super(`${reason} §2257 records cannot be stored or read until that is fixed.`);
    this.name = 'RecordsNotConfigured';
  }
}

function requireKey() {
  // Checked before anything is written rather than letting the encrypt call
  // throw halfway through. Storing one of these unencrypted is not a
  // degraded mode worth having -- refusing is the correct behaviour, the
  // same call the orders store already makes about shipping addresses.
  const problem = recordsEncryptionProblem();
  if (problem) throw new RecordsNotConfigured(problem);
}

function clean(value, max) {
  return sliceText(String(value ?? '').trim(), max);
}

/** Lowercased and de-duplicated, because an index nobody can match is not an index. */
export function normalizeAliases(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  const out = [];
  for (const raw of list) {
    const alias = clean(raw, 120).toLowerCase().replace(/^@/, '');
    if (alias && !out.includes(alias)) out.push(alias);
    if (out.length >= 25) break;
  }
  return out;
}

export function normalizeUrls(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/);
  const out = [];
  for (const raw of list) {
    const url = clean(raw, 500);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= 100) break;
  }
  return out;
}

/**
 * Throws rather than storing a record for someone under 18. A §2257 record
 * exists to evidence that every performer was an adult -- a record that says
 * otherwise is not a record with a problem, it is a confession, and it must
 * not be possible to save one by mistyping a year.
 */
export class UnderagePerformerRecord extends Error {
  constructor() {
    super('That date of birth is under 18 at the production date. A record cannot be created.');
    this.name = 'UnderagePerformerRecord';
  }
}

/** A full calendar date, YYYY-MM-DD, that actually exists (no 2026-02-31). */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isFullDate(value) {
  const m = ISO_DATE.exec(String(value || ''));
  if (!m) return false;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * Today's date as YYYY-MM-DD, one day ahead of UTC -- the allowance for an
 * admin a timezone ahead of the server entering "today" legitimately. A
 * production date past this is a typo, and a typo'd future year is exactly
 * how a performer who is a minor TODAY would compute as an adult "at
 * production".
 */
function latestAcceptableProductionDate() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function ageOn(dateOfBirth, onDate) {
  const dob = new Date(dateOfBirth);
  const at = new Date(onDate);
  if (Number.isNaN(dob.getTime()) || Number.isNaN(at.getTime())) return null;
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = at.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export function retainUntil(producedAt, now = new Date()) {
  // The later of now (the record's creation) and the production date: a
  // production date may be up to a day ahead (latestAcceptableProductionDate).
  const produced = new Date(producedAt);
  const base = Number.isNaN(produced.getTime()) || produced < now ? new Date(now) : produced;
  const until = new Date(base);
  until.setUTCFullYear(until.getUTCFullYear() + RETENTION_YEARS);
  return until.toISOString();
}

/**
 * The shape handed to the admin UI: identity decrypted, document never
 * included.
 *
 * A field that will not decrypt marks the record unreadable instead of
 * throwing. One record written under a rotated or wrong key would otherwise
 * take down the whole list -- which on THIS table is the worst possible
 * failure mode, because the list is the compliance index. An inspection
 * asking for one performer's record must not be met with a page that shows
 * nothing at all; it must show every record it can read and say plainly
 * which one it cannot.
 *
 * Exactly the bug already fixed once in lib/orders-store.js, where one
 * undecryptable address 500'd a creator's whole shipping queue.
 */
function toAdminRecord(row) {
  const record = rowToRecord(row);
  const { legalName, dateOfBirth, idNumber, ...rest } = record;

  let unreadable = null;
  const read = (packed) => {
    if (!packed) return '';
    try {
      return decryptRecordField(packed);
    } catch (err) {
      unreadable = err.message;
      return '';
    }
  };

  const out = {
    ...rest,
    legalName: read(legalName),
    dateOfBirth: read(dateOfBirth),
    idNumber: read(idNumber),
  };
  if (unreadable) {
    // Surfaced loudly rather than rendered as a blank row: a §2257 record
    // that cannot be read is a compliance problem to go and fix, not a
    // cosmetic gap.
    out.unreadable = true;
    out.unreadableReason = unreadable;
  }
  return out;
}

export async function getPerformerRecords() {
  requireKey();
  const { rows } = await query('select id, data from performer_records order by id desc');
  return rows.map(toAdminRecord);
}

export async function getPerformerRecord(id) {
  requireKey();
  const { rows } = await query('select id, data from performer_records where id = $1', [id]);
  return rows.length ? toAdminRecord(rows[0]) : null;
}

export async function createPerformerRecord(input) {
  requireKey();

  const legalName = clean(input.legalName, 200);
  const dateOfBirth = clean(input.dateOfBirth, 40);
  if (!legalName) throw new Error('A legal name is required.');
  if (!dateOfBirth) throw new Error('A date of birth is required.');

  const producedAt = clean(input.producedAt, 40) || new Date().toISOString().slice(0, 10);
  // Full YYYY-MM-DD dates only. A bare year ('2008') parses as January 1st,
  // which can make someone born in December read as a year older than they
  // are -- on the one check here that must not be off by a year.
  if (!isFullDate(dateOfBirth) || !isFullDate(producedAt)) {
    throw new Error('That date of birth or production date could not be read.');
  }
  if (producedAt > latestAcceptableProductionDate()) {
    throw new Error('The production date cannot be in the future.');
  }
  const age = ageOn(dateOfBirth, producedAt);
  if (age === null) throw new Error('That date of birth or production date could not be read.');
  if (age < 18) throw new UnderagePerformerRecord();
  // Independent of the production date: someone who is under 18 today
  // cannot have been an adult at any production date this form accepts, and
  // refusing on both makes a single mistyped field unable to get a minor's
  // record saved.
  const ageToday = ageOn(dateOfBirth, new Date().toISOString().slice(0, 10));
  if (ageToday === null || ageToday < 18) throw new UnderagePerformerRecord();

  const entry = {
    // Encrypted -- see the note at the top of this file.
    legalName: encryptRecordField(legalName),
    dateOfBirth: encryptRecordField(dateOfBirth),
    idNumber: input.idNumber ? encryptRecordField(clean(input.idNumber, 100)) : null,

    // Plaintext, because these are the index and are already public.
    aliases: normalizeAliases(input.aliases),
    contentUrls: normalizeUrls(input.contentUrls),

    idType: clean(input.idType, 60),
    idIssuer: clean(input.idIssuer, 120),
    idExpiry: clean(input.idExpiry, 40),
    creatorId: input.creatorId ? String(input.creatorId) : null,
    producedAt,
    ageAtProduction: age,
    notes: clean(input.notes, 2000),
    // Where the ID document lives: 'in-app' once one is attached, or
    // 'offline' for an operator who keeps the physical/scanned copy
    // somewhere else. Recording which is true beats a blank that could mean
    // either.
    documentLocation: input.documentLocation === 'offline' ? 'offline' : 'none',
    document: null,
    status: 'active',
    retainUntil: retainUntil(producedAt),
    createdAt: new Date().toISOString(),
  };

  const { rows } = await query(
    'insert into performer_records (data) values ($1) returning id, data',
    [entry],
  );
  return toAdminRecord(rows[0]);
}

/**
 * The §2257 go-live check (pages/api/admin/profile.js): does this creator have
 * a non-archived performer record, linked to them, that actually evidences
 * identity -- a copy of the photo ID attached here ('in-app', with the
 * document column really populated), or the record explicitly marked as
 * holding the ID offline? A record with only a typed name and date of birth
 * ('none', the default until an ID is attached) does NOT count: the ID copy is
 * the element a §2257 record fundamentally is, and /2257 says the platform
 * keeps one. Needs no decryption, so it works without the records key.
 *
 * Returns 'ok' | 'no_record' | 'no_document', so the refusal can say which.
 */
export async function performerRecordStatusForCreator(creatorId) {
  const { rows } = await query(
    `select (data->>'documentLocation' = 'offline'
             or (data->>'documentLocation' = 'in-app' and id_document is not null)) as has_id
       from performer_records
      where data->>'creatorId' = $1
        and coalesce(data->>'status', 'active') <> 'archived'`,
    [String(creatorId)],
  );
  if (!rows.length) return 'no_record';
  return rows.some((r) => r.has_id) ? 'ok' : 'no_document';
}

/**
 * The §2257 gate used to hold only at go-live (pages/api/admin/profile.js):
 * archiving a live creator's only qualifying record, or re-linking it to
 * someone else, left them public and selling with no record while /2257
 * says every creator has one. So archive and unlink/relink are refused when
 * they would take a creator who is live (or suspended -- a suspension lapses
 * into live on its own) from 'ok' to not-ok, unless the admin explicitly
 * confirms (`confirmUnrecordedLiveCreator`). The correction workflow this
 * steers toward: add and link the corrected record FIRST, then archive the
 * old one -- which is never refused.
 */
export const RECORD_REQUIRED_BY_LIVE_CREATOR = 'record_required_by_live_creator';

async function assertNotLastRecordOfLiveCreator(client, recordId, creatorId, confirm) {
  if (confirm === true || creatorId === null || creatorId === undefined || creatorId === '') return;
  const { rows: cr } = await client.query('select id, data from creators where id = $1', [String(creatorId)]);
  if (!cr.length) return;
  const status = effectiveCreatorStatus({ ...cr[0].data, id: cr[0].id }) ?? 'active';
  if (status !== 'active' && status !== 'suspended') return;
  const { rows } = await client.query(
    `select id::text as id,
            (data->>'documentLocation' = 'offline'
             or (data->>'documentLocation' = 'in-app' and id_document is not null)) as has_id
       from performer_records
      where data->>'creatorId' = $1
        and coalesce(data->>'status', 'active') <> 'archived'
      for update`,
    [String(creatorId)],
  );
  const okBefore = rows.some((r) => r.has_id);
  const okAfter = rows.some((r) => r.has_id && r.id !== String(recordId));
  if (okBefore && !okAfter) {
    throw Object.assign(
      new Error(
        `Creator #${creatorId} is live and this is their only §2257 record with an ID on file. Add and link the corrected record first, then archive or re-link this one -- or confirm explicitly to leave them live without a record.`,
      ),
      { code: RECORD_REQUIRED_BY_LIVE_CREATOR, creatorId: String(creatorId) },
    );
  }
}

export async function updatePerformerRecord(id, input, { confirmUnrecordedLiveCreator = false } = {}) {
  requireKey();
  const existing = await getPerformerRecord(id);
  if (!existing) throw new Error('Record not found');
  if (existing.status === 'archived') throw new Error('An archived record is read-only.');

  const patch = {};
  if ('aliases' in input) patch.aliases = normalizeAliases(input.aliases);
  if ('contentUrls' in input) patch.contentUrls = normalizeUrls(input.contentUrls);
  if ('notes' in input) patch.notes = clean(input.notes, 2000);
  if ('creatorId' in input) patch.creatorId = input.creatorId ? String(input.creatorId) : null;
  if ('documentLocation' in input && input.documentLocation === 'offline') patch.documentLocation = 'offline';

  const rows = await withTransaction(async (client) => {
    // Unlinking or re-linking: the creator it is linked to NOW must not be
    // left live with no record (read under the row lock, not from `existing`).
    if ('creatorId' in patch) {
      const { rows: cur } = await client.query(
        `select data->>'creatorId' as creator_id from performer_records where id = $1 for update`,
        [id],
      );
      const linked = cur[0]?.creator_id ?? null;
      if (linked !== null && linked !== patch.creatorId) {
        await assertNotLastRecordOfLiveCreator(client, id, linked, confirmUnrecordedLiveCreator);
      }
    }
    const { rows: updated } = await client.query(
      `update performer_records
          set data = data || $2::jsonb || ${RETAIN_UNTIL_BUMP_SQL}, updated_at = now()
        where id = $1
          and data->>'status' = 'active'
        returning id, data`,
      [id, JSON.stringify(patch)],
    );
    return updated;
  });
  // Guarded in the UPDATE too, so an archive landing between the read above
  // and this write cannot be edited past.
  if (!rows.length) throw new Error('An archived record is read-only.');
  return toAdminRecord(rows[0]);
}

/**
 * Archived, never deleted.
 *
 * §2257 is a RETENTION law -- the obligation is to still have the record
 * years later, so a delete button on this table is a way to commit the
 * offence by accident. Archiving takes a record out of the working list and
 * keeps the row, the reason and who did it.
 */
export async function archivePerformerRecord(id, reason, { confirmUnrecordedLiveCreator = false } = {}) {
  requireKey();
  const rows = await withTransaction(async (client) => {
    const { rows: cur } = await client.query(
      `select data->>'creatorId' as creator_id from performer_records where id = $1 and data->>'status' = 'active' for update`,
      [id],
    );
    if (!cur.length) return [];
    await assertNotLastRecordOfLiveCreator(client, id, cur[0].creator_id, confirmUnrecordedLiveCreator);
    const { rows: updated } = await client.query(
      `update performer_records
          set data = data || jsonb_build_object(
                'status', 'archived',
                'archivedAt', $2::text,
                'archiveReason', $3::text
              ) || ${RETAIN_UNTIL_BUMP_SQL},
              updated_at = now()
        where id = $1
          and data->>'status' = 'active'
        returning id, data`,
      [id, new Date().toISOString(), clean(reason, 500)],
    );
    return updated;
  });
  return rows.length ? toAdminRecord(rows[0]) : null;
}

export function documentTypeAccepted(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return ALLOWED_DOCUMENT_TYPE.test(type) ? type : null;
}

/**
 * Superseded ID documents. §2257 is a retention law: the document that
 * evidenced a performer's age at a production date has to survive being
 * "replaced" by a renewed licence, so a replacement moves the old encrypted
 * blob here rather than overwriting it. Created on first use (idempotent),
 * like everything in lib/db.js's schema.
 */
let historyTableReady = null;
async function ensureDocumentHistoryTable(client) {
  if (!historyTableReady) {
    historyTableReady = client.query(
      `create table if not exists performer_record_documents (
         id           bigint generated always as identity primary key,
         record_id    bigint not null,
         id_document  text not null,
         meta         jsonb not null default '{}'::jsonb,
         replaced_at  timestamptz not null default now()
       );
       create index if not exists performer_record_documents_record_idx
         on performer_record_documents (record_id);`,
    ).catch((err) => {
      historyTableReady = null;
      throw err;
    });
  }
  return historyTableReady;
}

/**
 * Attaches the ID document to a record.
 *
 * Never silently overwrites one that is already there: a second attach is
 * refused unless the caller passes `replace: true`, and even then the
 * previous encrypted document is kept (performer_record_documents) and a
 * line is added to the record's `documentHistory`. Archived records are
 * read-only. Both conditions are part of the UPDATE itself, so a concurrent
 * attach cannot slip past them.
 */
export async function attachPerformerDocument(id, buffer, contentType, fileName, { replace = false } = {}) {
  requireKey();
  const type = documentTypeAccepted(contentType);
  if (!type) throw new Error('An ID document must be a JPEG, PNG, WebP, HEIC or PDF.');
  if (!buffer || !buffer.length) throw new Error('No document was received.');
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new Error('That document is too large (4MB maximum).');

  const meta = {
    contentType: type,
    fileName: sanitizeDocumentFileName(fileName),
    bytes: buffer.length,
    uploadedAt: new Date().toISOString(),
  };
  const encrypted = encryptRecordDocument(buffer);

  if (replace) await ensureDocumentHistoryTable({ query });

  return withTransaction(async (client) => {
    const { rows: current } = await client.query(
      'select id, data, id_document from performer_records where id = $1 for update',
      [id],
    );
    if (!current.length) throw new Error('Record not found');
    const existing = current[0];
    if (existing.data?.status === 'archived') throw new Error('An archived record is read-only.');
    if (existing.id_document && !replace) {
      throw new Error('A document is already on file for this record. Replace it explicitly to keep the old one in history.');
    }

    let historyEntry = null;
    if (existing.id_document) {
      const oldMeta = existing.data?.document || {};
      await client.query(
        'insert into performer_record_documents (record_id, id_document, meta) values ($1, $2, $3)',
        [id, existing.id_document, JSON.stringify(oldMeta)],
      );
      historyEntry = { ...oldMeta, replacedAt: meta.uploadedAt };
    }

    const { rows } = await client.query(
      `update performer_records
          set id_document = $2,
              data = data
                     || jsonb_build_object('document', $3::jsonb, 'documentLocation', 'in-app')
                     || case when $4::jsonb is null then '{}'::jsonb
                             else jsonb_build_object('documentHistory',
                                    coalesce(data->'documentHistory', '[]'::jsonb) || jsonb_build_array($4::jsonb))
                        end
                     || ${RETAIN_UNTIL_BUMP_SQL},
              updated_at = now()
        where id = $1
          and data->>'status' = 'active'
        returning id, data`,
      [id, encrypted, JSON.stringify(meta), historyEntry ? JSON.stringify(historyEntry) : null],
    );
    if (!rows.length) throw new Error('An archived record is read-only.');
    return toAdminRecord(rows[0]);
  });
}

/**
 * The original filename, for the admin's own download. Arrives URL-encoded
 * (a raw header value cannot carry anything past Latin-1, and macOS
 * screenshot names contain U+202F), so it is decoded here, stripped of
 * control characters, path separators and quotes, and capped.
 */
export function sanitizeDocumentFileName(fileName) {
  let name = String(fileName ?? '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not valid percent-encoding: keep the raw string, sanitised below.
  }
  name = sliceText(name.replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim(), 200);
  return name;
}

/**
 * The decrypted ID document. Only ever called by the admin-key-gated
 * endpoint that streams it -- there is no other caller and there must not
 * be one.
 */
export async function readPerformerDocument(id) {
  requireKey();
  const { rows } = await query('select id, data, id_document from performer_records where id = $1', [id]);
  if (!rows.length || !rows[0].id_document) return null;
  let buffer;
  try {
    buffer = decryptRecordDocument(rows[0].id_document);
  } catch {
    // Same failure this file already handles for the text fields
    // (toAdminRecord, above) -- a document encrypted under a rotated or
    // wrong RECORDS_ENCRYPTION_KEY must fail as a clean, specific error the
    // caller can show, not a raw decrypt exception reaching the streaming
    // endpoint uncaught.
    throw new Error('That document could not be decrypted (check RECORDS_ENCRYPTION_KEY).');
  }
  return {
    buffer,
    meta: rows[0].data?.document || { contentType: 'application/octet-stream', fileName: `record-${id}` },
  };
}

/**
 * Matches an alias or a URL, which is what an inspection actually asks for.
 * A URL is matched against the hand-entered `contentUrls` AND resolved
 * through the data the system already has: a creator page or one of that
 * creator's media URLs finds every record linked to the creator
 * (contentUrlTarget below). Nobody types every upload's URL into a record,
 * so the recorded URLs alone missed everything a creator ever uploaded.
 * `extraIds` are record ids the caller resolved separately (co-performers
 * attested on the exact item -- see searchPerformerRecords).
 */
export function matchesRecord(record, term, { extraIds = null, creatorId = undefined } = {}) {
  const q = String(term || '').trim().toLowerCase();
  if (!q) return true;
  // Aliases are stored without a leading "@" (normalizeAliases), while the
  // site shows every handle with one: "@luna" typed as shown must find the
  // alias "luna" (round-18 admin-ui#0). Only for the alias check; a bare "@"
  // leaves nothing to compare and matches no alias.
  const aliasQ = q.replace(/^@/, '');
  if (aliasQ && (record.aliases || []).some((a) => a.includes(aliasQ))) return true;
  if ((record.contentUrls || []).some((u) => u.toLowerCase().includes(q))) return true;
  if (String(record.legalName || '').toLowerCase().includes(q)) return true;
  // `creatorId` is the creator the async search RESOLVED the URL to (a public
  // marketplace URL names only a listing; its creator comes from the listing
  // row, never from the URL's own ?creator= hint). Otherwise the one the URL
  // itself names.
  const target = contentUrlTarget(term);
  const cid = creatorId !== undefined ? creatorId : target?.creatorId;
  if (cid && record.creatorId != null && String(record.creatorId) === String(cid)) return true;
  if (extraIds && extraIds.has(String(record.id))) return true;
  return false;
}

const MEDIA_URL_RE = /^\/api\/media\/(avatars|gallery)\/([0-9A-Za-z_-]{1,64})\/[^/?#]+$|^\/api\/media\/listings\/([0-9A-Za-z_-]{1,64})\/([0-9]{1,18})\/[^/?#]+$/;
const CREATOR_URL_RE = /^\/creator\/([0-9A-Za-z_-]{1,64})\/?$/;

const ID_RE = /^[0-9A-Za-z_-]{1,64}$/;
const LISTING_ID_RE = /^[0-9]{1,18}$/;

/**
 * What a pasted URL points at on this site, or null. Accepts a full URL on
 * any of the site's hosts or a bare path.
 *   /creator/<id>                         -> { creatorId }
 *   /api/media/<avatars|gallery>/<cid>/.. -> { creatorId, src }
 *   /api/media/listings/<cid>/<lid>/..    -> { creatorId, listingId, src }
 *   /marketplace?listing=<lid>[&creator=<cid>], or /?listing=<lid> (the
 *   shop host's root) -- the only public URL a listing has, since public
 *   listing payloads never carry a media src
 *                                         -> { listingId, creatorHint }
 * A listing's creator is NOT taken from the URL (`creatorHint` is only what
 * it claims); searchPerformerRecords reads it off the listing row.
 */
export function contentUrlTarget(term) {
  const raw = String(term || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(raw.startsWith('/') ? raw : `/${raw}`, 'https://site.invalid');
  } catch {
    return null;
  }
  const path = url.pathname;
  let m = CREATOR_URL_RE.exec(path);
  if (m) return { creatorId: m[1] };
  m = MEDIA_URL_RE.exec(path);
  if (m) {
    if (m[1]) return { creatorId: m[2], src: path };
    return { creatorId: m[3], listingId: m[4], src: path };
  }
  if (path === '/marketplace' || path === '/marketplace/' || path === '/') {
    const listingId = url.searchParams.get('listing');
    if (listingId && LISTING_ID_RE.test(listingId)) {
      const hint = url.searchParams.get('creator');
      return { listingId, creatorHint: hint && ID_RE.test(hint) ? hint : null };
    }
  }
  return null;
}

/**
 * Server-side records search (GET /api/admin/performer-records?q=). Adds to
 * matchesRecord the co-performers attested on the exact item a media URL
 * names (item.performers.coPerformerRecordIds on the gallery item or listing
 * media item, or the creator's avatarPerformers for an avatar).
 */
export async function searchPerformerRecords(term) {
  const records = await getPerformerRecords();
  const q = String(term || '').trim();
  if (!q) return records;
  const extraIds = new Set();
  const target = contentUrlTarget(q);
  const idsOfItem = (item) => (item?.performers?.coPerformerRecordIds || []).map(String);
  if (target && !target.src && target.listingId) {
    // A public marketplace URL: the listing's REAL creator (from the row, not
    // the URL's ?creator= hint) and every co-performer attested on any of its
    // media, current or retained. A listing that does not exist resolves to
    // nothing.
    const { rows } = await query('select data from listings where id = $1', [target.listingId]);
    const listing = rows[0]?.data;
    const resolved = listing?.creatorId != null ? String(listing.creatorId) : null;
    for (const item of [...(listing?.media || []), ...(listing?.retainedMedia || [])]) {
      idsOfItem(item).forEach((id) => extraIds.add(id));
    }
    return records.filter((record) => matchesRecord(record, q, { extraIds, creatorId: resolved }));
  }
  if (target?.src) {
    const idsOf = (item) => (item?.performers?.coPerformerRecordIds || []).map(String);
    if (target.listingId) {
      const { rows } = await query('select data from listings where id = $1', [target.listingId]);
      const listing = rows[0]?.data;
      for (const item of [...(listing?.media || []), ...(listing?.retainedMedia || [])]) {
        if (item?.src === target.src) idsOf(item).forEach((id) => extraIds.add(id));
      }
    } else {
      const { rows } = await query('select data from creators where id = $1', [target.creatorId]);
      const creator = rows[0]?.data;
      for (const item of creator?.gallery || []) {
        if (item?.src === target.src) idsOf(item).forEach((id) => extraIds.add(id));
      }
      if (creator?.img === target.src) idsOf({ performers: creator.avatarPerformers }).forEach((id) => extraIds.add(id));
    }
  }
  return records.filter((record) => matchesRecord(record, q, { extraIds }));
}
