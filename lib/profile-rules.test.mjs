// Route-level tests for the creator profile rules, run against a real
// Postgres (never mocks): the admin approval gate (§2257 record, handle),
// Founding auto-grant only on a real pending -> active approval and never
// after a revoke, a manual ban taking listings down, "+ Add Model" creating
// pending drafts that don't collide, handle normalisation + uniqueness
// across "@", avatar URL restrictions, public-text screening on every
// public field, and signup screening.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test \
//   node --import ./test-register.mjs lib/profile-rules.test.mjs
//
// Truncates tables, so it refuses anything but a local scratch database.

import { query, closePool } from './db.js';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}

process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-p4';
process.env.SIGNUPS_OPEN = 'true';

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
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
  };
  return res;
}

let ipCounter = 0;
function req({ body, headers = {}, method = 'POST' }) {
  ipCounter++;
  return {
    method,
    body,
    headers: { 'x-forwarded-for': `10.9.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`, ...headers },
    socket: { remoteAddress: `10.9.0.${ipCounter % 250}` },
  };
}
const admin = (body) => req({ body, headers: { 'x-admin-key': process.env.ADMIN_UPLOAD_KEY } });

const creatorsStore = await import('./creators-store.js');
const listingsStore = await import('./listings-store.js');
const usersStore = await import('./users-store.js');
const session = await import('./session.js');
const adminProfile = (await import('../pages/api/admin/profile.js')).default;
const adminCreate = (await import('../pages/api/admin/create.js')).default;
const meProfile = (await import('../pages/api/me/profile.js')).default;
const signup = (await import('../pages/api/auth/signup.js')).default;
const submit = (await import('../pages/api/creator/submit.js')).default;

async function reset() {
  await query('truncate creators, users, listings, violations, performer_records restart identity');
  await query('delete from app_meta');
  // Mark seeding as done so the demo roster doesn't join every test.
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}

async function call(handler, r) {
  const res = mockRes();
  await handler(r, res);
  return res;
}

const QUALIFYING = {
  name: 'Jane Real',
  handle: '@janereal',
  bio: 'A real, finished bio that is comfortably over forty characters long.',
  img: '/images/demo_female_avatar.jpg',
  tags: ['cosplay'],
  gallery: [{ src: '/images/a.jpg' }, { src: '/images/b.jpg' }, { src: '/images/c.jpg' }],
};

async function addRecord(creatorId, status = 'active') {
  await query('insert into performer_records (data) values ($1)', [{ creatorId: String(creatorId), status, aliases: [], documentLocation: 'offline' }]);
}

async function panelSave(creator, overrides = {}) {
  // What pages/admin/index.js posts: every field, status as the effective one.
  const fields = {
    name: creator.name,
    handle: creator.handle,
    bio: creator.bio,
    img: creator.img,
    status: creatorsStore.effectiveCreatorStatus(creator) || 'active',
    founding: !!creator.founding,
    tags: creator.tags || [],
    ...overrides,
  };
  return call(adminProfile, admin({ creatorId: creator.id, fields }));
}

await reset();

section('§2257 gate: a creator cannot go live without a performer record');
{
  const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'pending' });
  let res = await panelSave(c, { status: 'active' });
  check('approval refused with no record', res.statusCode === 409 && /2257/.test(res.body.error), JSON.stringify(res.body));
  check('status unchanged after refusal', (await creatorsStore.getCreatorById(c.id)).status === 'pending');

  await addRecord(c.id, 'archived');
  res = await panelSave(c, { status: 'active' });
  check('an ARCHIVED record does not count', res.statusCode === 409);

  await addRecord(c.id, 'active');
  res = await panelSave(c, { status: 'active' });
  check('approval succeeds once an active record exists', res.statusCode === 200, JSON.stringify(res.body));
  const after = await creatorsStore.getCreatorById(c.id);
  check('approved creator is active', after.status === 'active');
  check('qualifying creator auto-granted Founding on approval', after.founding === true && !!after.foundingSince);
}

await reset();

section('Founding auto-grant: never after an expired suspension, a reinstatement, or on a seed');
{
  // Expired violation suspension, admin fixes a typo.
  const s = await creatorsStore.createCreator({
    ...QUALIFYING,
    handle: '@suspended1',
    status: 'suspended',
    suspendedUntil: new Date(Date.now() - 1000).toISOString(),
    contentViolationCount: 1,
  });
  await addRecord(s.id);
  let res = await panelSave(s, { bio: QUALIFYING.bio + ' typo fixed' });
  check('save after lapsed suspension succeeds', res.statusCode === 200, JSON.stringify(res.body));
  check('lapsed suspension is NOT an approval -- no Founding', !(await creatorsStore.getCreatorById(s.id)).founding);

  // Banned -> reinstated.
  const b = await creatorsStore.createCreator({ ...QUALIFYING, handle: '@banned1', status: 'banned' });
  await addRecord(b.id);
  res = await panelSave(b, { status: 'active' });
  check('reinstatement succeeds', res.statusCode === 200, JSON.stringify(res.body));
  check('reinstatement does not grant Founding', !(await creatorsStore.getCreatorById(b.id)).founding);

  // Seed/legacy with no status: saving must not require a record or grant.
  const seed = await creatorsStore.createCreator({ ...QUALIFYING, handle: '@seedish', seed: true });
  res = await panelSave(seed, {});
  check('seed save works without a performer record', res.statusCode === 200, JSON.stringify(res.body));
  check('seed save does not grant Founding', !(await creatorsStore.getCreatorById(seed.id)).founding);
}

await reset();

section('Founding: an explicit revoke is sticky');
{
  const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'pending' });
  await addRecord(c.id);
  await panelSave(c, { status: 'active' });
  let cur = await creatorsStore.getCreatorById(c.id);
  check('granted at approval', cur.founding === true);
  let res = await panelSave(cur, { founding: false });
  cur = await creatorsStore.getCreatorById(c.id);
  check('revoke saved and remembered', res.statusCode === 200 && cur.founding === false && !!cur.foundingRevokedAt);
  // Suspend then back to pending then approve again: must not re-grant.
  await panelSave(cur, { status: 'pending' });
  cur = await creatorsStore.getCreatorById(c.id);
  await panelSave(cur, { status: 'active' });
  cur = await creatorsStore.getCreatorById(c.id);
  check('re-approval after revoke does not re-grant', cur.status === 'active' && !cur.founding);
  // Admin can still deliberately re-grant.
  res = await panelSave(cur, { founding: true });
  cur = await creatorsStore.getCreatorById(c.id);
  check('explicit re-grant works and clears the marker', cur.founding === true && !cur.foundingRevokedAt);
}

await reset();

section('Manual ban takes the creator\'s active listings down');
{
  const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'active' });
  const other = await creatorsStore.createCreator({ ...QUALIFYING, handle: '@other1', status: 'active' });
  const l1 = await listingsStore.createListing(c.id, { title: 'A', priceCents: 500 });
  const l2 = await listingsStore.createListing(other.id, { title: 'B', priceCents: 500 });
  const res = await panelSave(c, { status: 'banned' });
  check('ban saved', res.statusCode === 200, JSON.stringify(res.body));
  const all = await listingsStore.getListings();
  check('banned creator\'s listing removed', all.find((l) => String(l.id) === String(l1.id)).status === 'removed');
  check('other creator\'s listing untouched', all.find((l) => String(l.id) === String(l2.id)).status === 'active');
}

await reset();

section('+ Add Model: pending drafts, no 409 on the second click, body allowlisted');
{
  const r1 = await call(adminCreate, admin({}));
  const r2 = await call(adminCreate, admin({}));
  check('first Add Model succeeds', r1.statusCode === 200, JSON.stringify(r1.body));
  check('second Add Model succeeds too', r2.statusCode === 200, JSON.stringify(r2.body));
  check('new model is pending, not live', r1.body.creator.status === 'pending' && !creatorsStore.isPubliclyVisible(r1.body.creator));
  const r3 = await call(adminCreate, admin({ founding: true, foundingSince: '2020-01-01', seed: true, status: 'active', contentViolationCount: 0 }));
  check('forbidden body fields are ignored', r3.statusCode === 200 && !r3.body.creator.founding && !r3.body.creator.seed && r3.body.creator.status === 'pending', JSON.stringify(r3.body));
  const r4 = await call(adminCreate, admin({ img: 'https://tracker.example/p.gif' }));
  check('external avatar refused on create', r4.statusCode === 400);
  // A blank-handle draft can't go live.
  await addRecord(r1.body.creator.id);
  const r5 = await panelSave(r1.body.creator, { status: 'active', handle: '' });
  check('blank handle blocks going live', r5.statusCode === 409 && /handle/i.test(r5.body.error), JSON.stringify(r5.body));
}

await reset();

section('Handles: one canonical form, uniqueness across "@"');
{
  const a = await creatorsStore.createCreator({ ...QUALIFYING, handle: '@alice', status: 'active' });
  const b = await creatorsStore.createCreator({ ...QUALIFYING, handle: '@bob', status: 'active' });
  let res = await panelSave(b, { handle: 'alice' });
  check('"alice" collides with "@alice" -> friendly 409', res.statusCode === 409 && /taken/.test(res.body.error), JSON.stringify(res.body));
  res = await panelSave(b, { handle: '@@Bobby' });
  check('handle normalised to "@Bobby"', res.statusCode === 200 && res.body.creator.handle === '@Bobby', JSON.stringify(res.body));
  res = await panelSave(b, { handle: 'bad handle!' });
  check('bad charset refused', res.statusCode === 400);
  check('unrelated creator untouched', (await creatorsStore.getCreatorById(a.id)).handle === '@alice');
}

await reset();

section('Admin avatar + public text screening');
{
  const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'active' });
  await addRecord(c.id);
  let res = await panelSave(c, { img: 'https://tracker.example/p.gif' });
  check('admin cannot set an external avatar', res.statusCode === 400);
  res = await panelSave(c, { img: `/api/media/avatars/${c.id}/abc.jpg` });
  check('admin can set this creator\'s own media avatar', res.statusCode === 200, JSON.stringify(res.body));
  const cur = await creatorsStore.getCreatorById(c.id);
  res = await panelSave(cur, { img: '/api/media/avatars/99999/abc.jpg' });
  check('another creator\'s media folder refused', res.statusCode === 400);
  res = await call(adminProfile, admin({ creatorId: c.id, fields: { location: 'venmo @mia 555-123-4567' } }));
  check('location screened on admin save', res.statusCode === 400 && /Location/.test(res.body.error), JSON.stringify(res.body));
  res = await call(adminProfile, admin({ creatorId: c.id, fields: { tags: ['cosplay', 'teen'] } }));
  check('prohibited tag refused on admin save', res.statusCode === 400 && /Tags/.test(res.body.error), JSON.stringify(res.body));
  res = await call(adminProfile, admin({ creatorId: c.id, fields: { price: 'cashapp $miaxo' } }));
  check('price screened on admin save', res.statusCode === 400);
  const { rows } = await query('select count(*)::int as n from violations');
  check('each refusal logged a violation', rows[0].n === 3, `got ${rows[0].n}`);

  // Stored flagged bio + unrelated moderation save still works...
  await creatorsStore.updateCreatorProfile(c.id, { bio: 'cashapp $jane for customs' });
  const flagged = await creatorsStore.getCreatorById(c.id);
  res = await panelSave(flagged, { status: 'suspended' });
  check('moderation save on stored-flagged text still works', res.statusCode === 200, JSON.stringify(res.body));
  // ...but going live re-checks everything, changed or not.
  const p = await creatorsStore.createCreator({ ...QUALIFYING, handle: '@pend1', bio: 'DM me cashapp $jane, 555-123-4567', status: 'pending' });
  await addRecord(p.id);
  res = await panelSave(p, { status: 'active' });
  check('approval re-screens unchanged signup bio', res.statusCode === 400 && /Bio/.test(res.body.error), JSON.stringify(res.body));
  check('and nothing was saved', (await creatorsStore.getCreatorById(p.id)).status === 'pending');
}

await reset();

section('Admin status and dmPriceCents validation');
{
  const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'active' });
  let res = await panelSave(c, { status: 'superstar' });
  check('unknown status refused', res.statusCode === 400);
  res = await call(adminProfile, admin({ creatorId: c.id, fields: { dmPriceCents: 250 } }));
  check('dmPriceCents saved', res.statusCode === 200 && res.body.creator.dmPriceCents === 250);
  res = await call(adminProfile, admin({ creatorId: c.id, fields: { dmPriceCents: 10 } }));
  check('dmPriceCents below floor refused', res.statusCode === 400);
  res = await call(adminProfile, admin({ creatorId: c.id, fields: { payoutMethod: 'eth', walletAddress: 'not-a-wallet' } }));
  check('bad payout wallet refused', res.statusCode === 400);
  res = await call(adminProfile, admin({ creatorId: c.id, fields: { payoutMethod: 'eth', walletAddress: '0x0000000000000000000000000000000000000001' } }));
  check('payout method forced to usdg', res.statusCode === 200 && res.body.creator.payoutMethod === 'usdg', JSON.stringify(res.body));
  res = await call(adminProfile, admin({ creatorId: '99999', fields: { name: 'x' } }));
  check('unknown creator -> 404', res.statusCode === 404);
}

await reset();

section('Creator\'s own editor: img ignored, all public fields screened, handle normalised');
{
  const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'active' });
  const user = await usersStore.createUser({ email: 'jane@example.com', password: 'secret123', role: 'creator', creatorId: c.id });
  const cookie = `oa_session=${encodeURIComponent(session.createSessionToken(user.id, user.sessionVersion))}`;
  const me = (fields) => call(meProfile, req({ body: { fields }, headers: { cookie } }));

  let res = await me({ img: 'https://tracker.example/p.gif', bio: QUALIFYING.bio });
  check('save with an img field succeeds', res.statusCode === 200, JSON.stringify(res.body));
  check('...but the img is ignored', (await creatorsStore.getCreatorById(c.id)).img === QUALIFYING.img);

  for (const [field, value] of [['location', 'Venmo @jane for customs'], ['price', 'cashapp $miaxo'], ['tags', 'cashapp,venmo-me'], ['tags', 'teen, schoolgirl'], ['name', 'Lolita']]) {
    res = await me({ [field]: value });
    check(`${field}=${JSON.stringify(value)} refused`, res.statusCode === 400, JSON.stringify(res.body));
  }
  res = await me({ tags: 'cosplay, gym', location: 'Los Angeles, CA', price: '$9.99 / month' });
  check('ordinary values still save', res.statusCode === 200, JSON.stringify(res.body));

  res = await me({ handle: 'janey' });
  check('handle stored with "@"', res.statusCode === 200 && res.body.creator.handle === '@janey');
  await creatorsStore.createCreator({ ...QUALIFYING, handle: '@mia', status: 'active' });
  res = await me({ handle: 'mia' });
  check('"mia" refused when "@mia" exists', res.statusCode === 409);
  res = await me({ dmPriceCents: 500 });
  check('creator can set dmPriceCents', res.statusCode === 200 && res.body.creator.dmPriceCents === 500);
  res = await me({ dmPriceCents: 1.5 });
  check('non-integer dmPriceCents refused', res.statusCode === 400);
}

await reset();

section('Signup: screening, handle normalisation, referral resolution, 23505 mapping');
{
  let res = await call(signup, req({ body: { acceptedTerms: true, email: 'c1@example.com', password: 'secret123', role: 'creator', displayName: 'C One', handle: 'cone', bio: 'cashapp $lexi for customs, 10% cheaper' } }));
  check('flagged signup bio refused', res.statusCode === 400, JSON.stringify(res.body));
  res = await call(signup, req({ body: { acceptedTerms: true, email: 'venmo-luna22', password: 'secret123', role: 'fan' } }));
  check('flagged fan username refused', res.statusCode === 400, JSON.stringify(res.body));
  res = await call(signup, req({ body: { acceptedTerms: true, email: '6175551234', password: 'secret123', role: 'fan' } }));
  check('phone-number username refused', res.statusCode === 400);
  res = await call(signup, req({ body: { acceptedTerms: true, email: 'x'.repeat(41), password: 'secret123', role: 'fan' } }));
  check('over-long username refused', res.statusCode === 400);
  res = await call(signup, req({ body: { email: 'noterms_1', password: 'secret123', role: 'fan' } }));
  check('signup without accepting the Terms is refused (R2 legal-journeys#5)', res.statusCode === 400 && /18 or older/.test(res.body.error), JSON.stringify(res.body));
  res = await call(signup, req({ body: { acceptedTerms: 'yes', email: 'noterms_2', password: 'secret123', role: 'fan' } }));
  check('acceptedTerms must be exactly true', res.statusCode === 400, JSON.stringify(res.body));
  res = await call(signup, req({ body: { acceptedTerms: true, email: 'goodfan_1', password: 'secret123', role: 'fan' } }));
  check('ordinary fan username accepted', res.statusCode === 200, JSON.stringify(res.body));
  const { rows: v } = await query('select count(*)::int as n from violations');
  check('signup refusals logged', v[0].n === 2, `got ${v[0].n}`);

  res = await call(signup, req({ body: { acceptedTerms: true, email: 'c2@example.com', password: 'secret123', role: 'creator', displayName: 'C Two', handle: 'ctwo', bio: '' } }));
  check('creator signup ok', res.statusCode === 200, JSON.stringify(res.body));
  const created = await creatorsStore.getCreatorById(res.body.user.creatorId);
  check('signup handle stored as "@ctwo"', created.handle === '@ctwo');
  res = await call(signup, req({ body: { acceptedTerms: true, email: 'c3@example.com', password: 'secret123', role: 'creator', displayName: 'C Three', handle: '@CTWO', bio: '' } }));
  check('case/@ variant of a taken handle -> 409 handle taken', res.statusCode === 409 && /taken/.test(res.body.error), JSON.stringify(res.body));

  // Referral resolves by the stripped form, exactly one creator.
  await creatorsStore.updateCreatorProfile(created.id, { status: 'active' });
  res = await call(signup, req({ body: { acceptedTerms: true, email: 'reffan', password: 'secret123', role: 'fan', ref: '@@ctwo' } }));
  const reffan = await usersStore.findUserByEmail('reffan');
  check('referral resolved to the creator', res.statusCode === 200 && String(reffan.referredByCreatorId) === String(created.id), JSON.stringify(reffan));

  // A non-handle 23505 is not reported as "handle taken": force a pk collision.
  const { rows: mx } = await query(`select max(id::bigint) as m from creators where id ~ '^[0-9]+$'`);
  await query(`select setval('creators_id_seq', $1)`, [Number(mx[0].m) - 1]);
  res = await call(signup, req({ body: { acceptedTerms: true, email: 'c4@example.com', password: 'secret123', role: 'creator', displayName: 'C Four', handle: 'cfour', bio: '' } }));
  check('pk collision is NOT reported as "handle taken"', res.statusCode === 500 && !/taken/.test(res.body.error), JSON.stringify(res.body));
}

section('Retired /api/creator/submit');
{
  const res = await call(submit, req({ body: {} }));
  check('submit answers 410', res.statusCode === 410);
}

section('displayNameFor hides a flagged legacy username');
{
  check('flagged username not shown', (await usersStore.displayNameFor({ email: 'cashapp_luna' })) === 'Someone');
  check('clean username shown', (await usersStore.displayNameFor({ email: 'luna_22' })) === 'luna_22');
  check('email never shown', (await usersStore.displayNameFor({ email: 'a@b.com' })) === 'Someone');
}

await closePool();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
