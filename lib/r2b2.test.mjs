// Round-2 R2B2 regressions against a real Postgres: wall pagination and the
// per-author daily cap, the §2257 go-live record check (ID on file), signup
// Terms/age acceptance stored on the account, and the pure name/wallet rules.
//
// Run with:
//   DATABASE_URL=postgresql://... node --import ./test-register.mjs lib/r2b2.test.mjs
//
// Truncates what it touches, so it refuses anything but a local scratch DB.
import crypto from 'node:crypto';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { query, closePool } = await import('./db.js');
const wall = await import('./wall-store.js');
const records = await import('./performer-records-store.js');
const users = await import('./users-store.js');
const fv = await import('./field-validation.js');
const status = await import('./creator-status.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);

await query('select 1');
await query('truncate wall_posts, performer_records, users restart identity');
await query('drop table if exists performer_record_documents');

section('wall: bounded pages with a cursor (social#2)');
{
  // Seeded directly -- the daily cap would (correctly) stop one author at 50.
  for (let i = 0; i < 120; i++) {
    await query('insert into wall_posts (data) values ($1)', [{ creatorId: 'w1', authorId: `a${i}`, authorName: 'A', text: `p${i}`, createdAt: new Date().toISOString() }]);
  }
  await query('insert into wall_posts (data) values ($1)', [{ creatorId: 'w2', authorId: 'x', authorName: 'X', text: 'other', createdAt: new Date().toISOString() }]);
  const first = await wall.getWallPageForCreator('w1');
  check('first page is WALL_PAGE_SIZE, newest first', first.posts.length === wall.WALL_PAGE_SIZE && first.posts[0].text === 'p119', `${first.posts.length} ${first.posts[0]?.text}`);
  check('first page says there is more', first.hasMore === true && !!first.nextBefore);
  const second = await wall.getWallPageForCreator('w1', { before: first.nextBefore });
  check('the next page continues with no overlap', second.posts[0].text === 'p69' && second.posts.length === 50, second.posts[0]?.text);
  const third = await wall.getWallPageForCreator('w1', { before: second.nextBefore });
  check('the last page ends the wall', third.posts.length === 20 && third.hasMore === false && third.nextBefore === null);
  const all = [...first.posts, ...second.posts, ...third.posts].map((p) => p.text);
  check('every post seen exactly once, only this wall', new Set(all).size === 120 && !all.includes('other'));
  check('the SSR helper is bounded too', (await wall.getWallPostsForCreator('w1')).length === wall.WALL_PAGE_SIZE);
  check('limit is capped at 100', (await wall.getWallPageForCreator('w1', { limit: 5000 })).posts.length === 100);
  check('a garbage cursor starts from the top', (await wall.getWallPageForCreator('w1', { before: "1; drop table x" })).posts[0].text === 'p119');
}

section('wall: per-author daily cap in the database');
{
  const results = await Promise.allSettled(Array.from({ length: wall.WALL_DAILY_CAP_PER_AUTHOR + 10 }, (_, i) =>
    wall.addWallPost({ creatorId: 'w3', authorId: 'spam', authorName: 'S', text: `s${i}` })));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  check('concurrent posts stop exactly at the cap', ok === wall.WALL_DAILY_CAP_PER_AUTHOR, String(ok));
  check('the rest are refused with WALL_DAILY_CAP', results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'WALL_DAILY_CAP'));
  const other = await wall.addWallPost({ creatorId: 'w4', authorId: 'spam', authorName: 'S', text: 'a different wall' });
  check('the cap is per wall', !!other.id);
  const own = await wall.addWallPost({ creatorId: 'w3', authorId: 'spam', authorName: 'S', text: 'owner reply', isWallOwner: true });
  check('the wall\'s own creator is not capped on their own wall', !!own.id);
}

section('§2257 go-live check needs an ID on file (accounts#4 / social#6 / admin-ui#2)');
{
  check('no record at all', (await records.performerRecordStatusForCreator('c7')) === 'no_record');
  const rec = await records.createPerformerRecord({ legalName: 'Jane Doe', dateOfBirth: '1995-01-01', creatorId: 'c7', producedAt: '2026-09-01' });
  check('a name + DOB record with no ID does not count', (await records.performerRecordStatusForCreator('c7')) === 'no_document');
  await records.attachPerformerDocument(rec.id, Buffer.from('fake-id-scan'), 'image/jpeg', 'id.jpg');
  check('attaching the ID makes it count', (await records.performerRecordStatusForCreator('c7')) === 'ok');
  const off = await records.createPerformerRecord({ legalName: 'Sam Roe', dateOfBirth: '1990-05-05', creatorId: 'c8', producedAt: '2026-09-01' });
  check('another creator: still no document', (await records.performerRecordStatusForCreator('c8')) === 'no_document');
  await records.updatePerformerRecord(off.id, { documentLocation: 'offline' });
  check('marked held offline counts', (await records.performerRecordStatusForCreator('c8')) === 'ok');
  const unlinked = await records.createPerformerRecord({ legalName: 'Lee Poe', dateOfBirth: '1990-05-05', documentLocation: 'offline', producedAt: '2026-09-01' });
  check('an unlinked record counts for nobody', (await records.performerRecordStatusForCreator('c9')) === 'no_record');
  await records.updatePerformerRecord(unlinked.id, { creatorId: 'c9' });
  check('linking an existing record via update satisfies the gate (admin-ui#3)', (await records.performerRecordStatusForCreator('c9')) === 'ok');
  await records.archivePerformerRecord(unlinked.id, 'test');
  check('an archived record does not count', (await records.performerRecordStatusForCreator('c9')) === 'no_record');
}

section('co-performer attestation on upload finalize (legal-journeys#4)');
{
  const att = await import('./performer-attestation.js');
  check('no answer is refused', (await att.resolvePerformerAttestation({})).status === 400);
  check('a non-boolean answer is refused', (await att.resolvePerformerAttestation({ othersAppear: 'no' })).status === 400);
  const solo = await att.resolvePerformerAttestation({ othersAppear: false });
  check('solo is accepted and recorded', solo.attestation?.othersAppear === false && !!solo.attestation.attestedAt);
  check('a creator saying others appear is refused', (await att.resolvePerformerAttestation({ othersAppear: true })).status === 403);
  check('admin: others appear needs record ids', (await att.resolvePerformerAttestation({ othersAppear: true }, { admin: true })).status === 400);
  const withId = (await query(`select id::text as id from performer_records where data->>'creatorId' = 'c7'`)).rows[0].id;
  const noId = await records.createPerformerRecord({ legalName: 'No Id', dateOfBirth: '1990-01-01', producedAt: '2026-09-01' });
  check('admin: a record with no ID on file is refused',
    (await att.resolvePerformerAttestation({ othersAppear: true, coPerformerRecordIds: [String(noId.id)] }, { admin: true })).status === 409);
  // Round 4: the admin finalize names the creator the file is for, and that
  // creator's own record cannot stand in for another person's.
  const okAdmin = await att.resolvePerformerAttestation({ othersAppear: true, coPerformerRecordIds: [withId] }, { admin: true, creatorId: 'c9' });
  check("admin: the creator's own record is refused as a co-performer",
    (await att.resolvePerformerAttestation({ othersAppear: true, coPerformerRecordIds: [withId] }, { admin: true, creatorId: 'c7' })).status === 409);
  check('admin: records with an ID are accepted and listed', okAdmin.attestation?.coPerformerRecordIds?.[0] === withId, JSON.stringify(okAdmin));
  check('admin: a malformed id is refused', (await att.resolvePerformerAttestation({ othersAppear: true, coPerformerRecordIds: [withId, 'x;1'] }, { admin: true })).status === 400);
}

section('signup acceptance is stored on the account (legal-journeys#5)');
{
  const at = new Date().toISOString();
  const u = await users.createUser({ email: 'accept@test.local', password: 'password123', role: 'fan', acceptance: { tosAcceptedAt: at, tosVersion: '2026-09-24', ageAttestedAt: at } });
  const { rows } = await query('select data from users where id = $1', [u.id]);
  check('tosAcceptedAt, tosVersion and ageAttestedAt are stored',
    rows[0].data.tosAcceptedAt === at && rows[0].data.tosVersion === '2026-09-24' && rows[0].data.ageAttestedAt === at, JSON.stringify(rows[0].data));
}

section('names: phone numbers and reserved platform names (accounts#2, accounts#7)');
{
  for (const bad of ['6175551234', '@6175551234', '617-555-1234', '+1 (617) 555 1234', '617.555.1234']) {
    check(`handle "${bad}" refused`, !!fv.normalizeHandle(bad).error);
    check(`"${bad}" looks like a phone`, fv.looksLikePhoneNumber(bad));
  }
  for (const ok of ['jane99', 'jane_2024', '12345', 'club21']) check(`handle "${ok}" allowed`, !fv.normalizeHandle(ok).error);
  for (const bad of ['OnlyOne Support', '@onlyone_team', 'support', 'Admin', '0nly0ne', 'OnlyOne', 'official', 'Jane (staff)', 'joinonlyone', 'the only one',
    'the_only_one', 'O.n.l.y.O.n.e', 'Only-One team', 'OnIyOne', 'only1']) {
    check(`reserved "${bad}"`, fv.isReservedName(bad) === true);
  }
  for (const ok of ['Supportive Sam', 'badminton babe', 'janeofficial', 'Staffordshire Lass', 'Jane Doe', '@jane99', 'Moderately Spicy',
    'Don Lyone', 'Jon Lyonel', 'Colonly Onex', 'Only 1 spot left']) {
    check(`not reserved "${ok}"`, fv.isReservedName(ok) === false);
  }
}

section('payout wallet: strict EIP-55 (accounts#3)');
{
  const good = '0x2c34ED86552076715272056D021cEab6080F1Ab5';
  check('a correctly checksummed address passes', fv.payoutWalletError(good) === null);
  check('all-lowercase passes', fv.payoutWalletError(good.toLowerCase()) === null);
  check('all-uppercase hex passes', fv.payoutWalletError('0x' + good.slice(2).toUpperCase()) === null);
  check('a mixed-case typo is refused as a checksum error', fv.payoutWalletError('0x2c34ED86552076715272056D021cEab6080F1Ab6') === fv.WALLET_CHECKSUM_MESSAGE);
  check('the zero address is refused', !!fv.payoutWalletError('0x' + '0'.repeat(40)));
  check('garbage is refused', fv.payoutWalletError('0x123') === fv.WALLET_FORMAT_MESSAGE);
  const fields = { walletAddress: '0x2c34ED86552076715272056D021cEab6080F1Ab6' };
  check('sanitizePayoutFields refuses the typo', fv.sanitizePayoutFields(fields) === fv.WALLET_CHECKSUM_MESSAGE);
  const credits = await import('./credits-store.js');
  let threw = null;
  try { credits.normalizePayoutWallet('0x2c34ED86552076715272056D021cEab6080F1Ab6'); } catch (e) { threw = e; }
  check('requestPayout\'s wallet check refuses the typo too', threw?.code === credits.INVALID_PAYOUT_WALLET);
}

section('public projection: no invented engagement counts (admin-ui#5)');
{
  const pub = status.toPublicCreator({ id: '1', name: 'A', status: 'active', subs: '12.4K', likes: '98K', posts: 900, media: 900, gallery: [{ type: 'image', src: '/images/a.jpg' }, { type: 'image', src: '/images/b.jpg' }] });
  check('subs and likes are not published', !('subs' in pub) && !('likes' in pub));
  check('posts/media are the real gallery count', pub.posts === 2 && pub.media === 2, `${pub.posts} ${pub.media}`);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
