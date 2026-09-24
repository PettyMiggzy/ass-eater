// 18 U.S.C. §2257 performer records, against a real Postgres.
//
// Run with:
//   DATABASE_URL=postgresql://... RECORDS_ENCRYPTION_KEY=... \
//   node --import ./test-register.mjs lib/performer-records.test.mjs
//
// These records are the most sensitive rows this platform will ever hold --
// a real person's legal identity and a scan of their government ID. The
// cases that matter most here are not "does it save": they are that the
// identity is genuinely unreadable in the database, that an under-18 record
// cannot be created at all, and that nothing ever deletes a row a retention
// law requires be kept.

import crypto from 'node:crypto';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
if (!process.env.RECORDS_ENCRYPTION_KEY) {
  process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
}

const { query, closePool } = await import('./db.js');
const store = await import('./performer-records-store.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);

await query('truncate performer_records restart identity');
// The document-history table is created on first use and keyed by record id;
// ids restart above, so stale history from a previous run would be counted
// against this run's records.
await query('drop table if exists performer_record_documents');

section('creating a record');

const rec = await store.createPerformerRecord({
  legalName: 'Jane Q Performer',
  dateOfBirth: '1996-04-02',
  aliases: 'LunaX, @luna, Luna Rae, luna',
  idType: "Driver's licence",
  idIssuer: 'State of Indiana',
  idNumber: 'D1234-5678-9012',
  producedAt: '2026-09-19',
  contentUrls: 'https://joinonlyone.com/creator/3\nhttps://joinonlyone.com/marketplace',
  notes: 'Shot 2026-09-19.',
});

check('legal name reads back decrypted', rec.legalName === 'Jane Q Performer', rec.legalName);
check('date of birth reads back decrypted', rec.dateOfBirth === '1996-04-02', rec.dateOfBirth);
check('ID number reads back decrypted', rec.idNumber === 'D1234-5678-9012', rec.idNumber);
check('age at production is computed', rec.ageAtProduction === 30, String(rec.ageAtProduction));
check('aliases are normalised and de-duplicated',
  JSON.stringify(rec.aliases) === JSON.stringify(['lunax', 'luna', 'luna rae']),
  JSON.stringify(rec.aliases));
check('URLs split on newlines as well as commas', rec.contentUrls.length === 2, JSON.stringify(rec.contentUrls));
check('retention is seven years from production', String(rec.retainUntil).startsWith('2033-09-19'), rec.retainUntil);

section('the identity is actually unreadable in the database');
// The whole design rests on this. If it ever starts failing, a database dump
// hands over a list of real people who perform in adult content.
const { rows } = await query('select data::text as raw from performer_records where id = $1', [rec.id]);
const raw = rows[0].raw;
check('legal name is not in the stored row', !raw.includes('Jane Q Performer'));
check('date of birth is not in the stored row', !raw.includes('1996-04-02'));
check('ID number is not in the stored row', !raw.includes('D1234-5678-9012'));
check('stage names ARE in the stored row (they are the index)', raw.includes('lunax'));
check('URLs ARE in the stored row (they are the index)', raw.includes('joinonlyone.com/creator/3'));

section('an under-18 record cannot be created');
let threw = null;
try {
  await store.createPerformerRecord({
    legalName: 'Too Young',
    dateOfBirth: '2010-01-01',
    producedAt: '2026-09-19',
  });
} catch (err) { threw = err; }
check('refuses a performer under 18 at production', threw?.name === 'UnderagePerformerRecord', String(threw));

// The birthday case: 17 years and 364 days is still 17.
threw = null;
try {
  await store.createPerformerRecord({
    legalName: 'Day Before',
    dateOfBirth: '2008-09-20',
    producedAt: '2026-09-19',
  });
} catch (err) { threw = err; }
check('refuses someone one day short of 18', threw?.name === 'UnderagePerformerRecord', String(threw));

const onBirthday = await store.createPerformerRecord({
  legalName: 'On The Day',
  dateOfBirth: '2008-09-19',
  producedAt: '2026-09-19',
});
check('accepts someone who turned 18 that same day', onBirthday.ageAtProduction === 18, String(onBirthday.ageAtProduction));

section('ID documents');
const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2048)]);
await store.attachPerformerDocument(rec.id, fakeJpeg, 'image/jpeg; charset=binary', 'licence.jpg');
const doc = await store.readPerformerDocument(rec.id);
check('document round-trips byte for byte', Buffer.compare(doc.buffer, fakeJpeg) === 0);
check('document content type is recorded stripped of parameters', doc.meta.contentType === 'image/jpeg', doc.meta.contentType);

const { rows: docRows } = await query('select id_document from performer_records where id = $1', [rec.id]);
check('document is not stored in the clear', !docRows[0].id_document.includes(fakeJpeg.toString('base64').slice(0, 40)));

const listed = await store.getPerformerRecords();
check('listing never carries the document bytes', listed.every((r) => r.id_document === undefined));
check('listing shows that a document is on file', listed.find((r) => r.id === rec.id)?.document?.bytes === fakeJpeg.length);

threw = null;
try { await store.attachPerformerDocument(rec.id, Buffer.from('<script>'), 'text/html', 'x.html'); }
catch (err) { threw = err; }
check('refuses a document type that is not an ID scan', /must be a/i.test(String(threw?.message)), String(threw));

section('a wrong key cannot read the record');
const goodKey = process.env.RECORDS_ENCRYPTION_KEY;
process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
threw = null;
try { await store.readPerformerDocument(rec.id); } catch (err) { threw = err; }
check('a rotated key fails loudly rather than returning garbage', threw !== null, String(threw));
// Same "unreadable" failure toAdminRecord() already handles cleanly for the
// text fields, now handled the same way for the document itself -- this
// must be a clean, specific Error, not a raw decrypt exception reaching the
// admin document-streaming endpoint uncaught.
check('the error is the clean, specific one, not a raw decrypt exception',
  threw?.message === 'That document could not be decrypted (check RECORDS_ENCRYPTION_KEY).', String(threw));
process.env.RECORDS_ENCRYPTION_KEY = goodKey;

section('one unreadable record must not take down the list');
// The list IS the compliance index. If an inspection asks for one performer
// and the page shows nothing because some other row was written under a
// rotated key, that is the worst failure this table has. Same bug class
// already fixed once in orders-store.js.
{
  const realKey = process.env.RECORDS_ENCRYPTION_KEY;
  process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  const strays = await store.createPerformerRecord({
    legalName: 'Written Under Another Key',
    dateOfBirth: '1990-01-01',
    aliases: 'strayrecord',
    producedAt: '2026-09-19',
  });
  process.env.RECORDS_ENCRYPTION_KEY = realKey;

  let listed = null;
  let listErr = null;
  try { listed = await store.getPerformerRecords(); } catch (err) { listErr = err; }
  check('listing still succeeds with an undecryptable row present', listErr === null, String(listErr));
  const stray = listed?.find((r) => r.id === strays.id);
  check('the bad row is flagged unreadable rather than blank', stray?.unreadable === true);
  check('the reason is carried through', typeof stray?.unreadableReason === 'string' && stray.unreadableReason.length > 0);
  check('its plaintext index still works, so it can still be found', stray?.aliases?.includes('strayrecord'));
  const good = listed?.find((r) => r.id === rec.id);
  check('readable records around it are unaffected', good?.legalName === 'Jane Q Performer', good?.legalName);

  await query('delete from performer_records where id = $1', [strays.id]);
}

section('records are archived, never deleted');
const archived = await store.archivePerformerRecord(rec.id, 'duplicate of #2');
check('archiving marks the record', archived.status === 'archived', archived.status);
check('the reason is kept', archived.archiveReason === 'duplicate of #2', archived.archiveReason);
const again = await store.archivePerformerRecord(rec.id, 'second attempt');
check('archiving twice is refused rather than overwriting the first reason', again === null);

const { rows: countRows } = await query('select count(*)::int as n from performer_records');
// Two rows, not four: the archive above kept its row, and BOTH under-18
// attempts inserted nothing at all rather than being saved and rejected
// afterwards. A refused record that still leaves a row behind would be the
// worse failure of the two.
check('archiving keeps the row, and refused records left none', countRows[0].n === 2, String(countRows[0].n));

section('search matches what an inspection would ask for');
const all = await store.getPerformerRecords();
const target = all.find((r) => r.id === rec.id);
check('matches a stage name', store.matchesRecord(target, 'LunaX'));
check('matches a past name', store.matchesRecord(target, 'luna rae'));
check('matches a URL', store.matchesRecord(target, 'creator/3'));
check('matches the legal name', store.matchesRecord(target, 'jane q'));
check('does not match an unrelated term', !store.matchesRecord(target, 'somebodyelse'));

section('production dates cannot be in the future (a typo must not age a minor up)');
{
  const future = new Date(Date.now() + 40 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let err = null;
  try {
    await store.createPerformerRecord({ legalName: 'Future Typo', dateOfBirth: '2010-01-01', producedAt: future });
  } catch (e) { err = e; }
  check('a future production date is refused', err?.message === 'The production date cannot be in the future.', String(err));

  // Past production date that would compute as adult for a DOB that is a
  // minor today can't exist (production is never in the future), but the
  // independent "under 18 today" check is still asserted directly.
  const minorDob = new Date(Date.now() - 17 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  err = null;
  try { await store.createPerformerRecord({ legalName: 'Minor Today', dateOfBirth: minorDob }); } catch (e) { err = e; }
  check('someone under 18 today is refused', err?.name === 'UnderagePerformerRecord', String(err));

  err = null;
  try { await store.createPerformerRecord({ legalName: 'Bare Year', dateOfBirth: '1990', producedAt: '2026-09-19' }); } catch (e) { err = e; }
  check('a bare year is not a date of birth', /could not be read/.test(String(err?.message)), String(err));
  err = null;
  try { await store.createPerformerRecord({ legalName: 'Bad Day', dateOfBirth: '1990-02-31', producedAt: '2026-09-19' }); } catch (e) { err = e; }
  check('an impossible calendar date is refused', /could not be read/.test(String(err?.message)), String(err));
}

section('an ID document is never silently overwritten');
{
  const active = await store.createPerformerRecord({ legalName: 'Doc Person', dateOfBirth: '1990-05-05', producedAt: '2026-09-19' });
  const first = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(512)]);
  const second = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(512)]);
  await store.attachPerformerDocument(active.id, first, 'image/jpeg', encodeURIComponent('Screenshot 2026-09-24 at 10.15.32\u202fAM.png'));
  const meta1 = (await store.readPerformerDocument(active.id)).meta;
  check('a URL-encoded non-Latin-1 filename is decoded', meta1.fileName === 'Screenshot 2026-09-24 at 10.15.32\u202fAM.png', meta1.fileName);

  let err = null;
  try { await store.attachPerformerDocument(active.id, second, 'image/jpeg', 'renewed.jpg'); } catch (e) { err = e; }
  check('a second attach without replace is refused', /already on file/.test(String(err?.message)), String(err));
  check('...and the original is untouched', Buffer.compare((await store.readPerformerDocument(active.id)).buffer, first) === 0);

  const replaced = await store.attachPerformerDocument(active.id, second, 'image/jpeg', 'renewed.jpg', { replace: true });
  check('an explicit replace stores the new document', Buffer.compare((await store.readPerformerDocument(active.id)).buffer, second) === 0);
  check('the replacement is recorded in the history', replaced.documentHistory?.length === 1 && replaced.documentHistory[0].replacedAt);
  const { rows: hist } = await query('select id_document from performer_record_documents where record_id = $1', [active.id]);
  check('the old encrypted document is kept, not destroyed', hist.length === 1 && hist[0].id_document.length > 0);

  err = null;
  try { await store.attachPerformerDocument(rec.id, second, 'image/jpeg', 'x.jpg', { replace: true }); } catch (e) { err = e; }
  check('an archived record is read-only for documents', err?.message === 'An archived record is read-only.', String(err));
  err = null;
  try { await store.updatePerformerRecord(rec.id, { notes: 'edit after archive' }); } catch (e) { err = e; }
  check('an archived record is read-only for edits', err?.message === 'An archived record is read-only.', String(err));
}

section('refuses to store anything without a key');
delete process.env.RECORDS_ENCRYPTION_KEY;
threw = null;
try { await store.createPerformerRecord({ legalName: 'x', dateOfBirth: '1990-01-01' }); }
catch (err) { threw = err; }
check('no key means refuse, never store in the clear', threw?.name === 'RecordsNotConfigured', String(threw));
process.env.RECORDS_ENCRYPTION_KEY = goodKey;

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
