// Regression tests for the round-12 backend fixes (package R12B), run against a
// real scratch Postgres (it truncates tables). Only @vercel/blob's head() is
// stubbed. Every fix is tested in both directions (the bug, and its nearest
// harmless neighbours):
//  - media#1: a quarantine never records an already-deleted file as evidence;
//  - gates-token#0: the wallet bypass door answers 404 to everything when no
//    owner wallet is configured (and to a wrong method when one is);
//  - money#1: a shipped order's tracking can be corrected after its address
//    was erased; a pending one with an unreadable address is still refused;
//  - accounts#0: glued minor-suggestive handles/usernames are refused again,
//    real names still pass;
//  - accounts#1/#2: contact-app + "paid" needs an instruction shape; arrow /
//    emoji / "app me HANDLE" handovers are caught;
//  - social#0: the admin queues are paged in SQL, the badge has its own
//    endpoint, control characters are refused at intake, and filings are
//    counted durably;
//  - social#1: a wall comment id sent as an array is a 400, not a 500;
//  - legal-journeys#0: an in-product possible-minor report can ban the
//    creator with the same outcome as a TAKE IT DOWN resolve.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r12b.test.mjs

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
delete process.env.OWNER_WALLET_ADDRESS;
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.BRIDGE_SECRET = 'test-bridge-secret-r12b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r12b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
if (!process.env.ORDERS_ENCRYPTION_KEY) process.env.ORDERS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const realBlob = await import('@vercel/blob');
mock.module('@vercel/blob', {
  namedExports: { ...realBlob, head: async () => ({ contentType: 'image/jpeg', size: 1024 }) },
});

const { query, withTransaction, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const orders = await import('./orders-store.js');
const wall = await import('./wall-store.js');
const reportsStore = await import('./reports-store.js');
const ncii = await import('./ncii-reports-store.js');
const preservation = await import('./media-preservation.js');
const { encryptShippingAddress } = await import('./crypto.js');
const { screenPublicText } = await import('./prohibited-terms.js');
const { createSessionToken } = await import('./session.js');
const { takeDownContent } = await import('./content-takedown.js');
const { default: walletRoute } = await import('../pages/api/age-verify/wallet.js');
const { default: walletNonceRoute } = await import('../pages/api/age-verify/wallet-nonce.js');
const { default: wallDeleteRoute } = await import('../pages/api/wall/delete.js');
const { default: nciiListRoute } = await import('../pages/api/admin/ncii-reports.js');
const { default: nciiSummaryRoute } = await import('../pages/api/admin/ncii-summary.js');
const { default: reportsListRoute } = await import('../pages/api/admin/reports.js');
const { default: reportContentRoute } = await import('../pages/api/report-content.js');
const { default: reportsResolveRoute } = await import('../pages/api/admin/reports-resolve.js');
const { default: nciiResolveRoute } = await import('../pages/api/admin/ncii-reports-resolve.js');

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
async function call(route, { method = 'POST', body, query: q = {}, admin = false, user = null, ip = null, cookies = {} } = {}) {
  ipN++;
  const res = fakeRes();
  const addr = ip || `10.98.${Math.floor(ipN / 250)}.${ipN % 250}`;
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
    server_standing_pushes, conversations, reports, violations, wall_posts, favorites, notifications, login_attempts, wall_blocks restart identity`);
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
let n = 0;
async function mkCreatorUser(fields = {}) {
  n++;
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r12bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r12b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r12b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
const galleryFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'gallery', creatorId, contentType: 'image/jpeg' }));
const pathOf = (src) => src.replace('/api/media/', '');
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
const getListing = async (id) => (await query('select data from listings where id = $1', [String(id)])).rows[0].data;
const preservedPaths = async () => (await query('select pathname from media_preservations order by pathname')).rows.map((r) => r.pathname);

// ---------------------------------------------------------------------------
section('media#1: a quarantine never records an already-deleted file as evidence');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const l = await mkListing(creator.id);
  const first = await quiet(() => takeDownContent({ type: 'listing', listingId: String(l.id) }));
  check('the first (plain) takedown removes the listing', first.result === 'removed', JSON.stringify(first));
  // What deleteMediaQuietly writes after a real delete (no token here).
  const gone = pathOf(l.media[0].src);
  await query('insert into media_reaped (pathname) values ($1) on conflict do nothing', [gone]);
  const r = await ncii.addNciiReport({ category: 'minor', contentLocation: `listing ${l.id}`, description: 'x', goodFaithStatement: true });
  const again = await quiet(() => takeDownContent({ type: 'listing', listingId: String(l.id) }, { nciiReportId: String(r.id) }));
  check('a possible-minor takedown of the emptied listing is already_gone', again.result === 'already_gone', JSON.stringify(again));
  check('...and records NO preserved files', again.preserved === 0, JSON.stringify(again));
  const stored = (await query('select data from ncii_reports where id = $1', [r.id])).rows[0].data;
  check('...none on the request\'s legal record', !(stored.preservedMedia || []).length, JSON.stringify(stored.preservedMedia));
  check('...and no preservation row for the deleted file', !(await preservedPaths()).includes(gone));
  // Neighbour: a file whose deletion is only PENDING is still preserved.
  const l2 = await mkListing(creator.id);
  const pending = pathOf(l2.media[0].src);
  await query(`insert into media_uploads (pathname, status) values ($1, 'delete_pending') on conflict do nothing`, [pending]).catch(() => {});
  const r2 = await ncii.addNciiReport({ category: 'minor', contentLocation: `listing ${l2.id}`, description: 'x', goodFaithStatement: true });
  const td2 = await quiet(() => takeDownContent({ type: 'listing', listingId: String(l2.id) }, { nciiReportId: String(r2.id) }));
  check('a live listing\'s file is preserved as before', td2.result === 'removed' && td2.preserved === 1, JSON.stringify(td2));
  check('...and is on the request', ((await query('select data from ncii_reports where id = $1', [r2.id])).rows[0].data.preservedMedia || []).includes(pending));
  // Unit: preserveMedia with one reaped and one live file keeps only the live one.
  const a = galleryFile(creator.id);
  const b = galleryFile(creator.id);
  await query('insert into media_reaped (pathname) values ($1)', [pathOf(a)]);
  const kept = await preservation.preserveMedia([a, b], { reportId: 'ncii:99', reason: 't' });
  check('preserveMedia returns only files that still exist', kept.length === 1 && kept[0] === pathOf(b), JSON.stringify(kept));
  // Review fix: evidence that was MOVED to evidence/ has its original path
  // reaped by the sweep ('moved_token'), but it is still kept evidence -- a
  // second report over it must record it and extend its retention.
  const x = galleryFile(creator.id);
  const xp = pathOf(x);
  const firstKeep = await preservation.preserveMedia([x], { reportId: 'ncii:1', reason: 't' });
  check('a live file is preserved under the first report', firstKeep.length === 1 && firstKeep[0] === xp, JSON.stringify(firstKeep));
  await query(`update media_preservations set evidence_pathname = $2, moved_at = now(), retain_until = now() + interval '1 day' where pathname = $1`, [xp, `evidence/${xp}`]);
  await query('insert into media_reaped (pathname) values ($1) on conflict do nothing', [xp]);
  const secondKeep = await preservation.preserveMedia([x], { reportId: 'report:2', reason: 't' });
  check('moved-and-reaped evidence is still returned for a second report', secondKeep.length === 1 && secondKeep[0] === xp, JSON.stringify(secondKeep));
  const ru = (await query(`select retain_until > now() + interval '30 days' as extended from media_preservations where pathname = $1`, [xp])).rows[0];
  check('...and its retention is extended for that report', ru && ru.extended === true, JSON.stringify(ru));
  // Neighbour: a preservation found MISSING stays out, like any deleted file.
  await query('update media_preservations set missing_at = now() where pathname = $1', [xp]);
  const thirdKeep = await preservation.preserveMedia([x], { reportId: 'report:3', reason: 't' });
  check('a preserved file already found missing is not re-recorded', thirdKeep.length === 0, JSON.stringify(thirdKeep));
}

// ---------------------------------------------------------------------------
section('gates-token#0: the wallet door is a 404 to everything when it does not exist');
{
  delete process.env.OWNER_WALLET_ADDRESS;
  const get = await call(walletRoute, { method: 'GET' });
  check('GET with no owner wallet -> 404 (was 405)', get.statusCode === 404, `${get.statusCode} ${JSON.stringify(get.body)}`);
  const bad = await call(walletRoute, { body: { x: 'a\u0000b' } });
  check('malformed text with no owner wallet -> 404 (was 400)', bad.statusCode === 404, `${bad.statusCode} ${JSON.stringify(bad.body)}`);
  const post = await call(walletRoute, { body: { signature: '0x12' } });
  check('POST with no owner wallet -> 404', post.statusCode === 404);
  const nonceWrong = await call(walletNonceRoute, { method: 'POST' });
  check('wallet-nonce: a wrong method with no owner wallet -> 404 (was 405)', nonceWrong.statusCode === 404, String(nonceWrong.statusCode));
  process.env.OWNER_WALLET_ADDRESS = '0x000000000000000000000000000000000000dEaD';
  const get2 = await call(walletRoute, { method: 'GET' });
  check('with a wallet configured, a GET is the same 404', get2.statusCode === 404 && get2.body.error === 'Not found');
  const bad2 = await call(walletRoute, { body: { signature: 'a\u0000' } });
  check('...and malformed text too', bad2.statusCode === 404 && bad2.body.error === 'Not found');
  const nonce = await call(walletNonceRoute, { method: 'GET' });
  check('neighbour: the nonce door still works when configured', nonce.statusCode === 200 && typeof nonce.body.message === 'string', String(nonce.statusCode));
  const wrongSig = await call(walletRoute, { body: { signature: '0x1234' } });
  check('neighbour: a bad signature is still a 404', wrongSig.statusCode === 404);
  delete process.env.OWNER_WALLET_ADDRESS;
}

// ---------------------------------------------------------------------------
section('money#1: a shipped order\'s tracking can be corrected after its address is erased');
{
  await reset();
  const addr = encryptShippingAddress({ fullName: 'A B', line1: '1 Main St', city: 'X', postalCode: '1', country: 'US' });
  const mk = async (status, shippingAddress) => String((await query(
    'insert into orders (data) values ($1::jsonb) returning id',
    [JSON.stringify({ creatorId: '7', buyerId: 'b1', kind: 'physical', status, shippingAddress })],
  )).rows[0].id);
  const o = await mk('pending_shipment', addr);
  const shipped = await orders.markOrderShipped(o, '7', { carrier: 'UPS', trackingNumber: 'WRONG1' });
  check('a readable pending order ships', shipped.status === 'shipped');
  // What eraseOrderShippingAddress / a buyer's account deletion does.
  await query(`update orders set data = data || '{"shippingAddress": null}'::jsonb where id = $1`, [o]);
  let err = null;
  try { await quiet(() => orders.markOrderShipped(o, '7', { carrier: 'UPS', trackingNumber: 'RIGHT1' })); } catch (e) { err = e; }
  check('correcting the tracking of the erased, shipped order works', err === null, err && `${err.code} ${err.message}`);
  const row = (await query('select data from orders where id = $1', [o])).rows[0].data;
  check('...the new tracking number is stored', row.trackingNumber === 'RIGHT1' && row.status === 'shipped', JSON.stringify(row));
  check('...and the address stays erased', row.shippingAddress === null);
  // Neighbours: a PENDING order with no/garbled address is still refused.
  const p1 = await mk('pending_shipment', null);
  let e1 = null;
  try { await quiet(() => orders.markOrderShipped(p1, '7', { carrier: 'UPS', trackingNumber: 'T' })); } catch (e) { e1 = e; }
  check('a pending order with no address is still ADDRESS_UNREADABLE', e1 && e1.code === 'ADDRESS_UNREADABLE', e1 && e1.message);
  const p2 = await mk('pending_shipment', { line1: 'garbled' });
  let e2 = null;
  try { await quiet(() => orders.markOrderShipped(p2, '7', { carrier: 'UPS', trackingNumber: 'T' })); } catch (e) { e2 = e; }
  check('...and so is one with a garbled address', e2 && e2.code === 'ADDRESS_UNREADABLE');
  const c = await mk('closed_unfulfilled', null);
  let e3 = null;
  try { await quiet(() => orders.markOrderShipped(c, '7', { carrier: 'UPS', trackingNumber: 'T' })); } catch (e) { e3 = e; }
  check('a closed order is still refused as closed', e3 && e3.code === 'ORDER_CLOSED', e3 && e3.code);
  let e4 = null;
  try { await quiet(() => orders.markOrderShipped(o, '8', { carrier: 'UPS', trackingNumber: 'T' })); } catch (e) { e4 = e; }
  check('another creator still gets "not found"', e4 && e4.message === 'Order not found');
}

// ---------------------------------------------------------------------------
section('accounts#0: glued minor-suggestive handles and usernames are refused again');
{
  const refused = ['hotteen', 'sexyteen', 'teengirl', 'teenbabe', 'cuteteen', 'teenmodel', 'petiteteen', 'hotteenmia',
    'sexyschoolgirl', 'hotschoolgirl', 'schoolgirlmia', 'lolitababe', 'mylolita', 'littleloli', 'jailbaitbabe', 'underagebabe',
    'barelylegalbabe', 'incestlover', 'teengirls', 'youngteen', 'tinyteen', 'babyteen', 'littleteen', 'preteenmodel', 'hotschoolboy',
    'mypedophile', 'lolicongirl', 'shotaconboy', 'childpornfan', 'nonconsentplay', 'bestialityfan', 'zoophilefan', 'necrophiliac',
    'h0tteen', 't33ngirl', 'hotincest', 'x_teengirl_x'];
  for (const h of refused) {
    check(`handle refused: ${h}`, !!screenPublicText(h, { context: 'handle' }));
    check(`username refused: ${h}`, !!screenPublicText(h, { context: 'username' }));
  }
  // Every round-11 real name, and the surnames the teen rule has to leave alone.
  const names = ['steen', 'jessteen', 'hotsteen', 'kirsteen', 'christeen', 'justeen', 'mateen', 'rexteen_fan', 'cuteengineer',
    'laurapeters', 'kiaraperez', 'tarapena', 'norapearl', 'sierrapeach', 'barbarapeach', 'ClaraPerez', 'chiarapellegrini',
    'paulolima', 'danilolima', 'marcelolima', 'vincestone', 'vincesteele', 'LauraPeters', 'Vince.Stone', 'Teena', 'alex', 'maxx',
    'xavier', 'foxxy', 'sexxy', 'paigeplayford', 'babysitterjane', 'youngblood', 'hotelmodel'];
  for (const h of names) {
    check(`handle passes: ${h}`, !screenPublicText(h, { context: 'handle' }), JSON.stringify(screenPublicText(h, { context: 'handle' })));
    check(`username passes: ${h}`, !screenPublicText(h, { context: 'username' }));
  }
}

// ---------------------------------------------------------------------------
section('accounts#1: a contact app next to the platform\'s own "paid" is not fee-dodging');
{
  const S = (t) => screenPublicText(t);
  for (const t of ['Ex-Instagram model | Paid DMs open', 'Former instagram model, paid content here',
    'Found you on insta! Just paid for your set 😍', 'Paid DMs open ❤️ previews on my insta',
    'Came from TikTok and Instagram. Pay per view sets weekly', 'Instagram took my account down, so everything paid lives here now',
    'Snapchat filters are cheaper than makeup lol', 'whatsapp group? no, paid content only here', 'insta: paid dms here',
    'Telegram banned me so I only post here. Paid messages open', 'my snap is cute',
    'Just paid for your set, found you on insta', 'cheaper than insta. new sets weekly']) {
    check(`passes: ${t}`, !S(t), JSON.stringify(S(t)));
  }
  for (const t of ['pay me on insta', 'cheaper on my snap', 'payment via whatsapp', 'snap for cheaper', 'telegram payments',
    'kik me for cheaper', '$20 on snap', 'snap $20', 'send payment to my telegram', 'paying through kik is cheaper',
    // Review fix: content words between the cue and the app no longer hide it.
    'cheaper prices on my snap', 'payment accepted through my telegram', 'customs are cheaper if you message me on telegram',
    'cheaper over there on snap', 'snapchat has cheaper prices']) {
    check(`still refused: ${t}`, S(t)?.kind === 'payment', JSON.stringify(S(t)));
  }
}

section('accounts#2: arrow, emoji and "app me HANDLE" handovers are caught');
{
  const S = (t) => screenPublicText(t);
  for (const t of ['snap 👉 jessxo99', 'snap ➡️ jessxo99', 'insta 👉 jess_xo', 'my snap -> jessxo', 'snap me jess_xo',
    'snapchat me jessxo99', 'snap me at jane99', 'kik me jess99', 'telegram me jane99', 'Customs 💦 snap 👉 jessxo99',
    'snap 👉🏽 jessxo99', 'kik >> jess99', 'insta => jess_xo', 'snap ~ jessxo99', 'snap 👉 @jessxo']) {
    check(`refused: ${t}`, S(t)?.kind === 'payment', JSON.stringify(S(t)));
  }
  for (const t of ['snap me a pic', 'snap me later', 'oh snap me too', 'kik me tonight', 'snap a pic', 'Instagram: private',
    'insta 👉 link in bio', 'new set 👉 check my page', 'snap me back babe',
    // Review fix: a pointer or "me" needs a handle-LOOKING token, so ordinary
    // bios and terms of endearment are not logged as fee-dodging. The known
    // cost: "snap me jessxo" (no digit, no inner _/.) passes, as "snap
    // jessxo" always has.
    'insta → reels', 'insta -> link', 'check insta -> photos', 'snap → stories', 'snap >> tiktok', 'i love snap ~ jess',
    'snap me beautiful', 'snap me gorgeous', 'snap me cutie', 'telegram me honey', 'snap me jessxo']) {
    check(`passes: ${t}`, !S(t), JSON.stringify(S(t)));
  }
}

// ---------------------------------------------------------------------------
section('social#0: admin queues are paged in SQL; the badge has its own query; intake refuses control characters');
{
  await reset();
  for (let i = 0; i < 30; i++) {
    await ncii.addNciiReport({ category: 'third_party', contentLocation: `junk ${i}`, description: 'x', goodFaithStatement: true });
  }
  const minor = await ncii.addNciiReport({ category: 'minor', contentLocation: 'real', description: 'x', goodFaithStatement: true });
  const closed = await ncii.addNciiReport({ category: 'self', contentLocation: 'old', description: 'x', consentStatement: true });
  await ncii.updateNciiReportStatus(closed.id, 'dismiss', 'admin');
  const p1 = await call(nciiListRoute, { method: 'GET', admin: true, query: { status: 'open' } });
  check('the list answers 200', p1.statusCode === 200, JSON.stringify(p1.body).slice(0, 200));
  check('...one page of at most 25', p1.body.reports.length === 25 && p1.body.hasMore === true && typeof p1.body.nextCursor === 'string');
  check('...possible-minor filings come first, even though filed last', String(p1.body.reports[0].id) === String(minor.id), JSON.stringify(p1.body.reports[0]));
  check('...then oldest first', Number(p1.body.reports[1].id) < Number(p1.body.reports[2].id));
  check('...the summary still rides along', p1.body.summary && p1.body.summary.open === 31 && p1.body.summary.openMinor === 1, JSON.stringify(p1.body.summary));
  const p2 = await call(nciiListRoute, { method: 'GET', admin: true, query: { status: 'open', cursor: p1.body.nextCursor } });
  const seen = new Set([...p1.body.reports, ...p2.body.reports].map((r) => String(r.id)));
  check('page two has the rest, no overlap, no end', p2.body.reports.length === 6 && p2.body.hasMore === false && seen.size === 31, `${p2.body.reports.length} ${seen.size}`);
  check('the dismissed one is filtered out in SQL', !seen.has(String(closed.id)));
  const dis = await call(nciiListRoute, { method: 'GET', admin: true, query: { status: 'dismiss' } });
  check('...and appears under its own status', dis.body.reports.length === 1 && String(dis.body.reports[0].id) === String(closed.id));
  const big = await call(nciiListRoute, { method: 'GET', admin: true, query: { status: 'all', limit: '5000' } });
  check('a limit past the maximum is clamped to 50', big.body.reports.length === 32, String(big.body.reports.length));
  const junkCursor = await call(nciiListRoute, { method: 'GET', admin: true, query: { cursor: "1:1'; drop table x" } });
  check('a malformed cursor is just the first page', junkCursor.statusCode === 200 && junkCursor.body.reports.length === 25);
  const sum = await call(nciiSummaryRoute, { method: 'GET', admin: true });
  check('the badge endpoint answers on its own', sum.statusCode === 200 && sum.body.summary.open === 31, JSON.stringify(sum.body));
  const noKey = await call(nciiSummaryRoute, { method: 'GET' });
  check('...and needs the admin key', noKey.statusCode === 401 || noKey.statusCode === 403, String(noKey.statusCode));

  // Intake: C0/C1 control characters refused; tab/newline still fine.
  const base = { category: 'third_party', reporterName: 'R', reporterContact: 'r@x.test', contentLocation: 'https://x', description: 'd', goodFaithStatement: true };
  const ctl = await call(reportContentRoute, { body: { ...base, description: '\u0001'.repeat(4000) } });
  check('a control-character description is a 400', ctl.statusCode === 400 && ctl.body.field === 'description', JSON.stringify(ctl.body));
  const c1 = await call(reportContentRoute, { body: { ...base, contentLocation: 'link\u0085here' } });
  check('...C1 too', c1.statusCode === 400 && c1.body.field === 'contentLocation');
  const okText = await call(reportContentRoute, { body: { ...base, description: 'line one\nline two\ttabbed\r\n' } });
  check('tab / newline / CR still file', okText.statusCode === 200, JSON.stringify(okText.body));
  const emoji = await call(reportContentRoute, { body: { ...base, description: 'it is me 🙏 please' } });
  check('emoji and accents still file (café)', emoji.statusCode === 200);

  // Durable per-/64 count (shared by every instance): 10 accepted per half hour.
  const ip = '2001:db8:77:1::5';
  let accepted = 0;
  let refused = 0;
  for (let i = 0; i < 12; i++) {
    const r = await call(reportContentRoute, { body: { ...base, contentLocation: `x${i}` }, ip: `2001:db8:77:1::${i + 5}` });
    if (r.statusCode === 200) accepted++;
    if (r.statusCode === 429) refused++;
  }
  check('one /64 gets 10 durable filings, then 429', accepted === 10 && refused === 2, `${accepted} ${refused}`);
  const other = await call(reportContentRoute, { body: { ...base, contentLocation: 'other' }, ip: '2001:db8:77:2::1' });
  check('a different /64 in the same /48 still files', other.statusCode === 200, JSON.stringify(other.body));
  const invalid = await call(reportContentRoute, { body: { ...base, goodFaithStatement: false }, ip });
  check('an invalid filing is refused on its own merits (400), not counted', invalid.statusCode === 400);
  void ip;

  // /api/admin/reports: same SQL filter, bound and priority order.
  await query('truncate reports restart identity');
  for (let i = 0; i < 60; i++) await reportsStore.addReport({ targetType: 'wall_post', targetId: String(1000 + i), category: 'other', reason: 'spam', reporterId: 'u' });
  const nc = await reportsStore.addReport({ targetType: 'wall_post', targetId: '5', category: 'non_consensual', reason: 'nc', reporterId: 'u' });
  const mr = await reportsStore.addReport({ targetType: 'wall_post', targetId: '6', category: 'minor', reason: 'minor', reporterId: 'u' });
  const rl = await call(reportsListRoute, { method: 'GET', admin: true });
  check('reports: one page of 50', rl.statusCode === 200 && rl.body.reports.length === 50 && rl.body.hasMore === true, `${rl.statusCode} ${rl.body?.reports?.length}`);
  check('...minor first, then non-consensual', String(rl.body.reports[0].id) === String(mr.id) && String(rl.body.reports[1].id) === String(nc.id));
  check('...then newest first', Number(rl.body.reports[2].id) > Number(rl.body.reports[3].id));
  const rl2 = await call(reportsListRoute, { method: 'GET', admin: true, query: { cursor: rl.body.nextCursor } });
  const all = new Set([...rl.body.reports, ...rl2.body.reports].map((r) => String(r.id)));
  check('...page two completes it with no overlap', rl2.body.reports.length === 12 && all.size === 62 && rl2.body.hasMore === false, `${rl2.body.reports.length} ${all.size}`);
}

// ---------------------------------------------------------------------------
section('social#1: a wall comment id sent as an array is a 400, never a 500');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const fan = await mkFan();
  const post = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan.id), authorName: 'F', text: 'hi' });
  const arr = await call(wallDeleteRoute, { user: fan, body: { id: [String(post.id)] } });
  check('an array id is a 400', arr.statusCode === 400, `${arr.statusCode} ${JSON.stringify(arr.body)}`);
  const obj = await call(wallDeleteRoute, { user: fan, body: { id: { a: 1 } } });
  check('an object id is a 400', obj.statusCode === 400);
  const neg = await call(wallDeleteRoute, { user: fan, body: { id: '-5' } });
  check('a non-positive id is a 400', neg.statusCode === 400);
  const missing = await call(wallDeleteRoute, { user: fan, body: { id: '999999' } });
  check('a well-formed unknown id is still a 404', missing.statusCode === 404);
  const num = await call(wallDeleteRoute, { user: fan, body: { id: Number(post.id) } });
  check('a numeric id still deletes', num.statusCode === 200, JSON.stringify(num.body));
  const post2 = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan.id), authorName: 'F', text: 'again' });
  const str = await call(wallDeleteRoute, { user: fan, body: { id: String(post2.id) } });
  check('a string id still deletes', str.statusCode === 200);
}

// ---------------------------------------------------------------------------
section('legal-journeys#0: an in-product possible-minor report bans like a TAKE IT DOWN resolve');
{
  await reset();
  const { creator } = await mkCreatorUser({ founding: true });
  const fan = await mkFan();
  const reported = await mkListing(creator.id);
  const paid = await mkListing(creator.id);
  await query('insert into orders (data) values ($1::jsonb)', [JSON.stringify({
    listingId: String(paid.id), buyerId: String(fan.id), creatorId: String(creator.id), kind: 'digital', status: 'fulfilled', createdAt: new Date().toISOString(),
  })]);
  const g = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g }, []);
  const rep = await reportsStore.addReport({
    targetType: 'listing', targetId: String(reported.id), category: 'minor', reason: 'looks under 18', reporterId: String(fan.id),
    reportedContent: reportsStore.snapshotListing(reported),
  });
  const res = await call(reportsResolveRoute, { admin: true, body: { id: String(rep.id), action: 'remove_and_ban' } });
  check('remove_and_ban answers 200', res.statusCode === 200, JSON.stringify(res.body));
  check('...naming the banned creator', String(res.body.bannedCreatorId) === String(creator.id));
  const c = (await query('select data from creators where id = $1', [String(creator.id)])).rows[0].data;
  check('the creator is banned outright, founding revoked', c.status === 'banned' && c.founding === false, JSON.stringify({ s: c.status, f: c.founding }));
  const paidAfter = await getListing(paid.id);
  check('the OTHER, paid listing is down WITHOUT keepPaid (files no longer served)', paidAfter.status === 'removed' && !!paidAfter.mediaDeletedAt, JSON.stringify(paidAfter));
  const kept = await preservedPaths();
  check('the gallery photo is quarantined as evidence', kept.includes(pathOf(g)), JSON.stringify(kept));
  check('...and so are both listings\' files', kept.includes(pathOf(paid.media[0].src)) && kept.includes(pathOf(reported.media[0].src)));
  const refs = (await query(`select distinct report_id from media_preservations`)).rows.map((r) => r.report_id);
  check('...keyed to the in-product report', refs.length === 1 && refs[0] === `report:${rep.id}`, JSON.stringify(refs));
  // Review fix: the reported listing's file is preserved by both steps and is
  // counted once -- the answer is the number of distinct files kept.
  check('the preserved count is distinct files, not a double-count', res.body.preserved === kept.length, JSON.stringify({ preserved: res.body.preserved, kept }));
  const stored = await reportsStore.getReportById(String(rep.id));
  check('the report is actioned and records the ban', stored.status === 'actioned' && String(stored.bannedCreatorId) === String(creator.id));
  const push = (await query('select count(*)::int as n from server_standing_pushes')).rows[0].n;
  check('the new standing was queued for server/', push >= 1, String(push));

  // Refusals: not a minor report; a fan's comment; already resolved.
  const { creator: c2 } = await mkCreatorUser();
  const l3 = await mkListing(c2.id);
  const other = await reportsStore.addReport({ targetType: 'listing', targetId: String(l3.id), category: 'other', reason: 'spam', reporterId: String(fan.id) });
  const notMinor = await call(reportsResolveRoute, { admin: true, body: { id: String(other.id), action: 'remove_and_ban' } });
  check('a non-minor report cannot remove_and_ban', notMinor.statusCode === 400 && notMinor.body.code === 'not_minor', JSON.stringify(notMinor.body));
  check('...and nothing was taken down', (await getListing(l3.id)).status === 'active');
  const post = await wall.addWallPost({ creatorId: String(c2.id), authorId: String(fan.id), authorName: 'F', text: 'x' });
  const fanRep = await reportsStore.addReport({ targetType: 'wall_post', targetId: String(post.id), category: 'minor', reason: 'x', reporterId: 'someone',
    reportedContent: { type: 'wall_post', authorId: String(fan.id) } });
  const noCreator = await call(reportsResolveRoute, { admin: true, body: { id: String(fanRep.id), action: 'remove_and_ban' } });
  check('a fan\'s comment has no creator to ban (400 no_creator)', noCreator.statusCode === 400 && noCreator.body.code === 'no_creator', JSON.stringify(noCreator.body));
  check('...and the comment is still there, report still open',
    (await wall.getWallPostById(post.id)) !== null && (await reportsStore.getReportById(String(fanRep.id))).status === 'open');
  const again = await call(reportsResolveRoute, { admin: true, body: { id: String(rep.id), action: 'remove_and_ban' } });
  check('an already-resolved report is a 409', again.statusCode === 409);
  // A creator's own wall comment: the author IS a creator.
  const { creator: c3, user: u3 } = await mkCreatorUser();
  const post3 = await wall.addWallPost({ creatorId: String(c2.id), authorId: String(u3.id), authorName: 'C', text: 'x' });
  const crRep = await reportsStore.addReport({ targetType: 'wall_post', targetId: String(post3.id), category: 'minor', reason: 'x', reporterId: 'someone' });
  const crRes = await call(reportsResolveRoute, { admin: true, body: { id: String(crRep.id), action: 'remove_and_ban' } });
  check('a creator-authored comment bans that creator', crRes.statusCode === 200 && String(crRes.body.bannedCreatorId) === String(c3.id), JSON.stringify(crRes.body));
  check('...and the comment is gone', (await wall.getWallPostById(post3.id)) === null);
  // Neighbour: plain remove_content still bans nobody.
  const { creator: c4 } = await mkCreatorUser();
  const l4 = await mkListing(c4.id);
  const rep4 = await reportsStore.addReport({ targetType: 'listing', targetId: String(l4.id), category: 'minor', reason: 'x', reporterId: 'u' });
  const rc = await call(reportsResolveRoute, { admin: true, body: { id: String(rep4.id), action: 'remove_content' } });
  check('remove_content still removes without banning', rc.statusCode === 200 && (await creators.getCreatorById(String(c4.id))).status === 'active', JSON.stringify(rc.body));

  // Regression: the refactored NCII possible-minor resolve still bans the same way.
  const { creator: c5 } = await mkCreatorUser();
  const l5 = await mkListing(c5.id);
  const nr = await ncii.addNciiReport({ category: 'minor', contentLocation: 'x', description: 'x', goodFaithStatement: true });
  const nres = await call(nciiResolveRoute, { admin: true, body: { id: String(nr.id), action: 'removed', creatorId: String(c5.id) } });
  check('the NCII possible-minor resolve still bans outright', nres.statusCode === 200 && nres.body.outrightBan === true
    && (await creators.getCreatorById(String(c5.id))).status === 'banned', JSON.stringify(nres.body));
  check('...and its listing is down with its files quarantined', !!(await getListing(l5.id)).mediaDeletedAt
    && (await preservedPaths()).includes(pathOf(l5.media[0].src)));
  const nstored = (await query('select data from ncii_reports where id = $1', [nr.id])).rows[0].data;
  check('...recorded on the request', (nstored.preservedMedia || []).includes(pathOf(l5.media[0].src)) && nstored.preservedCount >= 1, JSON.stringify(nstored.preservedMedia));
}

void withTransaction;
for (const f of failures) console.log('  FAILED:', f);
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
