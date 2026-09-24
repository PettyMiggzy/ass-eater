// Regression tests for the wave-2 library fixes, run against a real Postgres
// (never mocks):
//  - creators_id_seq is advanced past existing rows on process start, even on
//    a database that was seeded before that step existed;
//  - the content-violation ladder: a pending applicant is never suspended, a
//    banned creator is never downgraded, a report id counts once, and the
//    UPDATE can run on (and roll back with) a caller's transaction;
//  - profile saves: tags screened JOINED, payout wallet validated + stored
//    checksummed, payoutMethod forced to usdg;
//  - a manual ban takes down every unsold listing as a moderation removal,
//    leaves sold listings (and their buyers' media) alone, and is a no-op on
//    re-save; an echoed legacy wallet never blocks moderation;
//  - marketplace create/update screen title, description and tags for
//    prohibited terms as well as payment circumvention;
//  - the DM price floor comes from lib/brand.js.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test \
//   node --import ./test-register.mjs lib/w2lib-rules.test.mjs
//
// Truncates tables, so it refuses anything but a local scratch database.

import { query, withTransaction, closePool } from './db.js';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}

process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-w2lib';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  PASS', name);
  } else {
    fail++;
    console.log('  FAIL', name, extra);
  }
};
const section = (s) => console.log('\n' + s);

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
  };
}
let ipCounter = 0;
function req({ body, headers = {}, method = 'POST' }) {
  ipCounter++;
  return {
    method,
    body,
    headers: { 'x-forwarded-for': `10.8.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`, ...headers },
    socket: { remoteAddress: `10.8.0.${ipCounter % 250}` },
  };
}
const admin = (body) => req({ body, headers: { 'x-admin-key': process.env.ADMIN_UPLOAD_KEY } });
async function call(handler, r) {
  const res = mockRes();
  await handler(r, res);
  return res;
}

// ---- Sequence advance: must run BEFORE anything touches the creators store,
// because the advance happens once per process, on first use. Recreate the
// production state: seed rows at explicit ids, "already seeded" recorded, and
// a sequence that was never moved past them.
await import('./db.js').then((m) => m.query('select 1')); // schema created
await query('truncate creators, users, listings, violations, performer_records restart identity');
await query('delete from app_meta');
await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
for (const id of [1, 2, 4]) {
  await query('insert into creators (id, data) values ($1, $2)', [String(id), { name: `Seed ${id}`, seed: true, status: 'active' }]);
}
await query(`select setval('creators_id_seq', 1, false)`);

const creatorsStore = await import('./creators-store.js');
const listingsStore = await import('./listings-store.js');
const usersStore = await import('./users-store.js');
const session = await import('./session.js');
const messagesStore = await import('./messages-store.js');
const brand = await import('./brand.js');
const adminProfile = (await import('../pages/api/admin/profile.js')).default;
const meProfile = (await import('../pages/api/me/profile.js')).default;
const mpCreate = (await import('../pages/api/marketplace/create.js')).default;
const mpUpdate = (await import('../pages/api/marketplace/update.js')).default;

let handleN = 0;
const mk = (fields) => creatorsStore.createCreator({ handle: `@w2lib${++handleN}`, ...fields });

section('creators_id_seq is advanced past existing ids on first use');
{
  const made = await mk({ name: 'Real One', status: 'pending' });
  check('new creator does not collide with a seed id', made.id === '5', `got id ${made.id}`);
  const again = await mk({ name: 'Real Two', status: 'pending' });
  check('next id continues from there', again.id === '6', `got id ${again.id}`);
}

async function reset() {
  await query('truncate creators, users, listings, violations, performer_records restart identity');
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}

await reset();

section('Violation ladder: pending applicants are never suspended');
{
  const c = await mk({ name: 'Applicant', status: 'pending' });
  const v1 = await creatorsStore.applyContentViolation(c.id);
  check('first violation keeps a pending applicant pending', v1.status === 'pending', JSON.stringify(v1));
  check('...with no suspension clock', v1.suspendedUntil == null);
  check('...and the violation counted', v1.contentViolationCount === 1);
  check('...still not publicly visible', !creatorsStore.isPubliclyVisible(v1));
  const v2 = await creatorsStore.applyContentViolation(c.id);
  check('second violation bans them', v2.status === 'banned' && v2.contentViolationCount === 2);
}

section('Violation ladder: an existing ban is never downgraded');
{
  const c = await mk({ name: 'Banned By Hand', status: 'banned' });
  const v = await creatorsStore.applyContentViolation(c.id);
  check('manually banned creator stays banned', v.status === 'banned' && v.suspendedUntil == null, JSON.stringify(v));
}

section('Violation ladder: an active creator is suspended, then banned');
{
  const c = await mk({ name: 'Active', status: 'active' });
  const v1 = await creatorsStore.applyContentViolation(c.id, null, { reportId: 'r-1' });
  check('first violation suspends', v1.status === 'suspended' && Date.parse(v1.suspendedUntil) > Date.now());
  const retried = await creatorsStore.applyContentViolation(c.id, null, { reportId: 'r-1' });
  check('same report id does not count twice', retried.contentViolationCount === 1 && retried.status === 'suspended',
    JSON.stringify(retried));
  const v2 = await creatorsStore.applyContentViolation(c.id, null, { reportId: 'r-2' });
  check('a different report bans', v2.status === 'banned' && v2.contentViolationCount === 2);
  check('both report ids recorded', JSON.stringify(v2.appliedNciiReportIds) === JSON.stringify(['r-1', 'r-2']));
}

section('Violation ladder: runs on (and rolls back with) a caller transaction');
{
  const c = await mk({ name: 'Tx', status: 'active', contentViolationCount: 1 });
  const l = await listingsStore.createListing(c.id, { title: 'Thing', priceCents: 500 });
  try {
    await withTransaction(async (client) => {
      const inTx = await creatorsStore.applyContentViolation(c.id, client, { reportId: 'r-9' });
      if (inTx.status !== 'banned') throw new Error(`expected banned in tx, got ${inTx.status}`);
      throw new Error('rollback please');
    });
  } catch (err) {
    check('transaction rolled back as asked', err.message === 'rollback please', err.message);
  }
  const after = await creatorsStore.getCreatorById(c.id);
  check('rolled-back violation left no trace', after.status === 'active' && after.contentViolationCount === 1
    && !(after.appliedNciiReportIds || []).length, JSON.stringify(after));
  const committed = await withTransaction((client) => creatorsStore.applyContentViolation(c.id, client, { reportId: 'r-9' }));
  check('committed via client: banned', committed.status === 'banned');
  check('with a client, listing takedown is left to the caller', (await listingsStore.getListingById(l.id)).status === 'active');
}

await reset();

section("Creator's own editor: joined tags screened, wallet validated and checksummed");
{
  const c = await mk({ name: 'Jane', handle: '@jane', status: 'active' });
  const user = await usersStore.createUser({ email: 'jane@example.com', password: 'secret123', role: 'creator', creatorId: c.id });
  const cookie = `oa_session=${encodeURIComponent(session.createSessionToken(user.id, user.sessionVersion))}`;
  const me = (fields) => call(meProfile, req({ body: { fields }, headers: { cookie } }));

  for (const tags of [['cash', 'app jane'], ['text me', '555 123 4567']]) {
    const res = await me({ tags });
    check(`tags split across chips ${JSON.stringify(tags)} refused`, res.statusCode === 400, JSON.stringify(res.body));
  }
  const { rows: v } = await query(`select count(*)::int as n from violations where data->>'context' = 'tags'`);
  check('joined-tag refusals logged as violations', v[0].n === 2, `got ${v[0].n}`);
  let res = await me({ tags: ['cosplay', 'gym'] });
  check('ordinary tags still save', res.statusCode === 200, JSON.stringify(res.body));

  res = await me({ walletAddress: '0x123' });
  check('malformed wallet refused', res.statusCode === 400);
  res = await me({ walletAddress: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' });
  check('non-EVM wallet refused', res.statusCode === 400);
  const lower = '0x52908400098527886e0f7030069857d2e4169ee7';
  res = await me({ walletAddress: lower, payoutMethod: 'eth' });
  check('valid wallet saved checksummed', res.statusCode === 200
    && res.body.creator.walletAddress === '0x52908400098527886E0F7030069857D2E4169EE7', JSON.stringify(res.body));
  check('payoutMethod forced to usdg', res.body.creator.payoutMethod === 'usdg');
  res = await me({ walletAddress: '' });
  check('empty wallet clears it', res.statusCode === 200 && res.body.creator.walletAddress === '');
}

section('Admin editor: joined tags screened, wallet checksummed, echoed tags not re-judged');
{
  const c = await mk({ name: 'Mia', handle: '@mia', status: 'active' });
  let res = await call(adminProfile, admin({ creatorId: c.id, fields: { tags: ['cash', 'app mia'] } }));
  check('admin joined-tag write refused', res.statusCode === 400 && /Tags/.test(res.body.error), JSON.stringify(res.body));
  res = await call(adminProfile, admin({ creatorId: c.id, fields: { walletAddress: '0x52908400098527886e0f7030069857d2e4169ee7' } }));
  check('admin wallet saved checksummed', res.statusCode === 200
    && res.body.creator.walletAddress === '0x52908400098527886E0F7030069857D2E4169EE7', JSON.stringify(res.body));
  res = await call(adminProfile, admin({ creatorId: c.id, fields: { walletAddress: 'nope' } }));
  check('admin malformed wallet refused', res.statusCode === 400);

  // A legacy record whose stored tags would now be flagged can still be
  // moderated when the panel merely echoes them back.
  await creatorsStore.updateCreatorProfile(c.id, { tags: ['cash', 'app mia'] });
  res = await call(adminProfile, admin({ creatorId: c.id, fields: { tags: ['cash', 'app mia'], status: 'suspended' } }));
  check('echoed legacy tags do not block a suspension', res.statusCode === 200, JSON.stringify(res.body));
}

section('Admin manual ban: every unsold listing taken down as moderation');
{
  const c = await mk({ name: 'Seller', handle: '@seller', status: 'active' });
  const live = await listingsStore.createListing(c.id, { title: 'Live', priceCents: 500 });
  const pulled = await listingsStore.createListing(c.id, { title: 'Pulled', priceCents: 500 });
  await query(`update listings set data = data || '{"status":"removed"}'::jsonb where id = $1`, [String(pulled.id)]);
  const sold = await listingsStore.createListing(c.id, { title: 'Sold', priceCents: 500 });
  await query(`update listings set data = data || '{"status":"sold"}'::jsonb where id = $1`, [String(sold.id)]);

  const res = await call(adminProfile, admin({ creatorId: c.id, fields: { status: 'banned' } }));
  check('manual ban saved', res.statusCode === 200, JSON.stringify(res.body));
  const [a, b, s] = await Promise.all([live, pulled, sold].map((l) => listingsStore.getListingById(l.id)));
  check('active listing removed by moderation', a.status === 'removed' && a.moderationRemoved === true);
  check('self-removed listing marked as moderation too (cannot be relisted)', b.moderationRemoved === true);
  check('sold listing keeps its sold status', s.status === 'sold');
  // A manual ban is not a finding about the content: a buyer who already paid
  // for a sold item keeps it (the NCII path is what takes sold media down).
  check('sold listing not moderation-removed by a manual ban', !s.moderationRemoved && !s.mediaDeletedAt, JSON.stringify(s));

  // The panel posts status on every save; re-saving a banned creator must not
  // re-run the takedown on already-removed listings (no churn, no 500).
  const stampBefore = a.mediaDeletedAt;
  const again = await call(adminProfile, admin({ creatorId: c.id, fields: { status: 'banned', bio: 'edited while banned' } }));
  check('re-saving a banned creator succeeds', again.statusCode === 200, JSON.stringify(again.body));
  const a2 = await listingsStore.getListingById(live.id);
  check('re-save does not re-run the takedown', a2.mediaDeletedAt === stampBefore);
}

section('Admin editor: a legacy malformed wallet does not block moderation');
{
  const c = await mk({ name: 'Legacy', handle: '@legacy', status: 'active' });
  await creatorsStore.updateCreatorProfile(c.id, { walletAddress: 'not-a-wallet' });
  let res = await call(adminProfile, admin({ creatorId: c.id, fields: { walletAddress: 'not-a-wallet', status: 'suspended' } }));
  check('echoed malformed wallet does not block a suspension', res.statusCode === 200 && res.body.creator.status === 'suspended', JSON.stringify(res.body));
  res = await call(adminProfile, admin({ creatorId: c.id, fields: { walletAddress: 'still-not-a-wallet' } }));
  check('a CHANGED malformed wallet is still refused', res.statusCode === 400);
}

await reset();

section('Marketplace create/update: prohibited terms screened on title, description and tags');
{
  const c = await mk({ name: 'Maker', handle: '@maker', status: 'active' });
  const user = await usersStore.createUser({ email: 'maker@example.com', password: 'secret123', role: 'creator', creatorId: c.id });
  const cookie = `oa_session=${encodeURIComponent(session.createSessionToken(user.id, user.sessionVersion))}`;
  const create = (body) => call(mpCreate, req({ body, headers: { cookie } }));
  const update = (body) => call(mpUpdate, req({ body, headers: { cookie } }));

  let res = await create({ title: 'Schoolgirl outfit video', priceCents: 500 });
  check('prohibited term in title refused', res.statusCode === 400, JSON.stringify(res.body));
  res = await create({ title: 'Gym video', description: 'teen fun', priceCents: 500 });
  check('prohibited term in description refused', res.statusCode === 400, JSON.stringify(res.body));
  res = await create({ title: 'Gym video', priceCents: 500, tags: 'gym, teen' });
  check('prohibited tag refused', res.statusCode === 400, JSON.stringify(res.body));
  res = await create({ title: 'Gym video', priceCents: 500, tags: ['cash', 'app maker'] });
  check('payment handle split across tags refused', res.statusCode === 400, JSON.stringify(res.body));
  const { rows: v } = await query(`select count(*)::int as n from violations where data->>'context' like 'listing_%'`);
  check('each refusal logged as a violation', v[0].n === 4, `got ${v[0].n}`);

  res = await create({ title: 'Gym video', description: 'Full session', priceCents: 500, tags: 'gym, fitness' });
  check('clean listing created', res.statusCode === 200, JSON.stringify(res.body));
  const id = res.body.listing.id;
  res = await update({ listingId: id, fields: { description: 'teen stuff' } });
  check('update: prohibited description refused', res.statusCode === 400, JSON.stringify(res.body));
  res = await update({ listingId: id, fields: { tags: ['gym', 'Lolita'] } });
  check('update: prohibited tag refused', res.statusCode === 400, JSON.stringify(res.body));
  res = await update({ listingId: id, fields: { title: 'Gym video, part 2' } });
  check('update: clean title saves', res.statusCode === 200, JSON.stringify(res.body));
}

section('DM price floor is the one Terms quotes');
{
  check('DM_FLOOR_CENTS comes from lib/brand.js', messagesStore.DM_FLOOR_CENTS === brand.DM_PRICE_FLOOR_CENTS);
  check('dmPriceCentsFor(null price) is the floor', messagesStore.dmPriceCentsFor({}) === brand.DM_PRICE_FLOOR_CENTS);
  check('dmPriceCentsFor below floor is the floor', messagesStore.dmPriceCentsFor({ dmPriceCents: 10 }) === brand.DM_PRICE_FLOOR_CENTS);
  check('dmPriceCentsFor above floor is kept', messagesStore.dmPriceCentsFor({ dmPriceCents: 500 }) === 500);
}

await closePool();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
