// Regression tests for the round-11 backend fixes (package R11B), run against a
// real scratch Postgres (it truncates tables). Only @vercel/blob's head() is
// stubbed. Every fix is tested in both directions (the bug, and its nearest
// harmless neighbours):
//  - gates-token#0-3: the settled login brake design (per-/64 10, per-/48 100
//    refusing every caller once saturated, per-account 10 for a caller with
//    3+ own failures), sorted locking in release/clear, no account rows for
//    a refused host;
//  - media#0: a repeated listing takedown is 'already_gone';
//  - money#0/#1: checkout rate limit; in-transaction PRICE_CHANGED carries items;
//  - social#0: the possible-minor resolve merges preservedMedia;
//  - social#1, accounts#4: NUL / lone surrogates are a 400 everywhere;
//  - accounts#0-3,#5: the audited filter strings, both directions;
//  - legal-journeys#0: deleting an account anonymises the notifications it caused.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r11b.test.mjs


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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r11b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r11b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
process.env.NEXT_PUBLIC_MARKETPLACE_PAYOUT_ADDRESS = '0x000000000000000000000000000000000000dEaD';
process.env.NEXT_PUBLIC_MARKETPLACE_USDC_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_ID = '4663';
process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_NAME = 'Test Chain';
process.env.NEXT_PUBLIC_MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
process.env.MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const realBlob = await import('@vercel/blob');
mock.module('@vercel/blob', {
  namedExports: { ...realBlob, head: async () => ({ contentType: 'image/jpeg', size: 1024 }) },
});

const { query, withTransaction, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const locks = await import('./media-locks.js');
const credits = await import('./credits-store.js');
const orders = await import('./orders-store.js');
const deposit = await import('./deposit.js');
const wall = await import('./wall-store.js');
const messages = await import('./messages-store.js');
const { screenPublicText } = await import('./prohibited-terms.js');
const { detectPaymentCircumvention } = await import('./payment-circumvention-filter.js');
const { sanitizeTags } = await import('./creator-status.js');
const rateLimit = await import('./rate-limit.js');
const { createSessionToken } = await import('./session.js');
const { default: loginRoute } = await import('../pages/api/auth/login.js');
const { default: wallBlockRoute } = await import('../pages/api/wall/block.js');
const { default: wallListRoute } = await import('../pages/api/wall/list.js');
const { default: wallPostRoute } = await import('../pages/api/wall/post.js');
const { default: conversationsRoute } = await import('../pages/api/messages/conversations.js');
const { default: dmBlockRoute } = await import('../pages/api/messages/block.js');
const { default: sendRoute } = await import('../pages/api/messages/send.js');
const { default: withRoute } = await import('../pages/api/messages/with/[userId].js');
const { default: checkoutRoute } = await import('../pages/api/marketplace/orders/create.js');
const { default: profileRoute } = await import('../pages/api/me/profile.js');
const { default: waitlistRoute } = await import('../pages/api/waitlist.js');
const loginGuard = await import('./login-guard.js');
const ncii = await import('./ncii-reports-store.js');
const { takeDownContent } = await import('./content-takedown.js');
const { isWellFormedText, findMalformedText } = await import('./unicode-text.js');
const { refuseMalformedText } = await import('./field-validation.js');
const { validateReportInput } = await import('./reports-store.js');
const { foldLookalikeLetters } = await import('./payment-circumvention-filter.js');
const { default: contentTakedownRoute } = await import('../pages/api/admin/content-takedown.js');
const { default: nciiResolveRoute } = await import('../pages/api/admin/ncii-reports-resolve.js');
const { default: galleryDeleteRoute } = await import('../pages/api/admin/gallery-delete.js');
const { default: messageReportRoute } = await import('../pages/api/messages/report.js');
const { default: wallReportRoute } = await import('../pages/api/wall/report.js');
const { default: signupRoute } = await import('../pages/api/auth/signup.js');

const { sliceText } = await import('./unicode-text.js');
const { sanitizeLocation, sanitizeSocials } = await import('./creator-status.js');

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
async function call(route, { method = 'POST', body, query: q = {}, admin = false, adminKey = null, user = null, ip = null, cookies = {} } = {}) {
  ipN++;
  const res = fakeRes();
  const addr = ip || `10.99.${Math.floor(ipN / 250)}.${ipN % 250}`;
  const headers = {};
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  if (adminKey) headers['x-admin-key'] = adminKey;
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
    server_standing_pushes, conversations, reports, violations, wall_posts, favorites, notifications, login_attempts, wall_blocks restart identity`);
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
let n = 0;
async function mkCreatorUser(fields = {}) {
  n++;
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r11bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r11b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan(email = null) {
  n++;
  return users.createUser({ email: email || `f${n}@r11b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const galleryFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'gallery', creatorId, contentType: 'image/jpeg' }));
const getListing = async (id) => (await query('select data from listings where id = $1', [String(id)])).rows[0].data;
const loginRowCount = async () => Number((await query('select count(*)::int as n from login_attempts')).rows[0].n);
const login = (email, password, ip) => call(loginRoute, { body: { email, password }, ip });

// ---------------------------------------------------------------------------
section('gates-token#0: a saturated /48 refuses every caller in it, so /64 rotation cannot spray');
{
  await reset();
  // The spray itself: fresh /64s of one /48, each guessing a different account.
  let compares = 0;
  let refusedFresh = 0;
  for (let i = 1; i <= 110; i++) {
    const r = await login(`spray${i}@r11b.test`, 'Password1', `2001:db8:5a:${i.toString(16)}::1`);
    if (r.statusCode === 401) compares++;
    if (r.statusCode === 429) refusedFresh++;
  }
  check('at most 100 compares per /48 per window, however many /64s are used', compares === 100, String(compares));
  check('...every fresh /64 past that is refused before the compare', refusedFresh === 10, String(refusedFresh));
  const other48 = await login('spray1@r11b.test', 'Password1', '2001:db8:5b:1::1');
  check('a different /48 is unaffected', other48.statusCode === 401, String(other48.statusCode));
  // Neighbour: a /48 below its budget lets a clean /64 log in, and successes
  // never count against the /48 (the carrier case below saturation).
  const owner = await mkFan('carrier@r11b.test');
  for (let i = 0; i < 99; i++) await loginGuard.consumeLoginAttempts([{ key: 'login:net:2001:db8:5c::/48', limit: 100 }]);
  const good = await login(owner.email, 'password123', '2001:db8:5c:1::1');
  check('a /48 one short of its budget still lets the right password in', good.statusCode === 200, `${good.statusCode} ${JSON.stringify(good.body)}`);
  const c = await loginGuard.readLoginCounters(['login:net:2001:db8:5c::/48']);
  check('...and the success gave its /48 slot back', c['login:net:2001:db8:5c::/48'] === 99, JSON.stringify(c));
  // IPv4 has no /48: only the per-address budget applies.
  const v4 = await login(owner.email, 'password123', '10.55.0.1');
  check('IPv4 logins are unaffected by the /48 rule', v4.statusCode === 200, String(v4.statusCode));
}

section('gates-token#1: the owner\'s typo is not a lockout behind an attacker\'s saturation');
{
  await reset();
  const owner = await mkFan('victim@r11b.test');
  // Anyone keeps the account counter saturated: ten failures from ten hosts.
  for (let i = 1; i <= 10; i++) await login(owner.email, `x${i}`, `10.66.0.${i}`);
  const typo = await login(owner.email, 'pasword123', '10.66.1.1');
  check('the owner\'s typo gets its answer', typo.statusCode === 401, String(typo.statusCode));
  const right = await login(owner.email, 'password123', '10.66.1.1');
  check('...and the right password straight after it logs in', right.statusCode === 200, `${right.statusCode} ${JSON.stringify(right.body)}`);
  // Two typos are still fine.
  for (let i = 1; i <= 10; i++) await login(owner.email, `y${i}`, `10.66.2.${i}`);
  await login(owner.email, 'typo1', '10.66.3.1');
  await login(owner.email, 'typo2', '10.66.3.1');
  const right2 = await login(owner.email, 'password123', '10.66.3.1');
  check('two typos, then the right password: logged in', right2.statusCode === 200, String(right2.statusCode));
  // The allowance bounds a rotating attacker: three guesses per host, then refused.
  for (let i = 1; i <= 10; i++) await login(owner.email, `z${i}`, `10.66.4.${i}`);
  const st = [];
  for (let i = 0; i < 5; i++) st.push((await login(owner.email, `g${i}`, '10.66.5.1')).statusCode);
  check('a fresh host gets three guesses at a saturated account, then 429', JSON.stringify(st) === JSON.stringify([401, 401, 401, 429, 429]), JSON.stringify(st));
  // The documented trade-off: three typos behind a saturated account wait out the window.
  const locked = await login(owner.email, 'password123', '10.66.5.1');
  check('...including with the right password (documented trade-off, bounded by the window)', locked.statusCode === 429, String(locked.statusCode));
  await query(`update login_attempts set window_start = now() - interval '16 minutes'`);
  const later = await login(owner.email, 'password123', '10.66.5.1');
  check('...and once the window has passed, the right password works', later.statusCode === 200, String(later.statusCode));
  // An unsaturated account never refuses a dirty caller.
  const fresh = await mkFan('fresh@r11b.test');
  for (let i = 0; i < 4; i++) await login(fresh.email, `w${i}`, '10.66.6.1');
  const ok = await login(fresh.email, 'password123', '10.66.6.1');
  check('an unsaturated account lets even a four-typo host log in', ok.statusCode === 200, String(ok.statusCode));
}

section('gates-token#2: release and clear lock rows in sorted order (no deadlock under concurrency)');
{
  await reset();
  const keys = ['cc:a', 'cc:b', 'cc:c', 'cc:d'].map((key) => ({ key, limit: 1_000_000 }));
  await loginGuard.consumeLoginAttempts(keys);
  // Well above zero, so the never-below-zero floor cannot absorb a release
  // that happens to run ahead of its consume.
  await query('update login_attempts set attempts = 100');
  const errs = [];
  const ops = [];
  for (let i = 0; i < 60; i++) {
    const order = i % 2 ? ['cc:d', 'cc:c', 'cc:b', 'cc:a'] : ['cc:a', 'cc:b', 'cc:c', 'cc:d'];
    ops.push(loginGuard.consumeLoginAttempts(keys).catch((e) => errs.push(e)));
    ops.push(loginGuard.releaseLoginAttempts(order).catch((e) => errs.push(e)));
  }
  await Promise.all(ops);
  check('60 concurrent consume/release pairs finish without an error', errs.length === 0, errs.map((e) => e.code || e.message).join(','));
  const counts = await loginGuard.readLoginCounters(['cc:a', 'cc:b', 'cc:c', 'cc:d']);
  check('...and every counter is back where it started', Object.values(counts).every((v) => v === 100), JSON.stringify(counts));
  await loginGuard.releaseLoginAttempts(['cc:a', 'cc:a']);
  check('a duplicated key in one release takes back exactly one', (await loginGuard.readLoginCounters(['cc:a']))['cc:a'] === 99);
  await Promise.all([loginGuard.clearLoginCounters(['cc:b', 'cc:c']), loginGuard.clearLoginCounters(['cc:c', 'cc:b']), loginGuard.consumeLoginAttempts(keys)]);
  const { rows } = await query('select count(*)::int as n from login_attempts');
  check('clear still deletes rows (concurrent clears in both orders)', rows[0].n >= 2 && rows[0].n <= 4, String(rows[0].n));
  await loginGuard.consumeLoginAttempts([{ key: 'cc:old', limit: 5 }]);
  await query(`update login_attempts set window_start = now() - interval '16 minutes'`);
  await loginGuard.releaseLoginAttempts(['cc:old']);
  const old = (await query('select attempts from login_attempts where key = $1', [crypto.createHash('sha256').update('cc:old').digest('hex')])).rows[0];
  check('release still ignores a row whose window has passed', Number(old.attempts) === 1, JSON.stringify(old));
}

section('gates-token#3: a host over its budget writes no account rows');
{
  await reset();
  for (let i = 0; i < 10; i++) await login(`t${i}@r11b.test`, 'x', '10.88.0.1');
  const before = await loginRowCount();
  const st = [];
  for (let i = 0; i < 20; i++) st.push((await login(`random${i}-${crypto.randomUUID()}@r11b.test`, 'x', '10.88.0.1')).statusCode);
  check('the refused host is answered 429', st.every((s) => s === 429), JSON.stringify(st));
  check('...and 20 new identifiers created no rows', (await loginRowCount()) === before, `${before} -> ${await loginRowCount()}`);
  const c = await loginGuard.readLoginCounters(['login:ip:10.88.0.1']);
  check('...and its own counter stays at the attempts it was let through', c['login:ip:10.88.0.1'] === 10, JSON.stringify(c));
  // Neighbour: a host under its budget still counts the account.
  await login('counted@r11b.test', 'x', '10.88.0.2');
  const a = await loginGuard.readLoginCounters(['login:account:counted@r11b.test']);
  check('a host under its budget still counts against the account', a['login:account:counted@r11b.test'] === 1, JSON.stringify(a));
  // A refused host's account row is not created even when the identifier exists.
  await mkFan('exists@r11b.test');
  await login('exists@r11b.test', 'x', '10.88.0.1');
  const e = await loginGuard.readLoginCounters(['login:account:exists@r11b.test']);
  check('...and a refused host never touches an existing account\'s counter', e['login:account:exists@r11b.test'] === 0, JSON.stringify(e));
}

// ---------------------------------------------------------------------------
section('media#0: taking down an already-taken-down listing is already_gone');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const l41 = await mkListing(creator.id);
  const first = await takeDownContent({ type: 'listing', listingId: String(l41.id) });
  check('the first takedown removes it', first.result === 'removed', JSON.stringify(first));
  const stamped = (await getListing(l41.id)).mediaDeletedAt;
  const r = await ncii.addNciiReport({ category: 'self', contentLocation: 'listing 14', description: 'mine', consentStatement: true });
  const again = await call(contentTakedownRoute, { admin: true, body: { type: 'listing', listingId: String(l41.id), nciiReportId: String(r.id) } });
  check('a repeat (a mistyped id) is already_gone', again.statusCode === 200 && again.body.result === 'already_gone', JSON.stringify(again.body));
  check('...the original mediaDeletedAt is kept', (await getListing(l41.id)).mediaDeletedAt === stamped);
  const resolve = await call(nciiResolveRoute, { admin: true, body: { id: String(r.id), action: 'removed' } });
  check("...and it does NOT let the request resolve as 'removed'", resolve.statusCode === 409 && resolve.body.code === 'takedown_required', JSON.stringify(resolve.body));
  // Neighbour: a moderation-removed listing that still HAS its files (a
  // keepPaid ban) is really removed by this takedown.
  const l2 = await mkListing(creator.id);
  await query(`update listings set data = data || '{"status":"removed","moderationRemoved":true}'::jsonb where id = $1`, [l2.id]);
  const td = await call(contentTakedownRoute, { admin: true, body: { type: 'listing', listingId: String(l2.id), nciiReportId: String(r.id) } });
  check('a moderation-removed listing with files still counts as removed', td.statusCode === 200 && td.body.result === 'removed' && !!(await getListing(l2.id)).mediaDeletedAt, JSON.stringify(td.body));
  const ok = await call(nciiResolveRoute, { admin: true, body: { id: String(r.id), action: 'removed' } });
  check("...which does let the request resolve 'removed'", ok.statusCode === 200, JSON.stringify(ok.body));
  const missing = await takeDownContent({ type: 'listing', listingId: '999999' });
  check('a listing that does not exist is already_gone', missing.result === 'already_gone');
}

// ---------------------------------------------------------------------------
section('money#0: checkout is rate limited per account');
{
  await reset();
  const fan = await mkFan();
  const statuses = [];
  for (let i = 0; i < 22; i++) {
    const r = await call(checkoutRoute, { user: fan, body: { expectedBuyerId: String(fan.id), items: [], ageConfirmed: true, tosAccepted: true } });
    statuses.push(r.statusCode);
  }
  check('the first 20 are answered normally (400 empty cart)', statuses.slice(0, 20).every((s) => s === 400), JSON.stringify(statuses));
  check('...and the 21st is 429', statuses[20] === 429 && statuses[21] === 429, JSON.stringify(statuses.slice(20)));
  const other = await mkFan();
  const o = await call(checkoutRoute, { user: other, body: { expectedBuyerId: String(other.id), items: [], ageConfirmed: true, tosAccepted: true } });
  check('another account is unaffected', o.statusCode === 400, String(o.statusCode));
  const wrong = await call(checkoutRoute, { user: other, body: { expectedBuyerId: 'nope', items: [] } });
  check('a session mismatch is still answered first (409)', wrong.statusCode === 409, String(wrong.statusCode));
}

section('money#1: an in-transaction PRICE_CHANGED carries the current values');
{
  await reset();
  const { creator, user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 10_000, type: 'deposit' });
  const l = await mkListing(creator.id, { title: 'Latest set', priceCents: 700 });
  const err = await errOf(() => orders.createOrdersFromCredits({
    buyerId: fan.id,
    items: [{ listingId: l.id, creatorId: creator.id, creatorUserId: cu.id, priceCents: 500, shippingCents: 0, kind: 'digital', unlimited: true, title: 'Latest set' }],
    ageConfirmed: true, tosAccepted: true, idempotencyKey: crypto.randomUUID(),
  }));
  check('the locked re-check refuses a stale price', err?.code === 'PRICE_CHANGED', err?.message);
  check('...and attaches the current values', JSON.stringify(err?.item) === JSON.stringify({ listingId: String(l.id), title: 'Latest set', priceCents: 700, shippingCents: 0, kind: 'digital' }), JSON.stringify(err?.item));
  check('...nothing was charged', Number((await query('select balance_cents from credit_balances where user_id = $1', [String(fan.id)])).rows[0].balance_cents) === 10_000);
  const okOrder = await orders.createOrdersFromCredits({
    buyerId: fan.id,
    items: [{ listingId: l.id, creatorId: creator.id, creatorUserId: cu.id, priceCents: 700, shippingCents: 0, kind: 'digital', unlimited: true, title: 'Latest set' }],
    ageConfirmed: true, tosAccepted: true, idempotencyKey: crypto.randomUUID(),
  });
  check('the matching price still goes through', okOrder.length === 1);
  // The precheck's refusal keeps its shape too.
  const pre = await call(checkoutRoute, { user: fan, body: { expectedBuyerId: String(fan.id), items: [{ listingId: String(l.id), expectedPriceCents: 1, expectedKind: 'digital' }], ageConfirmed: true, tosAccepted: true, idempotencyKey: crypto.randomUUID() } });
  check('the precheck PRICE_CHANGED still carries items', pre.statusCode === 409 && pre.body.items?.[0]?.priceCents === 700, JSON.stringify(pre.body));
}

// ---------------------------------------------------------------------------
section('social#0: the possible-minor resolve merges into the report\'s preserved media');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const p = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: p }, []);
  const other = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: other }, []);
  const r = await ncii.addNciiReport({ category: 'minor', contentLocation: 'gallery', description: 'x', goodFaithStatement: true });
  const gd = await call(galleryDeleteRoute, { admin: true, body: { creatorId: String(creator.id), src: p, nciiReportId: String(r.id) } });
  check('the reported photo is removed and preserved for the request', gd.statusCode === 200, JSON.stringify(gd.body));
  const before = (await query('select data from ncii_reports where id = $1', [r.id])).rows[0].data;
  const pPath = p.replace('/api/media/', '');
  check('...and listed on the request', (before.preservedMedia || []).includes(pPath), JSON.stringify(before.preservedMedia));
  const res = await call(nciiResolveRoute, { admin: true, body: { id: String(r.id), action: 'removed', creatorId: String(creator.id) } });
  check('the request resolves removed against the creator (outright ban)', res.statusCode === 200, JSON.stringify(res.body));
  const after = (await query('select data from ncii_reports where id = $1', [r.id])).rows[0].data;
  check('the earlier preserved photo is STILL on the request', after.preservedMedia.includes(pPath), JSON.stringify(after.preservedMedia));
  check('...alongside the creator\'s remaining media', after.preservedMedia.includes(other.replace('/api/media/', '')), JSON.stringify(after.preservedMedia));
  check('...the count is the merged list\'s, and the first preservedAt is kept',
    after.preservedCount === after.preservedMedia.length && after.preservedAt === before.preservedAt, JSON.stringify([after.preservedCount, after.preservedAt, before.preservedAt]));
  check('...with no duplicates', new Set(after.preservedMedia).size === after.preservedMedia.length);
}

// ---------------------------------------------------------------------------
section('social#1 / accounts#4: NUL and half an emoji are a 400 on every text route, never a 500');
{
  await reset();
  check('unit: NUL is not storable', isWellFormedText('a\u0000b') === false && isWellFormedText('ok 🌍') === true);
  check('unit: a lone surrogate is not storable', isWellFormedText('hi \ud83d') === false);
  check('unit: sliceText drops NUL', sliceText('a\u0000b', 10) === 'ab');
  // Fix-up: query-driven routes are covered too.
  {
    const wl = await call(wallListRoute, { method: 'GET', query: { creatorId: '1\u0000' } });
    check('wall/list: a NUL in the query is a 400', wl.statusCode === 400 && wl.body?.code === 'MALFORMED_TEXT', JSON.stringify(wl.body));
    const wl2 = await call(wallListRoute, { method: 'GET', query: { creatorId: '999999' } });
    check('...and an ordinary query is not refused', wl2.statusCode !== 400 && wl2.statusCode !== 500, String(wl2.statusCode));
    const fanQ = await mkFan();
    const wq = await call(withRoute, { method: 'GET', user: fanQ, query: { userId: '\ud83d' } });
    check('messages/with: a lone surrogate in the query is a 400', wq.statusCode === 400, JSON.stringify(wq.body));
    const { sanitizeDocumentFileName } = await import('./performer-records-store.js');
    const longName = 'a'.repeat(199) + '🌍.png';
    check('performer document names never end in half an emoji', isWellFormedText(sanitizeDocumentFileName(longName)));
  }
  check('unit: sanitizeLocation / sanitizeSocials drop NUL',
    sanitizeLocation('NY\u0000C') === 'NYC' && !JSON.stringify(sanitizeSocials({ instagram: 'jane\u0000doe' })).includes('\\u0000'),
    JSON.stringify([sanitizeLocation('NY\u0000C'), sanitizeSocials({ instagram: 'jane\u0000doe' })]));
  check('unit: findMalformedText finds nested values and keys', findMalformedText({ a: [{ b: 'x\u0000' }] }) === 'a.0.b'
    && findMalformedText({ ['k\ud800']: 1 }) === '?' && findMalformedText({ ok: ['fine', 1, null] }) === null);
  check('unit: skip leaves an existing password alone', findMalformedText({ password: 'p\u0000' }, { skip: ['password'] }) === null);

  const { creator, user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'deposit' });
  const bio = await call(profileRoute, { user: cu, body: { fields: { bio: 'hi\u0000' } } });
  check('a NUL in a bio is a 400 naming the field', bio.statusCode === 400 && /fields\.bio/.test(bio.body.error), JSON.stringify(bio.body));
  const soc = await call(profileRoute, { user: cu, body: { fields: { socials: { instagram: 'a\u0000' } } } });
  check('...in a social handle too', soc.statusCode === 400, JSON.stringify(soc.body));
  const okBio = await call(profileRoute, { user: cu, body: { fields: { bio: 'hello 🌍 world' } } });
  check('a real emoji still saves', okBio.statusCode === 200, JSON.stringify(okBio.body));
  const dm = await call(sendRoute, { user: fan, body: { toUserId: String(cu.id), text: 'hi \ud83d', expectedPriceCents: 99 } });
  check('a DM with half an emoji is a 400', dm.statusCode === 400, `${dm.statusCode} ${JSON.stringify(dm.body)}`);
  const bal = Number((await query('select balance_cents from credit_balances where user_id = $1', [String(fan.id)])).rows[0].balance_cents);
  check('...and nothing was charged', bal === 5000, String(bal));
  const dmErr = await errOf(() => messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'x\u0000y', expectedPriceCents: 99 }));
  check('the store refuses it too (dm_malformed_text)', dmErr?.code === 'dm_malformed_text', dmErr?.code);
  const good = await call(sendRoute, { user: fan, body: { toUserId: String(cu.id), text: 'hi 👋', expectedPriceCents: 99 } });
  check('a DM with a whole emoji sends', good.statusCode === 200, JSON.stringify(good.body));
  check('unit: validateReportInput refuses a malformed reason', !!validateReportInput({ reason: 'bad \udc00' }).error && !validateReportInput({ reason: 'fine 👍' }).error);
  const post = await wall.addWallPost({ creatorId: creator.id, authorId: fan.id, authorName: 'x', text: 'ok' });
  const wr = await call(wallReportRoute, { user: cu, body: { postId: String(post.id), reason: 'minor \ud83d', category: 'minor' } });
  check('a wall report with half an emoji is a 400', wr.statusCode === 400, `${wr.statusCode} ${JSON.stringify(wr.body)}`);
  const convo = await messages.getConversationBetween(fan.id, cu.id);
  const mr = await call(messageReportRoute, { user: cu, body: { conversationId: convo.id, messageId: convo.messages[0].id, reason: 'x\u0000' } });
  check('a DM report with a NUL is a 400', mr.statusCode === 400, `${mr.statusCode} ${JSON.stringify(mr.body)}`);
  const lg = await call(loginRoute, { body: { email: 'a\u0000@b.test', password: 'x' } });
  check('a NUL in a login identifier is a 400, not a 500', lg.statusCode === 400, `${lg.statusCode} ${JSON.stringify(lg.body)}`);
  const lgPw = await call(loginRoute, { body: { email: cu.email, password: 'password123' } });
  check('...and a normal login still works', lgPw.statusCode === 200, String(lgPw.statusCode));
  const lgNulPw = await call(loginRoute, { body: { email: cu.email, password: 'p\u0000' } });
  check('...a NUL in the PASSWORD is compared, never refused as malformed (401)', lgNulPw.statusCode === 401, String(lgNulPw.statusCode));
  const wl = await call(waitlistRoute, { body: { email: 'a\u0000@b.test', role: 'fan' } });
  check('the waitlist refuses it with a 400', wl.statusCode === 400, `${wl.statusCode} ${JSON.stringify(wl.body)}`);
  // The shared guard in isolation.
  const res = fakeRes();
  check('refuseMalformedText answers and reports true', refuseMalformedText({ body: { q: 'a\u0000' } }, res) === true && res.statusCode === 400 && res.body.field === 'q');
  check('...and false on clean input (nothing sent)', refuseMalformedText({ body: { q: 'ok' }, query: { id: '1' } }, fakeRes()) === false);
  check('...and checks the query string too', refuseMalformedText({ body: undefined, query: { id: '1\u0000' } }, fakeRes()) === true);
}

// ---------------------------------------------------------------------------
section('accounts#0 / #1: contact handovers with a handle noun, and ordinary "line" / "sc" / "snap" / "signal"');
{
  const S = (t, o) => screenPublicText(t, o);
  for (const t of ['my snap tag: jdoe', 'Snapchat username: jane_doe', 'snap user: jane_doe', 'LINE ID: jane_doe', 'My LINE ID: jane_doe',
    'Line ID: janedoe99', 'WeChat ID: jane99', 'kik username: jane99', 'telegram id: jane99', 'Snapchat ID - jane_doe',
    'Snapchat username: jane_doe  (cheaper there)',
    // Still blocked: the shapes that already were.
    'my snap: jdoe', 'snapchat: janedoe99', 'SC @jane', 'sc: @jane_doe', 'line @jane', 'line: @jane', 'my sc is jane_doe99',
    'signal @jane_doe', 'Telegram @janedoe', 'snapchat @jane', 'snap @jane', 'add me on line janedoe', 'line: jane_doe99',
    // Fix-up: the ordinary Snapchat handovers the first fix let through, and
    // a connector / a preceding @handle on the handoverOnly rails.
    'my snap is @jane', 'snap is @jane', 'snap me @jane_doe', 'snap me at @jane_doe', 'hit me on snap, im @jane_doe',
    'snap for @jane_doe', '@jane_doe on snap', '@jane_doe on sc', '@jane_doe on tg', 'sc me @jane_doe', 'signal me @jane_doe',
    'line me @jane_doe', 'tg me @jane_doe', 'my sc is @jane', 'oh snap, add me @jane_doe on snap', 'oh snap @jane_doe']) {
    check(`blocks: ${t}`, !!S(t), JSON.stringify(S(t)));
  }
  for (const t of ['New lingerie line with @jess_rose drops Friday', 'new line of sets with @mia_x',
    "Shot by @mia.photo — bottom line, it's my best set", 'My new line: lingerie.', 'Spring line: bikinis', 'bottom line: subscribe.',
    'Coming soon to my line: latex', 'Charleston, SC | collab w/ @jess_rose', 'Oh snap, my collab with @jess_rose is live',
    'Signal boost for @jess_rose, go sub', 'next in line for a collab with @mia_x', 'Snap a pic with @jess_rose',
    'my snap is cute', 'Instagram: private', 'New lingerie line for @jess_rose fans', 'Snap some pics with @mia_x today']) {
    check(`passes: ${t}`, !S(t), JSON.stringify(S(t)));
  }
}

section('accounts#2: glued name handles are judged word by word (handles and usernames only)');
{
  const names = ['laurapeters', 'kiaraperez', 'tarapena', 'norapearl', 'sierrapeach', 'barbarapeach', 'ClaraPerez', 'chiarapellegrini',
    'paulolima', 'danilolima', 'marcelolima', 'vincestone', 'vincesteele', 'cuteengineer', 'LauraPeters', 'Vince.Stone'];
  for (const h of names) {
    check(`handle passes: ${h}`, !screenPublicText(h, { context: 'handle' }), JSON.stringify(screenPublicText(h, { context: 'handle' })));
    check(`username passes: ${h}`, !screenPublicText(h, { context: 'username' }));
  }
  for (const h of ['rape_play', 'RapePlay', 'hot.loli', 'LoIita', 'teen_slut', 'Teen-Queen', 'incest.fan', 'p_e_d_o', 'underage_girl', 'jess_16yo', 'TeEn']) {
    check(`handle still blocks: ${h}`, !!screenPublicText(h, { context: 'handle' }), JSON.stringify(screenPublicText(h, { context: 'handle' })));
  }
  // The compound tier still runs on free text: glued evasions in a bio block.
  // Fix-up: name mode keeps a narrow compound slice (a high-risk term glued
  // onto a sexual word) and reads through edge "x" decoration.
  for (const h of ['teenslut', 'xteenx', 'xxincestxx', 'pornteen', 'incestsex', 'xpedox', 'lolisex']) {
    check(`handle still blocks: ${h}`, !!screenPublicText(h, { context: 'handle' }));
    check(`username still blocks: ${h}`, !!screenPublicText(h, { context: 'username' }));
  }
  for (const h of ['alex', 'maxx', 'xavier', 'foxxy', 'sexxy', 'Teena', 'rexteen_fan']) {
    // (rexteen_fan: "teen" is not glued onto a sexual word, and "rex" is not an edge x)
    check(`handle passes: ${h}`, !screenPublicText(h, { context: 'handle' }), JSON.stringify(screenPublicText(h, { context: 'handle' })));
  }
  for (const t of ['rapeplay', 'lolibody', 'hotteen', 'my new rapeplay set']) check(`free text still blocks: ${t}`, !!screenPublicText(t), JSON.stringify(screenPublicText(t)));
  check('free text: #extrapetite passes', !screenPublicText('new set #extrapetite #lingerie'));
  check('free text: #extrapetiterape still blocks', !!screenPublicText('#extrapetiterape'));
  // Through the real route.
  await reset();
  const { user: cu } = await mkCreatorUser();
  const r = await call(profileRoute, { user: cu, body: { fields: { handle: '@laurapeters' } } });
  check('the profile route saves @laurapeters', r.statusCode === 200, JSON.stringify(r.body));
  const bad = await call(profileRoute, { user: cu, body: { fields: { handle: '@rape_play' } } });
  check('...and still refuses @rape_play', bad.statusCode === 400, JSON.stringify(bad.body));
  const fan = await call(signupRoute, { body: { role: 'fan', email: 'paulolima', password: 'secret123', acceptedTerms: true } });
  check('a fan can sign up with the username paulolima', fan.statusCode === 200, JSON.stringify(fan.body));
}

section('accounts#3: everyday 18+ disclaimers with "underage" pass; affirmative uses still block');
{
  for (const t of ['Strictly 18+. Underage users will be reported.', "I don't allow underage people", 'Not for underage viewers',
    'Do not message me if underage', 'Zero tolerance for underage content', 'All models are 18+, nothing underage here',
    '18+ only. Underage = instant block', 'Anyone under age will be reported', 'Underage kids stay away',
    'We report underage accounts to NCMEC', 'if u underage dont follow', 'Minors/underage: do not follow',
    // round-10 cases still pass
    '18+ only, no underage', 'are you underage?', 'Underage? leave now.']) {
    check(`passes: ${t}`, !screenPublicText(t), JSON.stringify(screenPublicText(t)));
  }
  for (const t of ['underage girl', 'new underage set', 'underage?? you know what I sell', 'underage leave you wanting more',
    'hot underage content for sale', 'nothing hotter than underage girls', 'underage slut', 'underage = hot',
    // Fix-up: a bare "if" solicits, "reported" before it is not a disclaimer,
    // and only a filler noun / an exclusion verb may follow.
    'dm me if underage', 'hmu if underage 😉', 'message me if u underage', 'reported underage girl',
    'hot underage content will be removed soon lol', 'underage girls stay away from mom', 'underage: do not miss this',
    'underage - dont tell mom']) {
    check(`blocks: ${t}`, !!screenPublicText(t), JSON.stringify(screenPublicText(t)));
  }
}

section('accounts#5: a pair of real flags is a flag, not two letters');
{
  check('🇵🇪🇩🇴 passes', !screenPublicText('🇵🇪🇩🇴'));
  check('Peru 🇵🇪🇩🇴 NYC passes', !screenPublicText('Peru 🇵🇪🇩🇴 NYC'));
  check('as a location too', sanitizeLocation('🇵🇪🇩🇴 NYC') !== '' && !screenPublicText('🇵🇪🇩🇴 NYC'));
  check('indicators that are NOT flags still spell a word (🇹🇪🇪🇳)', !!screenPublicText('🇹🇪🇪🇳'), JSON.stringify(screenPublicText('🇹🇪🇪🇳')));
  check('spaced single indicators still spell a word (🇹 🇪 🇪 🇳)', !!screenPublicText('🇹 🇪 🇪 🇳'));
  check('a flag no longer glues onto the next word', !/italy/.test(foldLookalikeLetters('🇮🇹aly')));
  check('fancy negative letters still fold (🆅🅴🅽🅼🅾)', !!screenPublicText('🆅🅴🅽🅼🅾 me'));
}

// ---------------------------------------------------------------------------
section('legal-journeys#0: deleting an account anonymises the notifications it caused');
{
  await reset();
  const c = await mkCreatorUser();
  const fan = await users.createUser({ email: 'alice_nyc', password: 'password123', role: 'fan' });
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'deposit' });
  const dm = await call(sendRoute, { user: fan, body: { toUserId: String(c.user.id), text: 'hi there', expectedPriceCents: 99 } });
  check('the fan DMs the creator', dm.statusCode === 200, JSON.stringify(dm.body));
  const wp = await call(wallPostRoute, { user: fan, body: { creatorId: String(c.creator.id), text: 'love the new set' } });
  check('...and comments on their wall', wp.statusCode === 200, JSON.stringify(wp.body));
  // Neighbour: someone else's notifications are left exactly as they were.
  const bob = await users.createUser({ email: 'bob_la', password: 'password123', role: 'fan' });
  await credits.creditAccount({ userId: bob.id, cents: 5000, type: 'deposit' });
  await call(sendRoute, { user: bob, body: { toUserId: String(c.user.id), text: 'hey', expectedPriceCents: 99 } });
  await call(wallPostRoute, { user: bob, body: { creatorId: String(c.creator.id), text: 'nice' } });
  const before = (await query('select message from notifications where user_id = $1', [String(c.user.id)])).rows.map((r) => r.message);
  check('the creator was notified by name', before.some((m) => m.includes('alice_nyc')) && before.some((m) => m.includes('bob_la')), JSON.stringify(before));
  await users.deleteFanAccount(fan.id, { force: true });
  const after = (await query('select message, meta from notifications where user_id = $1', [String(c.user.id)])).rows;
  check('no notification names the deleted account any more', !JSON.stringify(after).includes('alice_nyc'), JSON.stringify(after));
  check('...they are anonymised, not dropped (the count stays right)', after.length === before.length
    && after.some((r) => r.message === 'New message from Someone') && after.some((r) => r.message === 'Someone commented on your wall'), JSON.stringify(after));
  check('...and the DM notification no longer carries their id', !after.some((r) => r.meta?.fromUserId === String(fan.id)));
  check('...while bob\'s notifications are untouched', after.filter((r) => r.message.includes('bob_la')).length === 2, JSON.stringify(after));

  // Fix-up: a comment deleted BEFORE the account (by the fan, the creator or
  // an admin) leaves no wall_posts row, but its notification still names them.
  const c2 = await mkCreatorUser();
  const carol = await users.createUser({ email: 'carol_sf', password: 'password123', role: 'fan' });
  const wp2 = await call(wallPostRoute, { user: carol, body: { creatorId: String(c2.creator.id), text: 'gorgeous' } });
  check('carol comments on a second wall', wp2.statusCode === 200, JSON.stringify(wp2.body));
  const wp3 = await call(wallPostRoute, { user: bob, body: { creatorId: String(c2.creator.id), text: 'agreed' } });
  check('...so does bob', wp3.statusCode === 200, JSON.stringify(wp3.body));
  await query(`delete from wall_posts where data->>'authorId' = $1`, [String(carol.id)]);
  await users.deleteFanAccount(carol.id, { force: true });
  const after2 = (await query('select message from notifications where user_id = $1', [String(c2.user.id)])).rows.map((r) => r.message);
  check('a notification for an already-deleted comment is anonymised too', !after2.some((m) => m.includes('carol_sf'))
    && after2.includes('Someone commented on your wall'), JSON.stringify(after2));
  check('...and bob\'s on that wall still names bob', after2.some((m) => m.includes('bob_la')), JSON.stringify(after2));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
