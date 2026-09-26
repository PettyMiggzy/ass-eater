// Regression tests for the round-16 backend fixes (package R16B), run against a
// real scratch Postgres (it truncates tables). Every fix is tested in both
// directions (the bug, and its nearest harmless neighbours):
//  - gates-token#0: a crafted login identifier cannot write another account's
//    per-host failure marker (keys carry a digest of the identifier);
//  - social#0 / legal-journeys#1: a notification racing an account deletion
//    waits for it and is not left behind for the deleted uid;
//  - legal-journeys#0: a buyer whose account is gone has name/address (and, until round 18, tracking)
//    erased when the order ships; a deleted creator's own shipped purchases
//    are erased with the account;
//  - legal-journeys#2: the seller's order view carries no erasure timestamps;
//  - legal-journeys#3: /api/bridge/whoami is gone;
//  - media#0: a ladder ban is not a removal basis for a TAKE IT DOWN request
//    (a possible-minor outright ban still is); a banned creator is not served
//    their own gallery files;
//  - media#1 / social#1: an in-product listing removal commits with the
//    report's status -- a failure leaves the listing up and the report open;
//    a gallery removal stamps the report so a retry records 'removed' and a
//    dismissal is refused;
//  - money#0/#1, dashboard#0/#1: 5000 random real-shaped tracking numbers per
//    carrier all pass; only app names are logged.
// The screen corpus (accounts#0-#5) is lib/screen-corpus.test.mjs.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r16b.test.mjs

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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r16b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r16b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
if (!process.env.ORDERS_ENCRYPTION_KEY) process.env.ORDERS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const deleted = [];
const realBlob = await import('@vercel/blob');
mock.module('@vercel/blob', {
  namedExports: {
    ...realBlob,
    head: async () => ({ contentType: 'image/jpeg', size: 1024 }),
    del: async (p) => { deleted.push(...(Array.isArray(p) ? p : [p])); },
  },
});

const { query, closePool, withTransaction } = await import('./db.js');
const pg = (await import('pg')).default;
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const orders = await import('./orders-store.js');
const ncii = await import('./ncii-reports-store.js');
const reportsStore = await import('./reports-store.js');
const loginGuard = await import('./login-guard.js');
const rules = await import('./tracking-rules.js');
const { createNotification } = await import('./notifications-store.js');
const { encryptShippingAddress } = await import('./crypto.js');
const { createSessionToken } = await import('./session.js');
const { default: loginRoute } = await import('../pages/api/auth/login.js');
const { default: nciiResolveRoute } = await import('../pages/api/admin/ncii-reports-resolve.js');
const { default: reportsResolveRoute } = await import('../pages/api/admin/reports-resolve.js');
const { default: mediaRoute } = await import('../pages/api/media/[...path].js');
const { default: shipRoute } = await import('../pages/api/marketplace/orders/ship.js');

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; failures.push(`${name} ${extra}`); console.log('  FAIL', name, extra); }
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
async function call(route, { method = 'POST', body, query: q = {}, admin = false, user = null, ip = null } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = {};
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  const cookieJar = {};
  if (user) cookieJar.oa_session = createSessionToken(user.id, user.sessionVersion || 0);
  if (Object.keys(cookieJar).length) headers.cookie = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  const req = { method, body, query: q, headers, cookies: cookieJar, socket: { remoteAddress: ip || `10.96.${Math.floor(ipN / 250)}.${ipN % 250}` } };
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r16bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r16b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan(email = null) {
  n++;
  return users.createUser({ email: email || `f${n}@r16b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
const galleryFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'gallery', creatorId, contentType: 'image/jpeg' }));
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
const addr = () => encryptShippingAddress({ fullName: 'A B', line1: '1 Main St', city: 'X', postalCode: '1', country: 'US' });
async function mkOrder(creatorId, buyerId, fields = {}) {
  const { rows } = await query('insert into orders (data) values ($1::jsonb) returning id', [JSON.stringify({
    creatorId: String(creatorId), buyerId: String(buyerId), title: 'Signed poster', kind: 'physical', status: 'pending_shipment',
    shippingAddress: addr(), ...fields,
  })]);
  return String(rows[0].id);
}
const orderData = async (id) => (await query('select data from orders where id = $1', [id])).rows[0].data;

// ---------------------------------------------------------------------------
section('gates-token#0: a crafted identifier cannot name another account\'s failure marker');
{
  const a = loginGuard.loginGuardKeys({ identifier: 'a:from:1.2.3.4', ip: '9.9.9.9' });
  const b = loginGuard.loginGuardKeys({ identifier: 'a', ip: '1.2.3.4' });
  check('the account key for "a:from:1.2.3.4" is not account a\'s marker at 1.2.3.4', a.accountKey !== b.accountFromIpKey, JSON.stringify([a, b]));
  const c = loginGuard.loginGuardKeys({ identifier: 'a:fromnet:2001:db8:1::/48', ip: '9.9.9.9' });
  const d = loginGuard.loginGuardKeys({ identifier: 'a', ip: '2001:db8:1:2::/64', net: '2001:db8:1::/48' });
  check('...nor for ":fromnet:" and a /48', c.accountKey !== d.accountFromNetKey);
  const kindOf = new Map();
  let clash = null;
  for (const keys of [a, b, c, d]) {
    for (const [kind, key] of Object.entries(keys)) {
      if (!key) continue;
      if (kindOf.has(key) && kindOf.get(key) !== kind) clash = [key, kind, kindOf.get(key)];
      kindOf.set(key, kind);
    }
  }
  check('no key of one kind equals a key of another', clash === null, JSON.stringify(clash));
  check('the identifier is not stored raw', !Object.values(b).some((v) => v && v.includes(':a:')) && !b.accountKey.endsWith(':a'));
  check('the same identifier in another case is the same account', loginGuard.loginGuardKeys({ identifier: 'Alice@X.test', ip: 'i' }).accountKey
    === loginGuard.loginGuardKeys({ identifier: 'alice@x.test', ip: 'i' }).accountKey);

  await reset();
  const alice = await mkFan('alice@r16b.test');
  void alice;
  const home = '10.61.0.5';
  // The attack: forged identifiers that USED to be alice's marker at her home IP...
  for (let i = 0; i < 3; i++) await call(loginRoute, { body: { email: `alice@r16b.test:from:${home}`, password: 'x' }, ip: `10.62.0.${i + 1}` });
  // ...then alice's account budget saturated from other hosts.
  for (let i = 0; i < 11; i++) await call(loginRoute, { body: { email: 'alice@r16b.test', password: 'wrong' }, ip: `10.63.${i}.1` });
  const ok = await call(loginRoute, { body: { email: 'alice@r16b.test', password: 'password123' }, ip: home });
  check('alice, from her own clean host with the right password, still gets in', ok.statusCode === 200, JSON.stringify([ok.statusCode, ok.body]));
  // Neighbour: her OWN failures from home still make her host dirty.
  await reset();
  await mkFan('bob@r16b.test');
  const bobHome = '10.64.0.5';
  for (let i = 0; i < 3; i++) await call(loginRoute, { body: { email: 'bob@r16b.test', password: 'wrong' }, ip: bobHome });
  for (let i = 0; i < 11; i++) await call(loginRoute, { body: { email: 'bob@r16b.test', password: 'wrong' }, ip: `10.65.${i}.1` });
  const refused = await call(loginRoute, { body: { email: 'bob@r16b.test', password: 'password123' }, ip: bobHome });
  check('...while a host that failed three times itself is still braked', refused.statusCode === 429, JSON.stringify([refused.statusCode, refused.body]));
}

// ---------------------------------------------------------------------------
section('social#0 / legal-journeys#1: a notification racing an account deletion is not left behind');
{
  await reset();
  const fan = await mkFan();
  const uid = String(fan.id);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let inserted;
  try {
    await client.query('begin');
    // What deleteFanAccount does: lock, purge notifications part-way, delete at the end.
    await client.query('select id from users where id = $1 for update', [uid]);
    await client.query('delete from notifications where user_id = $1', [uid]);
    inserted = createNotification({ userId: uid, type: 'order_shipped', message: 'racing notice', meta: {} });
    await new Promise((r) => setTimeout(r, 300));
    const early = (await query('select count(*)::int as n from notifications where user_id = $1', [uid])).rows[0].n;
    check('the insert waits for the deletion instead of committing past its purge', early === 0, String(early));
    await client.query('delete from users where id = $1', [uid]);
    await client.query('commit');
  } finally {
    await client.end();
  }
  await inserted;
  const left = (await query('select count(*)::int as n from notifications where user_id = $1', [uid])).rows[0].n;
  check('...and, once the account is gone, nothing is inserted for it', left === 0, String(left));
  // Neighbour: an existing account still gets its notification.
  const other = await mkFan();
  await createNotification({ userId: String(other.id), type: 'order_shipped', message: 'hello', meta: {} });
  check('an existing account is still notified', (await query('select count(*)::int as n from notifications where user_id = $1', [String(other.id)])).rows[0].n === 1);
  // And inside a caller's transaction (the savepoint path).
  const third = await mkFan();
  await withTransaction(async (c) => { await createNotification({ userId: String(third.id), type: 'x', message: 'y' }, c); });
  check('...also on a caller\'s transaction', (await query('select count(*)::int as n from notifications where user_id = $1', [String(third.id)])).rows[0].n === 1);
  // The real deletion path end to end.
  const f4 = await mkFan();
  await createNotification({ userId: String(f4.id), type: 'x', message: 'y' });
  await users.deleteFanAccount(String(f4.id), { force: true, strict: true });
  check('deleteFanAccount leaves no notification behind', (await query('select count(*)::int as n from notifications where user_id = $1', [String(f4.id)])).rows[0].n === 0);
}

// ---------------------------------------------------------------------------
section('legal-journeys#0: every deletion path erases the buyer\'s shipping data, including at ship time');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const fan = await mkFan();
  const pending = await mkOrder(creator.id, fan.id);
  // Admin-forced deletion while the order is pending: the address stays (it must ship).
  await users.deleteFanAccount(String(fan.id), { force: true, strict: true });
  check('an admin-forced deletion keeps a pending order\'s address so it can ship', !!(await orderData(pending)).shippingAddress);
  const shipped = await call(shipRoute, { user, body: { orderId: pending, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' } });
  check('the order still ships', shipped.statusCode === 200, JSON.stringify(shipped.body));
  const d = await orderData(pending);
  // Round 18 (decided): the tracking number is the seller's carrier
  // reference and stays; only the name and address are the buyer's.
  check('...and the moment it does, the deleted buyer\'s address is erased (the tracking stays)',
    d.status === 'shipped' && d.shippingAddress === null && d.trackingNumber === '1Z999AA10123456784' && !d.trackingErasedAt
    && !!d.addressErasedAt && d.carrier === 'UPS', JSON.stringify(d));
  check('...no notification is left for the deleted buyer', (await query('select count(*)::int as n from notifications where user_id = $1', [String(fan.id)])).rows[0].n === 0);
  check('...and the seller\'s response carries no erasure stamp', !('trackingErasedAt' in shipped.body.order) && !('addressErasedAt' in shipped.body.order),
    JSON.stringify(shipped.body.order));
  // Neighbour: a live buyer keeps their tracking number.
  const live = await mkFan();
  const o2 = await mkOrder(creator.id, live.id);
  await call(shipRoute, { user, body: { orderId: o2, carrier: 'USPS', trackingNumber: '9405511899223197428490' } });
  const d2 = await orderData(o2);
  check('a live buyer\'s shipped order keeps its tracking number', d2.trackingNumber === '9405511899223197428490' && !d2.trackingErasedAt, JSON.stringify(d2));

  // A creator account that BOUGHT from another creator, then is deleted.
  const { creator: buyerCreator, user: buyerLogin } = await mkCreatorUser();
  const shippedBuy = await mkOrder(creator.id, buyerLogin.id);
  await call(shipRoute, { user, body: { orderId: shippedBuy, carrier: 'USPS', trackingNumber: '9405511899223197428490' } });
  const pendingBuy = await mkOrder(creator.id, buyerLogin.id);
  await quiet(() => creators.deleteCreator(String(buyerCreator.id), { force: true }));
  const s1 = await orderData(shippedBuy);
  check('deleting a creator erases their own shipped purchases\' addresses', s1.shippingAddress === null
    && s1.trackingNumber === '9405511899223197428490', JSON.stringify(s1));
  check('...keeps a pending one\'s address so it can ship', !!(await orderData(pendingBuy)).shippingAddress);
  await call(shipRoute, { user, body: { orderId: pendingBuy, carrier: 'FedEx', trackingNumber: '748912345679' } });
  const s2 = await orderData(pendingBuy);
  check('...and erases it when it ships', s2.status === 'shipped' && s2.shippingAddress === null && s2.trackingNumber === '748912345679', JSON.stringify(s2));
}

// ---------------------------------------------------------------------------
section('legal-journeys#2: the seller is not told the buyer asked for erasure');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const fan = await mkFan();
  const o = await mkOrder(creator.id, fan.id, { status: 'shipped', carrier: 'UPS', trackingNumber: '1Z999AA10123456784', shippedAt: new Date().toISOString() });
  await orders.eraseOrderShippingAddress(o);
  const view = (await orders.getOrdersForCreator(creator.id)).find((x) => String(x.id) === o);
  check('the creator view has no addressErasedAt / trackingErasedAt', view && !('addressErasedAt' in view) && !('trackingErasedAt' in view), JSON.stringify(view));
  // Round 17 (money#2, dashboard#0): nor does anything else in the seller's
  // view change -- the number they entered and the correction count stay.
  check('...and still shows the number and the corrections left', view.trackingNumber === '1Z999AA10123456784' && view.trackingCorrectionsLeft === 3,
    JSON.stringify(view));
  const buyerView = (await orders.getOrdersForBuyer(String(fan.id)))[0];
  // Round 18: the buyer sees their address erasure, and the same number.
  check('the buyer sees their own erasure (address only)', !!buyerView.addressErasedAt && buyerView.shippingAddress === null
    && buyerView.trackingNumber === '1Z999AA10123456784', JSON.stringify(buyerView));
  const fixed = await orders.markOrderShipped(o, creator.id, { carrier: 'UPS', trackingNumber: '1Z999AA10123456793' });
  check('a correction answers like any other, into the one shared copy', fixed.trackingNumber === '1Z999AA10123456793'
    && (await orderData(o)).trackingNumber === '1Z999AA10123456793', JSON.stringify(fixed));
}

// ---------------------------------------------------------------------------
section('legal-journeys#3: the proof-of-concept bridge endpoint is gone');
check('/api/bridge/whoami no longer exists', !fs.existsSync(new URL('../pages/api/bridge/whoami.js', import.meta.url)));

// ---------------------------------------------------------------------------
section('media#0: a ladder ban is not a removal basis; a banned creator is not served their gallery');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const g = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g }, []);
  // One prior confirmed violation, so the next one bans.
  await query(`update creators set data = data || '{"contentViolationCount": 1}'::jsonb where id = $1`, [String(creator.id)]);
  const r = await ncii.addNciiReport({ category: 'self', contentLocation: 'gallery', description: 'x', consentStatement: true });
  const res = await call(nciiResolveRoute, { admin: true, body: { id: String(r.id), action: 'removed', creatorId: String(creator.id) } });
  check('resolving "removed" on a ladder ban alone is refused (takedown_required)', res.statusCode === 409 && res.body.code === 'takedown_required', JSON.stringify(res.body));
  const after = await creators.getCreatorById(String(creator.id));
  check('...and nothing changed: the creator is not banned, the request still open',
    after.status === 'active' && (await query('select data->>\'status\' as s from ncii_reports where id = $1', [r.id])).rows[0].s === 'open');
  const acked = await call(nciiResolveRoute, { admin: true, body: { id: String(r.id), action: 'removed', creatorId: String(creator.id), contentGone: true } });
  check('with the admin\'s explicit acknowledgement it resolves, basis "acknowledged"', acked.statusCode === 200 && acked.body.report.removalBasis === 'acknowledged', JSON.stringify(acked.body));
  check('...and the ladder ban applied', (await creators.getCreatorById(String(creator.id))).status === 'banned');
  const path = g.replace('/api/media/', '').split('/');
  const banned = await call(mediaRoute, { method: 'HEAD', user, query: { path } });
  check('the banned creator is no longer served their own gallery file', banned.statusCode === 404, String(banned.statusCode));
  const adminView = await call(mediaRoute, { method: 'HEAD', admin: true, query: { path } });
  void adminView;
  // Neighbour: a suspended creator still sees their own files.
  const { creator: c2, user: u2 } = await mkCreatorUser();
  const g2 = galleryFile(c2.id);
  await creators.addGalleryItem(c2.id, { type: 'image', src: g2 }, []);
  await query(`update creators set data = data || jsonb_build_object('status', 'suspended', 'suspendedUntil', $2::text) where id = $1`,
    [String(c2.id), new Date(Date.now() + 86400000).toISOString()]);
  const susp = await call(mediaRoute, { method: 'HEAD', user: u2, query: { path: g2.replace('/api/media/', '').split('/') } });
  check('a suspended creator is still served their own gallery file', susp.statusCode === 200, String(susp.statusCode));
  // Neighbour: a possible-minor outright ban is still a basis.
  const { creator: c3 } = await mkCreatorUser();
  await mkListing(c3.id);
  const m = await ncii.addNciiReport({ category: 'minor', contentLocation: 'x', description: 'x', goodFaithStatement: true });
  const mres = await call(nciiResolveRoute, { admin: true, body: { id: String(m.id), action: 'removed', creatorId: String(c3.id) } });
  check('a possible-minor outright ban still resolves, basis "ban"', mres.statusCode === 200 && mres.body.report.removalBasis === 'ban', JSON.stringify(mres.body));
}

// ---------------------------------------------------------------------------
section('media#1 / social#1: an in-product listing removal commits with the report');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const l = await mkListing(creator.id);
  const rep = await reportsStore.addReport({ targetType: 'listing', targetId: String(l.id), category: 'non_consensual', reason: 'x', reporterId: 'u' });
  // Make the report's status write fail, the way a dropped connection would.
  await query(`create or replace function r16b_fail() returns trigger language plpgsql as $$
    begin if new.data->>'status' = 'actioned' then raise exception 'r16b simulated failure'; end if; return new; end $$`);
  await query('create trigger r16b_fail before update on reports for each row execute function r16b_fail()');
  deleted.length = 0;
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_r16b';
  let failed;
  try {
    failed = await call(reportsResolveRoute, { admin: true, body: { id: String(rep.id), action: 'remove_content' } });
  } finally {
    await query('drop trigger r16b_fail on reports');
    await query('drop function r16b_fail()');
  }
  check('the failed resolve answers 500', failed.statusCode === 500, JSON.stringify(failed.body));
  const still = (await query('select data from listings where id = $1', [String(l.id)])).rows[0].data;
  check('...the listing is still up (the removal rolled back with it)', !still.mediaDeletedAt && still.status !== 'removed', JSON.stringify(still));
  check('...no file was deleted', deleted.length === 0, JSON.stringify(deleted));
  const openRep = await reportsStore.getReportById(String(rep.id));
  check('...and the report is open and unclaimed', openRep.status === 'open' && !openRep.resolving, JSON.stringify(openRep));
  const retry = await call(reportsResolveRoute, { admin: true, body: { id: String(rep.id), action: 'remove_content' } });
  delete process.env.BLOB_READ_WRITE_TOKEN;
  check('the retry records "removed", not "already_gone"', retry.statusCode === 200 && retry.body.content === 'removed'
    && retry.body.report.contentOutcome === 'removed', JSON.stringify(retry.body));
  check('...and the files are deleted after that commit', deleted.length >= 1, JSON.stringify(deleted));

  // A gallery removal stamps the report in its own transaction.
  const g = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g }, []);
  const grep = await reportsStore.addReport({ targetType: 'gallery_item', targetId: String(creator.id), src: g, category: 'non_consensual', reason: 'x', reporterId: 'u' });
  await creators.removeGalleryItem(String(creator.id), { src: g, beforeRemove: (c) => c.query(
    `update reports set data = data || jsonb_build_object('contentRemovedAt', now()::text, 'contentRemovedBy', 'remove_content') where id = $1`, [String(grep.id)]) });
  const dismiss = await call(reportsResolveRoute, { admin: true, body: { id: String(grep.id), action: 'dismiss', reason: 'nothing there' } });
  check('a report whose content an earlier attempt removed cannot be dismissed', dismiss.statusCode === 409 && dismiss.body.code === 'content_removed', JSON.stringify(dismiss.body));
  const finish = await call(reportsResolveRoute, { admin: true, body: { id: String(grep.id), action: 'remove_content' } });
  check('...and finishing it records "removed"', finish.statusCode === 200 && finish.body.report.contentOutcome === 'removed', JSON.stringify(finish.body));
  // Neighbour: an ordinary gallery removal through the route.
  const g2 = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g2 }, []);
  const grep2 = await reportsStore.addReport({ targetType: 'gallery_item', targetId: String(creator.id), src: g2, category: 'other', reason: 'x', reporterId: 'u' });
  const g2res = await call(reportsResolveRoute, { admin: true, body: { id: String(grep2.id), action: 'remove_content' } });
  check('an ordinary gallery removal resolves "removed"', g2res.statusCode === 200 && g2res.body.content === 'removed', JSON.stringify(g2res.body));
  // Neighbour: a plain dismissal of an untouched report still works.
  const l3 = await mkListing(creator.id);
  const rep3 = await reportsStore.addReport({ targetType: 'listing', targetId: String(l3.id), category: 'other', reason: 'x', reporterId: 'u' });
  const d3 = await call(reportsResolveRoute, { admin: true, body: { id: String(rep3.id), action: 'dismiss' } });
  check('an untouched report can still be dismissed', d3.statusCode === 200, JSON.stringify(d3.body));
  // A possible-minor remove_and_ban on a listing still bans and quarantines.
  const { creator: c4 } = await mkCreatorUser();
  const l4 = await mkListing(c4.id);
  const rep4 = await reportsStore.addReport({ targetType: 'listing', targetId: String(l4.id), category: 'minor', reason: 'x', reporterId: 'u' });
  const rb = await call(reportsResolveRoute, { admin: true, body: { id: String(rep4.id), action: 'remove_and_ban' } });
  check('remove_and_ban on a listing still bans and records removed', rb.statusCode === 200 && rb.body.content === 'removed'
    && (await creators.getCreatorById(String(c4.id))).status === 'banned', JSON.stringify(rb.body));
  const pres = (await query('select count(*)::int as n from media_preservations where report_id = $1', [`report:${rep4.id}`])).rows[0].n;
  check('...with the listing file quarantined for the report', pres >= 1, String(pres));
}

// ---------------------------------------------------------------------------
section('money#0/#1, dashboard#0/#1: real-shaped tracking numbers always pass');
{
  let seed = 0x16b;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (chars, k) => Array.from({ length: k }, () => chars[Math.floor(rnd() * chars.length)]).join('');
  const D = '0123456789';
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const gens = {
    UPS: [() => `1Z${pick(A, 6)}${pick(A, 2)}${pick(D, 8)}`],
    FedEx: [12, 15, 20, 22].map((k) => () => pick(D, k)),
    USPS: [() => pick(D, 20), () => `9${pick(D, 21)}`, () => `${pick(L, 2)}${pick(D, 9)}US`],
    DHL: [() => pick(D, 10), () => pick(D, 11), () => `JD${pick(D, 18)}`],
    Other: [10, 11, 12, 13].map((k) => () => pick(D, k)).concat([() => `TBA${pick(D, 12)}`, () => `${pick(L, 2)}${pick(D, 9)}${pick(L, 2)}`]),
  };
  for (const [carrier, list] of Object.entries(gens)) {
    let refused = 0;
    let example = null;
    for (let i = 0; i < 5000; i++) {
      const t = list[i % list.length]();
      const e = rules.trackingFieldsError({ carrier, trackingNumber: t });
      if (e) { refused++; example = example || [t, e]; }
    }
    check(`5000 random real-shaped ${carrier} numbers all pass`, refused === 0, JSON.stringify([refused, example]));
  }
  const E = (c, t) => rules.trackingFieldsError({ carrier: c, trackingNumber: t });
  for (const [c, t] of [['UPS', '1ZX03A790324587616'], ['UPS', '1ZWA4R210324587619'], ['UPS', '1ZXX3150YW44070023'], ['UPS', '1ZWX0692YP40636269'],
    ['UPS', '1Z648616E192760718'], ['Other', '329012345678'], ['Other', '4003789012345'], ['Other', '7489 1234 5678'], ['Other', '12345678901'],
    ['Other', '1ZXX3150YW44070023'], ['DHL', '9261290100830426587645']]) {
    check(`accepted: ${c} | ${t}`, !E(c, t), JSON.stringify(E(c, t)));
  }
  for (const [c, t] of [['UPS', '1ZSNAPJESSXO123456'], ['Other', 'VENMO12345678'], ['USPS', 'KIK123456789']]) {
    check(`an app name is refused AND flagged: ${c} | ${t}`, E(c, t)?.suspicious === true, JSON.stringify(E(c, t)));
  }
  // Round 17: 'JESS61755512340' (a letter run) is accepted, and a short word
  // in a 1Z shipper ('1ZSNAP120312345678'); a whole long app name in a 1Z
  // shipper ('1ZWHATSAPP12345678') is still refused -- see r17b.
  for (const [c, t] of [['Other', 'jess@mail.com123456'], ['UPS', '1Z12345'], ['FedEx', 'abc']]) {
    const e = E(c, t);
    check(`refused but not flagged: ${c} | ${t}`, e && !e.suspicious, JSON.stringify(e));
  }
  check('a number unusual for its carrier gets a non-blocking warning', !!rules.trackingFormatWarning({ carrier: 'DHL', trackingNumber: '9261290100830426587645' }));
  check('...a usual one does not', rules.trackingFormatWarning({ carrier: 'UPS', trackingNumber: '1Z999AA10123456784' }) === null);

  // Through the route: an 'Other' 12-digit number ships and logs nothing.
  await reset();
  const { creator, user } = await mkCreatorUser();
  const fan = await mkFan();
  const o = await mkOrder(creator.id, fan.id);
  const r = await call(shipRoute, { user, body: { orderId: o, carrier: 'Other', trackingNumber: '329012345678' } });
  check('a 12-digit Purolator number under Other ships', r.statusCode === 200, JSON.stringify(r.body));
  check('...and no violation is logged', (await query('select count(*)::int as n from violations')).rows[0].n === 0);
  const o2 = await mkOrder(creator.id, fan.id);
  const w = await call(shipRoute, { user, body: { orderId: o2, carrier: 'DHL', trackingNumber: 'GM2951173225174494' } });
  check('a DHL eCommerce number under DHL ships with a warning', w.statusCode === 200 && typeof w.body.warning === 'string', JSON.stringify(w.body));
}

// ---------------------------------------------------------------------------
section('fix-up: the ship write and the deleted buyer\'s erasure commit together');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const fan = await mkFan();
  const o = await mkOrder(creator.id, fan.id);
  await users.deleteFanAccount(String(fan.id), { force: true, strict: true });
  // Make the erase UPDATE fail, the way a dropped connection between the two
  // statements would have left it.
  await query(`create or replace function r16b_fail_erase() returns trigger language plpgsql as $$
    begin if new.data ? 'addressErasedAt' and not (old.data ? 'addressErasedAt') then raise exception 'r16b simulated failure'; end if; return new; end $$`);
  await query('create trigger r16b_fail_erase before update on orders for each row execute function r16b_fail_erase()');
  let failed;
  try {
    failed = await call(shipRoute, { user, body: { orderId: o, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' } });
  } finally {
    await query('drop trigger r16b_fail_erase on orders');
    await query('drop function r16b_fail_erase()');
  }
  check('a failure in the erase fails the ship call', failed.statusCode === 500, JSON.stringify(failed.body));
  const d = await orderData(o);
  check('...and the ship rolled back with it (no shipped order holding the deleted buyer\'s address)',
    d.status === 'pending_shipment' && !d.trackingNumber && !!d.shippingAddress, JSON.stringify(d));
  const again = await call(shipRoute, { user, body: { orderId: o, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' } });
  const d2 = await orderData(o);
  check('the retry ships and erases in one commit', again.statusCode === 200 && d2.status === 'shipped'
    && d2.shippingAddress === null && !!d2.addressErasedAt && d2.trackingNumber === '1Z999AA10123456784', JSON.stringify(d2));
  // Neighbour: a correction for a live buyer still works.
  const live = await mkFan();
  const o3 = await mkOrder(creator.id, live.id);
  await call(shipRoute, { user, body: { orderId: o3, carrier: 'USPS', trackingNumber: '9405511899223197428490' } });
  const fix = await call(shipRoute, { user, body: { orderId: o3, carrier: 'USPS', trackingNumber: '9405511899223197428506' } });
  check('a live buyer\'s tracking correction still applies', fix.statusCode === 200
    && (await orderData(o3)).trackingNumber === '9405511899223197428506', JSON.stringify(fix.body));
}

// ---------------------------------------------------------------------------
section('fix-up: two admins resolving two reports on one wall comment do not deadlock');
{
  const wall = await import('./wall-store.js');
  for (let round = 0; round < 5; round++) {
    await reset();
    const { creator } = await mkCreatorUser();
    const fan = await mkFan();
    const post = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan.id), authorName: 'f', text: 'hello there' });
    const a = await reportsStore.addReport({ targetType: 'wall_post', targetId: String(post.id), category: 'non_consensual', reason: 'x', reporterId: 'u1' });
    const b = await reportsStore.addReport({ targetType: 'wall_post', targetId: String(post.id), category: 'minor', reason: 'x', reporterId: 'u2' });
    const [ra, rb] = await Promise.all([
      call(reportsResolveRoute, { admin: true, body: { id: String(a.id), action: 'remove_content' } }),
      call(reportsResolveRoute, { admin: true, body: { id: String(b.id), action: 'remove_content' } }),
    ]);
    check(`round ${round}: both resolves succeed`, ra.statusCode === 200 && rb.statusCode === 200, `${ra.statusCode} ${JSON.stringify(ra.body)} / ${rb.statusCode} ${JSON.stringify(rb.body)}`);
    const outcomes = [ra.body?.content, rb.body?.content].sort().join(',');
    check(`round ${round}: exactly one removed it`, outcomes === 'already_gone,removed', outcomes);
    check(`round ${round}: the comment is gone`, !(await wall.getWallPostById(String(post.id))));
  }
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
for (const f of failures) console.log('  FAILED:', f);
await closePool();
process.exit(fail ? 1 : 0);
