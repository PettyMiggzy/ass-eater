// Regression tests for the round-8 backend fixes (package R8B), run against a
// real scratch Postgres (it truncates tables). Only @vercel/blob's head() is
// stubbed, so an admin avatar finalize can reach the database step:
//  - accounts#0/#1: the minor-age screen -- every audited string, both ways;
//  - accounts#3: the tag screen caps raw tags before any regex (no ~17s CPU);
//  - accounts#4: the cross-tag payment screen passes ordinary tag sets;
//  - gates-token#0: login brakes are bucketed per IPv6 /64;
//  - media#0 / social#0: a possible-minor NCII resolve takes the file locks
//    before listing rows (no deadlock against a checkout-shaped transaction);
//  - media#1: a listing takedown with preservation reads the listing under
//    lock, so a file finalized meanwhile is preserved, not deleted;
//  - media#2: moved evidence leaves a 'moved_token' row the sweep reaps at the
//    ORIGINAL path only, and a preserved path can never be finalized;
//  - media#3: admin avatar finalize of an expired upload is a 409;
//  - money#0: an admin can close an unfulfillable physical order, which then
//    counts as settled (address erasable, fan deletion unblocked, not shippable);
//  - money#1: a frozen account retrying an already-credited hash is told so;
//  - social#1: the wall author key is keyed and never reaches the client.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r8b.test.mjs

import crypto from 'crypto';
import { mock } from 'node:test';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
delete process.env.NCII_ALERT_WEBHOOK_URL;
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.BRIDGE_SECRET = 'test-bridge-secret-r8b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r8b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
process.env.NEXT_PUBLIC_MARKETPLACE_PAYOUT_ADDRESS = '0x000000000000000000000000000000000000dEaD';
process.env.NEXT_PUBLIC_MARKETPLACE_USDC_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_ID = '4663';
process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_NAME = 'Test Chain';
process.env.NEXT_PUBLIC_MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
process.env.MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

// head() answers "a 1KB JPEG" so verifyUploadedBlob passes; everything else is real.
const realBlob = await import('@vercel/blob');
mock.module('@vercel/blob', {
  namedExports: { ...realBlob, head: async () => ({ contentType: 'image/jpeg', size: 1024 }) },
});

const { query, withTransaction, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const preservation = await import('./media-preservation.js');
const mediaRefs = await import('./media-refs.js');
const locks = await import('./media-locks.js');
const ncii = await import('./ncii-reports-store.js');
const credits = await import('./credits-store.js');
const orders = await import('./orders-store.js');
const deposit = await import('./deposit.js');
const takedown = await import('./content-takedown.js');
const { screenPublicText, detectProhibitedTerms } = await import('./prohibited-terms.js');
const { createSessionToken } = await import('./session.js');
const { default: loginRoute } = await import('../pages/api/auth/login.js');
const { default: wallPostRoute } = await import('../pages/api/wall/post.js');
const { default: notificationsRoute } = await import('../pages/api/notifications/index.js');
const { default: avatarRoute } = await import('../pages/api/admin/avatar.js');
const { default: orderCloseRoute } = await import('../pages/api/admin/order-close.js');
const { default: eraseRoute } = await import('../pages/api/admin/order-address-erase.js');
const { default: buyRoute } = await import('../pages/api/credits/buy.js');
const { default: profileRoute } = await import('../pages/api/me/profile.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);
const orig = { error: console.error, warn: console.warn, info: console.info };
const quiet = async (fn) => {
  console.error = () => {}; console.warn = () => {}; console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
};
function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    send(b) { this.body = b; this.headersSent = true; return this; },
    end(b) { this.headersSent = true; if (b) { try { this.body = JSON.parse(b); } catch { this.body = b; } } },
  };
}
let ipN = 0;
async function call(route, { method = 'POST', body, query: q = {}, admin = false, user = null, ip = null, cookies = {} } = {}) {
  ipN++;
  const res = fakeRes();
  const addr = ip || `10.88.${Math.floor(ipN / 250)}.${ipN % 250}`;
  const headers = {};
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  const cookieJar = { ...cookies };
  if (user) cookieJar.oa_session = createSessionToken(user.id, user.sessionVersion || 0);
  if (Object.keys(cookieJar).length) headers.cookie = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  const req = { method, body, query: q, headers, cookies: cookieJar, socket: { remoteAddress: addr } };
  await quiet(() => route(req, res));
  return res;
}
async function reset() {
  await query(`truncate creators, users, listings, orders, credit_balances, credit_ledger, payout_requests, checkout_idempotency,
    used_payment_tx, ncii_reports, media_uploads, media_reaped, performer_records, media_preservations, media_holds, moderation_actions,
    server_standing_pushes, conversations, reports, violations, wall_posts, favorites, notifications restart identity`);
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
let n = 0;
async function mkCreatorUser(fields = {}) {
  n++;
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r8bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r8b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan(email = null) {
  n++;
  return users.createUser({ email: email || `f${n}@r8b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
const strip = (src) => src.replace('/api/media/', '');
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
section('accounts#0/#1: minor ages are refused again, both ways');
{
  // Every string from both round-8 findings, plus the long-form and
  // descriptor cases the brief names.
  const refused = [
    'a 16yo house slut', 'our 16yo account babe', 'my 16yo shop girl', 'the 16yo channel whore',
    'cum on a 16yo shop girl', 'a 16 y/o house wife', 'Fucking a 16yo house slut',
    '16 year old slut', 'hot 16 year old slut', 'sexy 15 year old babe', 'horny 17 year old whore',
    'fucking a 16 year old', 'blonde 16yo', 'amateur 16yo', 'slim 16yo', 'fresh 16yo', 'watch this 15yo',
    '16 year old', '#16 years old', 'slut 16yo', 'fucking 16yo', 'a sixteen year old', 'my 16yo housewife',
    // Round-7 refusals that must stay refused.
    'my 15yo girlfriend', 'petite 16yo', 'a 16yo', 'the 17yo next door', 'cute 12yo pup', 'my 16yo pet',
    'a 16yo kitty', 'my 16yo pussy cat', 'my 15yo slut house', 'our 14yo babe account', 'my 15yo home alone',
    '16yo', '17 y/o', '#17yo', '17-year-old girl', '15 year old schoolgirl', 'seventeen year old girl',
  ];
  for (const t of refused) check(`refused: ${t}`, screenPublicText(t)?.kind === 'prohibited', JSON.stringify(screenPublicText(t)));
  const allowed = [
    'me and my 12yo dog', 'my 14 yo cat Luna', 'our 11yo pup', 'proud owner of a 13 yo husky', 'My 15 y/o car still runs',
    'my 10yo laptop', 'my 12yo golden retriever', 'my 12yo german shepherd', 'my 12 year old dog',
    'Toyota 12yo', 'Rolling 10yo', 'Top 10 yo mama jokes', 'My Kia is 11 yo lol', 'aged 12 years old single malt',
    'My blog turned 15 years old today', 'Brand turned 12 yrs old', 'sipping a Macallan 12yo and watching your new set',
    'a 12 year old whisky', 'drinking a 12yo cognac', 'this 15yo brand turned into a company', 'my 12yo business',
    'our 12yo shop', 'a 12yo channel', 'my 12yo account, hope you enjoy', 'our 10 year old tradition',
    '15 years old today', '15 years old page anniversary', 'this account is 15 years old', 'my dog is 12 years old',
    "I'm fifteen minutes away", 'I have sixteen new photos', '18yo', '19 years old', '118yo', 'No one under 18',
  ];
  for (const t of allowed) check(`allowed: ${t}`, detectProhibitedTerms(t).flagged === false, JSON.stringify(detectProhibitedTerms(t)));
  // Review fix-up: the long form after a determiner or a descriptive word
  // counts only at a clause end or before a person noun, so ordinary prose
  // about the age of a thing passes...
  for (const t of ['a 10 year old song', 'the 16 year old movie', 'a 12 year old recipe', 'this 15 year old video game',
    'that 12 year old meme', 'the 15 year old version of me', 'Our 10 year old marriage', 'my 16 year old playlist',
    'I miss the 16 year old me', 'The 17 year old record still stands', 'new 12 year old record',
    'Dirty 16 year old sneakers', 'bored 10 year old me', 'Fucking 12 year old laptop died']) {
    check(`allowed (long form): ${t}`, detectProhibitedTerms(t).flagged === false, JSON.stringify(detectProhibitedTerms(t)));
  }
  // ...while these stay refused.
  for (const t of ['horny seventeen year old', 'fucking 16 year old', 'cum on a 16 year old', 'fucking a 16 year old in the ass',
    'a 16 year old house wife', 'hot 16 year old blonde slut', 'slut 16 year old', 'a sixteen year old.', 'new 16 year old, horny']) {
    check(`refused (long form): ${t}`, screenPublicText(t)?.kind === 'prohibited', JSON.stringify(screenPublicText(t)));
  }
}

section('accounts#3: the tag screen caps raw tags before screening');
{
  const huge = (' '.repeat(19000) + 'x').repeat(50);
  let t = Date.now();
  listings.findCircumventionInTags([huge, 'x']);
  check('a ~1MB tag is screened in well under a second', Date.now() - t < 1000, `${Date.now() - t}ms`);
  t = Date.now();
  listings.findCircumventionInTags(huge);
  check('...and as a comma string', Date.now() - t < 1000, `${Date.now() - t}ms`);
  check('a tag longer than 100 characters is screened only on its first 100', listings.findCircumventionInTags(['x'.repeat(200) + ' teen']) === null);
  check('...a prohibited term inside the first 100 still is', listings.findCircumventionInTags(['hot teen ' + 'x'.repeat(200)])?.kind === 'prohibited');
}

section('accounts#4: ordinary tag sets are not payment circumvention');
{
  for (const tags of [['findom', 'pay pig', 'instagram'], ['pay per view', 'instagram'], ['snap', 'y2k_aesthetic'], ['cosplay', 'ig', 'x_rated'],
    ['kik', '18_plus'], ['discord', 'kitten_play'], ['snap', '5.2ft'], ['snap', 'cheaper'], ['snap', 'y2kaesthetic'], ['tg', 'y2k'], ['insta', '4k']]) {
    const hit = listings.findCircumventionInTags(tags);
    check(`passes: ${JSON.stringify(tags)}`, hit === null, JSON.stringify(hit));
  }
  for (const [tags, kind] of [[['venmo', '@janedoe'], 'payment'], [['text me', '555', '123', '4567'], 'payment'], [['text me', '555 123 4567'], 'payment'],
    [['snapchat', '@jane99'], 'payment'], [['telegram', 'janedoe99'], 'payment'], [['insta', 'janedoe_99'], 'payment'], [['cash', 'app'], 'payment'],
    [['school', 'girl'], 'prohibited'], [['barely', 'legal'], 'prohibited']]) {
    check(`still flagged (${kind}): ${JSON.stringify(tags)}`, listings.findCircumventionInTags(tags)?.kind === kind, JSON.stringify(listings.findCircumventionInTags(tags)));
  }
  // A single tag with a payment word next to an app name is still one hit.
  check('"pay me on snap" in one tag is still refused', listings.findCircumventionInTags(['pay me on snap'])?.kind === 'payment');
  // Review fix-up: a cue that ENDS a tag, directly before the app's tag, is
  // an instruction across the chip boundary.
  for (const tags of [['pay me', 'snapchat'], ['pay me on', 'snapchat'], ['pay via', 'telegram'], ['payment', 'whatsapp'], ['pay on', 'kik'],
    ['findom', 'pay', 'instagram']]) {
    check(`flagged (cue abuts app): ${JSON.stringify(tags)}`, listings.findCircumventionInTags(tags)?.kind === 'payment', JSON.stringify(listings.findCircumventionInTags(tags)));
  }
  for (const tags of [['pay pig', 'instagram', 'findom'], ['instagram', 'pay per view'], ['snapchat', 'pay pig']]) {
    check(`passes (cue inside a category tag): ${JSON.stringify(tags)}`, listings.findCircumventionInTags(tags) === null, JSON.stringify(listings.findCircumventionInTags(tags)));
  }
  // Review fix-up: punctuation or space padding past the 100-character raw cap
  // does not hide a tag from the cross-tag steps.
  const pad = '!'.repeat(120);
  for (const [tags, kind] of [[[pad + 'school', 'girl'], 'prohibited'], [[pad + 'cash', 'app'], 'payment'],
    [[pad + 'telegram', 'janedoe99'], 'payment'], [['snapchat', pad + '@jane99'], 'payment'], [[' '.repeat(150) + 'barely', 'legal'], 'prohibited'],
    [['cash' + ' '.repeat(150) + 'app'], 'payment']]) {
    check(`padded still flagged (${kind}): ${JSON.stringify(tags).slice(0, 40)}...`, listings.findCircumventionInTags(tags)?.kind === kind, JSON.stringify(listings.findCircumventionInTags(tags)));
  }
}

section('gates-token#0: login brakes are per IPv6 /64');
{
  await reset();
  const statuses = [];
  for (let i = 1; i <= 12; i++) {
    statuses.push((await call(loginRoute, { body: { email: 'nobody@r8b.test', password: `guess${i}` }, ip: `2001:db8:8:9::${i.toString(16)}` })).statusCode);
  }
  check('the first 10 guesses from one /64 are answered', statuses.slice(0, 10).every((s) => s === 401), JSON.stringify(statuses));
  check('...and the 11th from a NEW address in the same /64 is braked', statuses[10] === 429 && statuses[11] === 429, JSON.stringify(statuses));
  const other = await call(loginRoute, { body: { email: 'nobody@r8b.test', password: 'x' }, ip: '2001:db8:8:a::1' });
  check('a different /64 is not affected', other.statusCode === 401, String(other.statusCode));
}

section('social#1: the wall author key is keyed per wall and never sent to the client');
{
  await reset();
  const c = await mkCreatorUser();
  const alice = await mkFan('alice@r8b.test');
  await call(wallPostRoute, { user: alice, body: { creatorId: String(c.creator.id), text: 'hi from alice' } });
  await call(wallPostRoute, { user: alice, body: { creatorId: String(c.creator.id), text: 'alice again' } });
  const { rows } = await query(`select meta from notifications where user_id = $1 and type = 'wall_comment'`, [String(c.user.id)]);
  check('still one coalesced notification per author', rows.length === 1, JSON.stringify(rows));
  const unkeyed = crypto.createHash('sha256').update(`wall-author:${alice.id}`).digest('hex').slice(0, 24);
  check('the stored key is not the recomputable unkeyed digest', rows.length === 1 && !String(rows[0].meta.wallAuthorKey).includes(unkeyed), JSON.stringify(rows[0]?.meta));
  const res = await call(notificationsRoute, { method: 'GET', user: c.user });
  const metas = (res.body?.notifications || []).map((x) => x.meta);
  check('GET /api/notifications carries no wallAuthorKey', res.statusCode === 200 && metas.length === 1 && metas.every((m) => m && !('wallAuthorKey' in m)), JSON.stringify(res.body));
  check('...but keeps the rest of meta', metas[0]?.creatorId === String(c.creator.id));
}

section('money#1: a frozen account retrying an already-credited hash');
{
  await reset();
  const fan = await mkFan();
  const tx = '0x' + 'a'.repeat(64);
  await deposit.recordDepositCredit({ userId: fan.id, txHash: tx, grossCents: 5000, feeCents: 100, netCents: 4900 });
  await users.setUserModeration(fan.id, { status: 'suspended', until: new Date(Date.now() + 864e5).toISOString(), reason: 'x' });
  const fresh = await users.findUserById(fan.id);
  const again = await call(buyRoute, { user: fresh, body: { txHash: tx.toUpperCase().replace('0X', '0x') } });
  check('is told it was already credited (200)', again.statusCode === 200 && again.body.alreadyCredited === true && again.body.frozen === true && again.body.creditedCents === 4900, JSON.stringify(again.body));
  const other = await call(buyRoute, { user: fresh, body: { txHash: '0x' + 'b'.repeat(64) } });
  check('an unknown hash is still refused 403', other.statusCode === 403 && other.body.code === 'ACCOUNT_FROZEN', JSON.stringify(other.body));
  check('...without claiming it was "never used"', !/has not been used/.test(other.body.error || ''), other.body.error);
}

section('money#0: closing an unfulfillable physical order');
{
  await reset();
  const c = await mkCreatorUser();
  const fan = await mkFan();
  const mk = (fields) => query('insert into orders (data) values ($1) returning id', [{
    listingId: '1', creatorId: String(c.creator.id), buyerId: String(fan.id), kind: 'physical', status: 'pending_shipment',
    shippingAddress: 'enc:placeholder', createdAt: new Date().toISOString(), ...fields,
  }]).then((r) => String(r.rows[0].id));
  const pending = await mk({});
  const digital = await mk({ kind: 'digital', status: 'fulfilled', shippingAddress: null });
  check('fan deletion is blocked while it is pending', (await users.getSelfDeleteImpact(fan.id)).unshippedOrders === 1);
  check('the route needs the admin key', (await call(orderCloseRoute, { body: { orderId: pending, reason: 'seller banned' } })).statusCode === 401);
  check('a reason is required', (await call(orderCloseRoute, { admin: true, body: { orderId: pending } })).statusCode === 400);
  check('a digital order is not closable', (await call(orderCloseRoute, { admin: true, body: { orderId: digital, reason: 'x' } })).statusCode === 409);
  const closed = await call(orderCloseRoute, { admin: true, body: { orderId: pending, reason: 'seller banned before shipping' } });
  check('a pending physical order closes', closed.statusCode === 200 && closed.body.status === 'closed_unfulfilled' && closed.body.erased === false, JSON.stringify(closed.body));
  const row = (await query('select data from orders where id = $1', [pending])).rows[0].data;
  check('...stamped with when and why', row.status === 'closed_unfulfilled' && !!row.closedAt && row.closeReason === 'seller banned before shipping');
  check('...and the buyer is told', (await query(`select 1 from notifications where user_id = $1 and type = 'order_closed'`, [String(fan.id)])).rows.length === 1);
  check('closing again is a 409', (await call(orderCloseRoute, { admin: true, body: { orderId: pending, reason: 'x' } })).statusCode === 409);
  check('fan deletion is no longer blocked by it', (await users.getSelfDeleteImpact(fan.id)).unshippedOrders === 0);
  const erase = await call(eraseRoute, { admin: true, body: { orderId: pending } });
  check('its address can now be erased', erase.statusCode === 200 && erase.body.erased === true, JSON.stringify(erase.body));
  const ship = await errOf(() => orders.markOrderShipped(pending, c.creator.id, { carrier: 'x', trackingNumber: 'y' }));
  check('a closed order can never be marked shipped', ship?.code === orders.ORDER_CLOSED, ship && ship.message);
  const p2 = await mk({});
  const withErase = await call(orderCloseRoute, { admin: true, body: { orderId: p2, reason: 'seller deleted', eraseAddress: true } });
  check('eraseAddress erases in the same call', withErase.statusCode === 200 && withErase.body.erased === true, JSON.stringify(withErase.body));
  check('an unknown order is 404', (await call(orderCloseRoute, { admin: true, body: { orderId: '999999', reason: 'x' } })).statusCode === 404);
}

section('media#0 / social#0: a possible-minor resolve takes file locks before listing rows');
{
  await reset();
  const c = await mkCreatorUser();
  const l = await mkListing(c.creator.id);
  const p = strip(l.media[0].src);
  const report = await ncii.addNciiReport({ category: 'minor', contentLocation: `/creator/${c.creator.id}`, description: 'x', goodFaithStatement: true });
  // A checkout-shaped transaction: the file lock, then (a moment later) the listing row.
  let locked;
  const lockedP = new Promise((r) => { locked = r; });
  let release;
  const gate = new Promise((r) => { release = r; });
  const checkoutShape = withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [p]);
    locked();
    await gate;
    await client.query('select id from listings where id = $1 for update', [String(l.id)]);
    return 'ok';
  });
  await lockedP;
  const resolving = quiet(() => ncii.resolveNciiReport(String(report.id), 'removed', { creatorId: String(c.creator.id) }));
  await sleep(300);
  release();
  const [a, b] = await Promise.allSettled([checkoutShape, resolving]);
  check('the checkout-shaped transaction completed', a.status === 'fulfilled', a.reason && a.reason.message);
  check('the resolve completed (no deadlock)', b.status === 'fulfilled' && b.value.outrightBan === true, b.reason ? `${b.reason.code} ${b.reason.message}` : JSON.stringify(b.value));
  check('...and preserved the listing file', (await query('select 1 from media_preservations where pathname = $1', [p])).rows.length === 1);
  const after = (await query('select data from listings where id = $1', [String(l.id)])).rows[0].data;
  check('...and took the listing down', after.status === 'removed' && after.moderationRemoved === true);
  check('the preserved file is not queued for deletion', !(await query(`select 1 from media_uploads where pathname = $1 and reason <> 'moved_token'`, [p])).rows.length);

  // The shared helper itself: files, then rows, then files first seen on the rows.
  const l2 = await mkListing(c.creator.id);
  const held = await withTransaction(async (client) => (await locks.lockListingsWithFiles(client, { ids: [String(l2.id)] })).held);
  check('lockListingsWithFiles locks the listing\'s files', held.has(strip(l2.media[0].src)));
}

section('media#1: a preserving listing takedown keeps a file finalized meanwhile');
{
  await reset();
  const c = await mkCreatorUser();
  const l = await mkListing(c.creator.id);
  const first = l.media[0].src;
  const late = listingFile(c.creator.id, l.id);
  let locked;
  const lockedP = new Promise((r) => { locked = r; });
  let release;
  const gate = new Promise((r) => { release = r; });
  // A finalize in flight: the new file's lock and the listing row, not yet committed.
  const finalize = withTransaction(async (client) => {
    await mediaRefs.lockMediaForFinalize(client, late);
    await client.query(
      `update listings set data = jsonb_set(data, '{media}', data->'media' || $2::jsonb) where id = $1`,
      [String(l.id), JSON.stringify([{ type: 'image', src: late }])],
    );
    locked();
    await gate;
  });
  await lockedP;
  const doing = quiet(() => takedown.takeDownContent({ type: 'listing', listingId: String(l.id) }, { preserve: true }));
  await sleep(200);
  release();
  await finalize;
  const out = await doing;
  check('the takedown removed the listing', out.result === 'removed', JSON.stringify(out));
  const kept = (await query('select pathname from media_preservations order by pathname')).rows.map((r) => r.pathname);
  check('...preserving the original file', kept.includes(strip(first)), JSON.stringify(kept));
  check('...AND the file finalized while it waited', kept.includes(strip(late)), JSON.stringify(kept));
  check('...and neither is queued for deletion', !(await query(`select 1 from media_uploads where pathname = any($1::text[])`, [[strip(first), strip(late)]])).rows.length);

  // Without preservation it still takes the listing down and queues its files.
  const l2 = await mkListing(c.creator.id);
  const out2 = await quiet(() => takedown.takeDownContent({ type: 'listing', listingId: String(l2.id) }, {}));
  check('a plain takedown still removes', out2.result === 'removed' && out2.preserved === 0);
  check('...and queues its file for deletion', (await query(`select 1 from media_uploads where pathname = $1`, [strip(l2.media[0].src)])).rows.length === 1);

  // preserved-media's creator branch reads under lock too.
  const report = await ncii.addNciiReport({ category: 'minor', contentLocation: 'x', description: 'x', goodFaithStatement: true });
  const l3 = await mkListing(c.creator.id);
  const r3 = await quiet(() => ncii.preserveCreatorMediaForReport(String(report.id), String(c.creator.id)));
  check('preserveCreatorMediaForReport preserves the creator\'s listing files', r3.preserved.includes(strip(l3.media[0].src)), JSON.stringify(r3));
  const missing = await errOf(() => ncii.preserveCreatorMediaForReport(String(report.id), '999999'));
  check('...and refuses an unknown creator', missing?.code === ncii.NCII_CREATOR_NOT_FOUND);
}

section('media#2: moved evidence leaves its original path for the sweep; a preserved path is never finalized');
{
  await reset();
  const c = await mkCreatorUser();
  const l = await mkListing(c.creator.id);
  const src = l.media[0].src;
  const p = strip(src);
  await query(`insert into media_uploads (pathname, reason) values ($1, 'token')`, [p]);
  await preservation.preserveMedia([src], { reportId: 'ncii:1', reason: 'test' });
  check('preserving drops the token row', !(await query('select 1 from media_uploads where pathname = $1', [p])).rows.length);
  const moved = await preservation.movePreservedToEvidence({ renameFile: async () => {}, headFile: async () => ({}) });
  check('the file moves to evidence/', moved.moved === 1, JSON.stringify(moved));
  const { rows: mt } = await query('select reason from media_uploads where pathname = $1', [p]);
  check('...and its original path is recorded as moved_token', mt.length === 1 && mt[0].reason === 'moved_token', JSON.stringify(mt));
  const fin = await errOf(() => withTransaction((client) => mediaRefs.lockMediaForFinalize(client, src)));
  check('a preserved pathname can never be finalized', fin?.code === mediaRefs.MEDIA_UPLOAD_EXPIRED, fin && fin.message);
  const deleted = [];
  const s1 = await media.sweepOrphanedMedia({ deleteFile: async (x) => { deleted.push(x); } });
  check('not swept while a token could still be live', s1.checked === 0 && !deleted.length, JSON.stringify(s1));
  await query(`update media_uploads set created_at = now() - interval '2 hours' where pathname = $1`, [p]);
  await media.sweepOrphanedMedia({ deleteFile: async (x) => { deleted.push(x); } });
  const evidence = (await query('select evidence_pathname from media_preservations where pathname = $1', [p])).rows[0].evidence_pathname;
  check('the sweep deletes the ORIGINAL path, though the listing still references it', deleted.includes(p), JSON.stringify(deleted));
  check('...never the evidence copy', !deleted.includes(evidence) && !!evidence);
  check('...and drops the row', !(await query('select 1 from media_uploads where pathname = $1', [p])).rows.length);

  // A preserved file that has NOT moved yet is never touched, whatever its row says.
  const l2 = await mkListing(c.creator.id);
  const p2 = strip(l2.media[0].src);
  await preservation.preserveMedia([l2.media[0].src], { reportId: 'ncii:2', reason: 'test' });
  await query(`insert into media_uploads (pathname, reason, created_at) values ($1, 'moved_token', now() - interval '2 hours')`, [p2]);
  const deleted2 = [];
  await media.sweepOrphanedMedia({ deleteFile: async (x) => { deleted2.push(x); } });
  check('an unmoved preserved file is never swept', !deleted2.includes(p2), JSON.stringify(deleted2));

  // Review fix-up: a moved_token delete that fails once stays claimable.
  const l3 = await mkListing(c.creator.id);
  const p3 = strip(l3.media[0].src);
  await preservation.preserveMedia([l3.media[0].src], { reportId: 'ncii:3', reason: 'test' });
  await preservation.movePreservedToEvidence({ renameFile: async () => {}, headFile: async () => ({}) });
  await query(`update media_uploads set created_at = now() - interval '2 hours' where pathname = $1`, [p3]);
  const s3 = await quiet(() => media.sweepOrphanedMedia({ deleteFile: async () => { throw new Error('transient'); } }));
  const { rows: after } = await query('select reason from media_uploads where pathname = $1', [p3]);
  check('a failed delete of a vacated path is re-queued as moved_token', s3.failed === 1 && after.length === 1 && after[0].reason === 'moved_token', `${JSON.stringify(s3)} ${JSON.stringify(after)}`);
  await query(`update media_uploads set created_at = now() - interval '2 hours' where pathname = $1`, [p3]);
  const deleted3 = [];
  await media.sweepOrphanedMedia({ deleteFile: async (x) => { deleted3.push(x); } });
  check('...and the next sweep deletes the original path', deleted3.includes(p3), JSON.stringify(deleted3));
}

section('media#3: admin avatar finalize of an expired upload is a 409');
{
  await reset();
  const c = await mkCreatorUser();
  const pathname = media.newMediaPathname({ purpose: 'avatar', creatorId: String(c.creator.id), contentType: 'image/jpeg' });
  await query('insert into media_reaped (pathname) values ($1)', [pathname]);
  const res = await call(avatarRoute, { admin: true, body: { creatorId: String(c.creator.id), pathname, othersAppear: false } });
  check('409 with the upload-again message', res.statusCode === 409 && res.body.error === mediaRefs.MEDIA_UPLOAD_EXPIRED_MESSAGE, `${res.statusCode} ${JSON.stringify(res.body)}`);
  const ok = media.newMediaPathname({ purpose: 'avatar', creatorId: String(c.creator.id), contentType: 'image/jpeg' });
  const good = await call(avatarRoute, { admin: true, body: { creatorId: String(c.creator.id), pathname: ok, othersAppear: false } });
  check('a live upload still finalizes', good.statusCode === 200, `${good.statusCode} ${JSON.stringify(good.body)}`);
}

section('accounts#3: /api/me/profile is rate-limited per creator');
{
  await reset();
  const c = await mkCreatorUser();
  const statuses = [];
  for (let i = 0; i < 62; i++) statuses.push((await call(profileRoute, { user: c.user, body: { fields: { bio: `bio ${i}` } } })).statusCode);
  check('60 saves are accepted', statuses.slice(0, 60).every((s) => s === 200), JSON.stringify(statuses.slice(0, 60).filter((s) => s !== 200)));
  check('...the 61st is a 429', statuses[60] === 429, String(statuses[60]));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
