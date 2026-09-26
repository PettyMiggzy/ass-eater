// Regression tests for the round-11 R11U1 fixes, run against a real scratch
// Postgres (it truncates tables), never mocks:
//  - dashboard#0: an over-long location is refused WITH `field: 'location'`
//    (creator editor and admin editor), measured as it will be stored, so
//    padding alone is never refused and a 60-character location saves;
//  - public-pages#0: a purchase whose every file is held for review is NOT
//    reported as removed by moderation -- removed:false, withheld > 0 -- while
//    a real moderation deletion still reports 'moderation'.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r11u1.test.mjs

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r11u1';

const { query, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const preservation = await import('./media-preservation.js');
const { createSessionToken } = await import('./session.js');
const { default: deliveryRoute } = await import('../pages/api/marketplace/orders/delivery.js');
const { default: meProfile } = await import('../pages/api/me/profile.js');
const { default: adminProfile } = await import('../pages/api/admin/profile.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);

const origError = console.error;
const origWarn = console.warn;
const quiet = async (fn) => {
  console.error = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { console.error = origError; console.warn = origWarn; }
};

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; },
  };
}
const cookieFor = (u) => `oa_session=${encodeURIComponent(createSessionToken(u.id, 0))}`;
let ipN = 0;
async function call(route, req) {
  ipN++;
  const res = fakeRes();
  const ip = `10.11.0.${ipN}`;
  await quiet(() => route({ socket: { remoteAddress: ip }, ...req, headers: { 'x-forwarded-for': ip, ...(req.headers || {}) } }, res));
  return res;
}

async function reset() {
  await query('truncate creators, users, listings, orders, media_uploads, media_preservations restart identity');
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}

let n = 0;
async function mkCreatorUser(fields = {}) {
  n++;
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r11uc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r11u1.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r11u1.test`, password: 'password123', role: 'fan' });
}

await reset();

section('dashboard#0: location refusal names the field; padding is not counted');
{
  const { creator, user } = await mkCreatorUser();
  const me = (fields) => call(meProfile, { method: 'POST', body: { fields }, headers: { cookie: cookieFor(user) } });
  const tooLong = 'Downtown Los Angeles, California, United States of America - West Side';
  const r1 = await me({ location: tooLong });
  check('an over-long location is refused', r1.statusCode === 400, JSON.stringify(r1.body));
  check('...with field: location', r1.body?.field === 'location', JSON.stringify(r1.body));
  check('...and a message that starts with the field label', /^Location must be 60 characters or fewer/.test(r1.body?.error || ''), r1.body?.error);
  const after = await creators.getCreatorById(creator.id);
  check('...and nothing is stored', !after.location, JSON.stringify(after.location));

  const exact = 'L'.repeat(60);
  const r2 = await me({ location: exact });
  check('a 60-character location saves', r2.statusCode === 200 && r2.body?.creator?.location === exact, JSON.stringify(r2.body));

  const padded = `   Austin,      TX   ${' '.repeat(60)}`;
  const r3 = await me({ location: padded });
  check('padding alone is not refused (measured as stored)', r3.statusCode === 200 && r3.body?.creator?.location === 'Austin, TX', JSON.stringify(r3.body));

  const r4 = await me({ location: 42 });
  check('a non-string location is refused with the field', r4.statusCode === 400 && r4.body?.field === 'location', JSON.stringify(r4.body));

  const admin = (fields) => call(adminProfile, { method: 'POST', body: { creatorId: creator.id, fields }, headers: { 'x-admin-key': process.env.ADMIN_UPLOAD_KEY } });
  const a1 = await admin({ location: tooLong });
  check('admin editor: over-long location refused with field', a1.statusCode === 400 && a1.body?.field === 'location' && /^Location/.test(a1.body?.error || ''), JSON.stringify(a1.body));
  const a2 = await admin({ location: `  Miami,    FL  ${' '.repeat(70)}` });
  check('admin editor: padding alone is not refused', a2.statusCode === 200, JSON.stringify(a2.body));
}

section('public-pages#0: files held for review are not "removed by moderation"');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const buyer = await mkFan();
  let l = await listings.createListing(creator.id, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true });
  const src = media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId: creator.id, listingId: l.id, contentType: 'image/jpeg' }));
  l = await listings.addListingMedia(l.id, { type: 'image', src });
  const { rows } = await query('insert into orders (data) values ($1) returning id', [
    { listingId: l.id, creatorId: l.creatorId, buyerId: buyer.id, kind: 'digital', status: 'fulfilled', createdAt: new Date().toISOString() },
  ]);
  const orderId = rows[0].id;
  const delivery = () => call(deliveryRoute, { method: 'GET', query: { orderId: String(orderId) }, headers: { cookie: cookieFor(buyer) } });

  const before = await delivery();
  check('before: the file is delivered', before.statusCode === 200 && before.body.items.length === 1 && before.body.removed === false, JSON.stringify(before.body));

  await quiet(() => preservation.preserveMedia([src], { reason: 'test hold' }));
  const held = await delivery();
  check('all files held: removed is false', held.statusCode === 200 && held.body.removed === false, JSON.stringify(held.body));
  check('...removedReason is null', held.body.removedReason === null, JSON.stringify(held.body));
  check('...withheld counts the file and nothing is served', held.body.withheld === 1 && held.body.items.length === 0, JSON.stringify(held.body));

  await quiet(() => listings.removeListingsForCreator(creator.id, { moderation: true }));
  const gone = await delivery();
  check('a real moderation deletion still reports moderation',
    gone.body.removed === true && gone.body.removedReason === 'moderation', JSON.stringify(gone.body));
}

await closePool();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
