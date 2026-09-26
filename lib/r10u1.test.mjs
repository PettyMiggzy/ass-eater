// Round-10 R10U1 regression tests, run against a real scratch Postgres (it
// truncates tables). Only @vercel/blob's head() is stubbed.
//  - public-pages#0: checkout refuses (and charges nothing) when the request
//    was built for a different account than the session paying -- a /cart tab
//    left open across a sign-out/sign-in -- and the cart/page wiring that
//    re-checks the viewer and sends expectedBuyerId;
//  - social#0 (UI half): the inbox keeps wall-block rows opaque and after
//    every thread.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r10u1.test.mjs

import crypto from 'crypto';
import fs from 'fs';
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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r10u1';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r10u1';
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r10u1c${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r10u1.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r10u1.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
const balanceOf = async (uid) => Number((await query('select balance_cents from credit_balances where user_id = $1', [String(uid)])).rows[0]?.balance_cents ?? 0);
const ordersOf = async (uid) => (await query(`select 1 from orders where data->>'buyerId' = $1`, [String(uid)])).rows.length;

// ---------------------------------------------------------------------------
section('public-pages#0: a checkout built for another account is refused, uncharged');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const l = await mkListing(creator.id);
  const fanA = await mkFan();
  const fanB = await mkFan();
  await credits.creditAccount({ userId: fanB.id, cents: 10_000, type: 'deposit' });
  const item = { listingId: String(l.id), expectedPriceCents: 500, expectedShippingCents: 0, expectedKind: 'digital' };
  const base = { items: [item], ageConfirmed: true, tosAccepted: true };

  // Tab 1 was rendered for A; B is signed in now (B's session cookie).
  const stale = await call(checkoutRoute, { user: fanB, body: { ...base, idempotencyKey: crypto.randomUUID(), expectedBuyerId: String(fanA.id) } });
  check('a cart rendered for A, paid under B\'s session, is refused with SESSION_CHANGED',
    stale.statusCode === 409 && stale.body.code === 'SESSION_CHANGED', `${stale.statusCode} ${JSON.stringify(stale.body)}`);
  check('...B is charged nothing', (await balanceOf(fanB.id)) === 10_000);
  check('...and no order exists for B', (await ordersOf(fanB.id)) === 0);

  const missing = await call(checkoutRoute, { user: fanB, body: { ...base, idempotencyKey: crypto.randomUUID() } });
  check('a checkout that does not say whose it is is refused the same way',
    missing.statusCode === 409 && missing.body.code === 'SESSION_CHANGED', `${missing.statusCode} ${JSON.stringify(missing.body)}`);
  for (const bad of [{}, [], true, '', 0]) {
    const r = await call(checkoutRoute, { user: fanB, body: { ...base, idempotencyKey: crypto.randomUUID(), expectedBuyerId: bad } });
    check(`a non-id expectedBuyerId (${JSON.stringify(bad)}) is refused`, r.statusCode === 409 && r.body.code === 'SESSION_CHANGED', `${r.statusCode}`);
  }
  check('...still nothing charged', (await balanceOf(fanB.id)) === 10_000);

  const ok = await call(checkoutRoute, { user: fanB, body: { ...base, idempotencyKey: crypto.randomUUID(), expectedBuyerId: String(fanB.id) } });
  check('the same cart with B\'s own id goes through', ok.statusCode === 200, `${ok.statusCode} ${JSON.stringify(ok.body)}`);
  check('...charging B the listed price once', (await balanceOf(fanB.id)) === 9_500, String(await balanceOf(fanB.id)));

  // A retry of B's committed checkout sent from a tab still rendered for A is
  // still SESSION_CHANGED, not an answer about B's key.
  const key = crypto.randomUUID();
  const l2 = await mkListing(creator.id);
  const item2 = { ...item, listingId: String(l2.id) };
  const first = await call(checkoutRoute, { user: fanB, body: { ...base, items: [item2], idempotencyKey: key, expectedBuyerId: String(fanB.id) } });
  check('B buys a second listing', first.statusCode === 200, `${first.statusCode}`);
  const replay = await call(checkoutRoute, { user: fanB, body: { ...base, items: [item2], idempotencyKey: key, expectedBuyerId: String(fanA.id) } });
  check('a mismatched request is refused before the idempotency lookup', replay.statusCode === 409 && replay.body.code === 'SESSION_CHANGED');

  const anon = await call(checkoutRoute, { body: { ...base, idempotencyKey: crypto.randomUUID(), expectedBuyerId: String(fanA.id) } });
  check('signed out is still a 401', anon.statusCode === 401, String(anon.statusCode));
}

section('public-pages#0: the /cart page and the cart provider wiring');
{
  const cartPage = fs.readFileSync(new URL('../pages/cart.js', import.meta.url), 'utf8');
  const cartLib = fs.readFileSync(new URL('./cart.js', import.meta.url), 'utf8');
  check('/cart sends the account it was rendered for', /expectedBuyerId:\s*uid/.test(cartPage));
  check('/cart handles SESSION_CHANGED by reloading, not by keeping the cart', /data\.code === 'SESSION_CHANGED'[\s\S]{0,200}reloadForSession\(\)/.test(cartPage));
  check('/cart reloads when the cart sees a different viewer', /viewerConfirmed\.current\)\s*reloadForSession\(\)/.test(cartPage));
  check('/cart does not offer Pay while the viewer mismatches', /!viewerMismatch &&/.test(cartPage));
  check('the cart listens for other tabs changing the stored cart', /addEventListener\('storage', onStorage\)/.test(cartLib));
  check('...and re-checks the viewer on focus and on a return to the tab',
    /addEventListener\('focus', onFocus\)/.test(cartLib) && /addEventListener\('visibilitychange', onVisible\)/.test(cartLib));
  check('...withholding (not discarding) a cart owned by someone else until the re-check answers',
    /next\.owner \?\? null\) !== known\)[\s\S]{0,160}setViewerState\(undefined\)/.test(cartLib));
  check('the cart exposes the confirmed viewer', /hydrated, setViewer, viewer \}\)/.test(cartLib));
}

section('social#0 (UI): wall-block rows stay opaque and after every thread');
{
  await reset();
  const { user: owner } = await mkCreatorUser();
  const fan = await mkFan();
  await messages.setWallBlocked(owner.id, String(fan.id), true);
  const r = await call(conversationsRoute, { method: 'GET', user: owner, query: {} });
  const rows = r.body?.conversations || [];
  check('the wall block is listed as one opaque row', rows.length === 1 && rows[0].blockOnly === true && rows[0].other?.userId === null
    && !JSON.stringify(rows[0]).includes(String(fan.id)), JSON.stringify(rows));
  const inbox = fs.readFileSync(new URL('../components/dashboard/Inbox.js', import.meta.url), 'utf8');
  check('the inbox orders wall-block rows after threads on every load path',
    (inbox.match(/orderRows\(/g) || []).length >= 4);
  check('the inbox unblocks a row by its handle only', /blockHandle: handle, blocked: false/.test(inbox));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
