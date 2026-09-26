// Regression tests for the round-15 backend fixes (package R15B), run against a
// real scratch Postgres (it truncates tables). Every fix is tested in both
// directions (the bug, and its nearest harmless neighbours):
//  - media#0 / social#0: a LISTING takedown commits its moderation_actions row
//    and the request's `takedowns` entry with the removal, before any file is
//    deleted;
//  - money#0 / public-pages#0 / legal-journeys#1: the carrier is a fixed list
//    and the tracking number a per-carrier format, so a phone number, a handle
//    or an app name cannot ride in them (and suspected handovers are logged);
//  - money#1 / dashboard#0: first shipments are not rate-limited; only
//    corrections that will be written count;
//  - dashboard#1: the creator's order view carries trackingCorrectionsLeft;
//  - legal-journeys#2: no notification is recorded for a deleted buyer;
//  - accounts#0: a minor age next to a sexual word is refused through the real
//    profile route in tags, display name and bio (the full corpus is
//    lib/screen-corpus.test.mjs);
//  - accounts#1/#2: "follow me on IG" after a price passes; "I’ll" with a curly
//    apostrophe is read as "i'll";
//  - accounts#3: a website over 200 characters is refused, not truncated;
//  - srv-auth-core#1: the outbox log names the by-site-uid lookup first.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r15b.test.mjs

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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r15b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r15b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
if (!process.env.ORDERS_ENCRYPTION_KEY) process.env.ORDERS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

// del() records what the database held at the moment a file was deleted: the
// takedown's audit row must already be committed by then.
const delObserved = [];
let delProbe = null;
const realBlob = await import('@vercel/blob');
mock.module('@vercel/blob', {
  namedExports: {
    ...realBlob,
    head: async () => ({ contentType: 'image/jpeg', size: 1024 }),
    del: async (p) => { if (delProbe) delObserved.push(await delProbe(p)); },
  },
});

const { query, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const orders = await import('./orders-store.js');
const ncii = await import('./ncii-reports-store.js');
const rules = await import('./tracking-rules.js');
const outbox = await import('./standing-outbox.js');
const { detectPaymentCircumvention } = await import('./payment-circumvention-filter.js');
const { invalidSocialHandles, sanitizeSocials, SOCIAL_WEBSITE_MAX } = await import('./creator-status.js');
const { takeDownContent } = await import('./content-takedown.js');
const { encryptShippingAddress } = await import('./crypto.js');
const { createSessionToken } = await import('./session.js');
const { default: profileRoute } = await import('../pages/api/me/profile.js');
const { default: adminProfileRoute } = await import('../pages/api/admin/profile.js');
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
async function call(route, { method = 'POST', body, query: q = {}, admin = false, user = null } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = {};
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  const cookieJar = {};
  if (user) cookieJar.oa_session = createSessionToken(user.id, user.sessionVersion || 0);
  if (Object.keys(cookieJar).length) headers.cookie = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  const req = { method, body, query: q, headers, cookies: cookieJar, socket: { remoteAddress: `10.97.${Math.floor(ipN / 250)}.${ipN % 250}` } };
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r15bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r15b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r15b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}

// ---------------------------------------------------------------------------
section('media#0 / social#0: a listing takedown commits its record before any file is deleted');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const l = await mkListing(creator.id);
  const r = await ncii.addNciiReport({ category: 'self', contentLocation: 'listing', description: 'x', consentStatement: true });
  delObserved.length = 0;
  delProbe = async () => {
    const actions = (await query(`select count(*)::int as n from moderation_actions where data->>'action' = 'content_takedown'`)).rows[0].n;
    const td = (await query('select data->\'takedowns\' as t from ncii_reports where id = $1', [r.id])).rows[0].t;
    return { actions, takedowns: Array.isArray(td) ? td.length : 0 };
  };
  // A token so deleteMediaQuietly reaches del() (the mock above; nothing is sent).
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_r15b';
  const out = await quiet(() => takeDownContent({ type: 'listing', listingId: String(l.id) }, { nciiReportId: String(r.id) }));
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delProbe = null;
  check('the takedown removes the listing', out.result === 'removed' && !!out.actionId, JSON.stringify(out));
  check('...files were deleted after the commit', delObserved.length >= 1, JSON.stringify(delObserved));
  check('...and the audit row was already committed when they were', delObserved.every((o) => o.actions === 1), JSON.stringify(delObserved));
  check('...as was the request\'s takedown entry', delObserved.every((o) => o.takedowns === 1), JSON.stringify(delObserved));
  const actionRow = (await query('select id, data from moderation_actions')).rows;
  check('exactly one audit row, with the listing snapshot', actionRow.length === 1 && actionRow[0].data.snapshot && String(actionRow[0].id) === out.actionId,
    JSON.stringify(actionRow));
  const tds = (await query('select data->\'takedowns\' as t from ncii_reports where id = $1', [r.id])).rows[0].t;
  check('the request records a "removed" takedown with the action id', tds.length === 1 && tds[0].result === 'removed' && tds[0].actionId === out.actionId,
    JSON.stringify(tds));
  const again = await quiet(() => takeDownContent({ type: 'listing', listingId: String(l.id) }, { nciiReportId: String(r.id) }));
  check('a retry answers already_gone and records it too', again.result === 'already_gone'
    && (await query('select count(*)::int as n from moderation_actions')).rows[0].n === 2);

  // Neighbours: an unattributed takedown and a possible-minor quarantine still work.
  const l2 = await mkListing(creator.id);
  const plain = await quiet(() => takeDownContent({ type: 'listing', listingId: String(l2.id) }));
  check('an unattributed listing takedown still removes and records', plain.result === 'removed' && !!plain.actionId && plain.reportRef === null);
  const l3 = await mkListing(creator.id);
  const minor = await ncii.addNciiReport({ category: 'minor', contentLocation: 'listing', description: 'x', goodFaithStatement: true });
  const q = await quiet(() => takeDownContent({ type: 'listing', listingId: String(l3.id) }, { nciiReportId: String(minor.id) }));
  check('a possible-minor takedown quarantines the files and records', q.result === 'removed' && q.preserved >= 1 && !!q.actionId, JSON.stringify(q));
  const missing = await quiet(() => takeDownContent({ type: 'listing', listingId: '999999' }, { nciiReportId: String(r.id) }));
  check('a missing listing is already_gone, still recorded', missing.result === 'already_gone' && !!missing.actionId);
  let nf = null;
  try { await quiet(() => takeDownContent({ type: 'listing', listingId: String(l2.id) }, { nciiReportId: '424242' })); } catch (e) { nf = e; }
  check('an unknown request id is still refused', nf && nf.code === ncii.NCII_REPORT_NOT_FOUND);
}

// ---------------------------------------------------------------------------
section('money#0 / public-pages#0 / legal-journeys#1: tracking fields are structured, not free text');
{
  const E = (carrier, trackingNumber) => rules.trackingFieldsError({ carrier, trackingNumber });
  // Round 16 (money#0/#1, dashboard#0/#1): the per-carrier formats, check
  // digits and phone-number heuristics refused real tracking numbers and
  // logged their creators as fee-dodgers, so they are gone. Rows that only
  // those rules refused -- phone-shaped digits, padded phones, a 1Z number
  // with WA/IG after it, wrong check digits, lengths outside one carrier's
  // usual format -- moved to the 'now accepted' list below; the rest stay.
  for (const [c, t] of [
    ['UPS', 'whatsapp 44 7700 900123'], ['UPS', 'snapchat jessxo 1'], ['UPS', 'instagram jess 22'], ['UPS', 'telegram jess 22'],
    ['UPS', 'discord jess 1'], ['UPS', 'wickr jess 1'], ['USPS', 'jessxo 2'],
    ['USPS', 'jessxo2'], ['USPS', 'ig jessxo 1'], ['USPS', 'tg jess 99'],
    ['Other', 'SNAP12345678'],
    ['Other', 'WHATSAPP447700900123'], ['UPS', '1Z999AA1012345678'],
    ['UPS', '1ZINSTAJESS1234567'], ['UPS', '1ZSNAPJESSXO123456'], ['UPS', '1ZCASHAPPJESS12345'],
    ['UPS', '1ZKIK00012345678901'],
  ]) {
    const e = E(c, t);
    check(`refused: ${c} | ${t}`, e?.field === 'trackingNumber', JSON.stringify(e));
  }
  for (const [c, t] of [
    ['USPS', '617 555 1234'], ['FedEx', '6175551234'], ['Other', '617 555 1234'], ['Other', '1 617 555 1234'],
    ['Other', 'IG6175551234'], ['Other', '07700900123'], ['UPS', '617-555-1234'], ['FedEx', '1234567890123'],
    ['UPS', '1ZWA6175551234 0000'], ['USPS', '61755512340000000000'], ['USPS', '0000617555123400000'],
    ['FedEx', '000000617555123400'], ['Other', '617555123412'], ['Other', 'AB6175551234'],
    ['UPS', '1Z999AA10123456785'], ['USPS', '9405511899223197428491'], ['USPS', 'EA123456789US'], ['FedEx', '748912345678'],
    ['Other', 'RR123456789GB'],
  ]) {
    check(`now accepted (round 16): ${c} | ${t}`, !E(c, t), JSON.stringify(E(c, t)));
  }
  // Round 17 (money#0, dashboard#1): a letter run is no longer refused (real
  // DHL Parcel / PostNL / UPS numbers hold them), and a well-formed 1Z number
  // is not read for the SHORT app names inside its shipper + service
  // segment ('1Z SNAP12 03...'); a whole long name there is still refused.
  for (const [c, t] of [['Other', 'jessxo 12345678'], ['UPS', '1Z SNAP12 03 12345678'], ['Other', 'JESS61755512340'],
    ['Other', 'ONLY12345678FANS'], ['Other', 'PAYP123456789']]) {
    check(`now accepted (round 17): ${c} | ${t}`, !E(c, t), JSON.stringify(E(c, t)));
  }
  for (const [c, t] of [['Other', 'SNAP12345678'], ['UPS', '1ZWHATSAPPJ1234567'], ['UPS', '1ZSNAPJESSXO123456'], ['UPS', '1Z WHATSAPP 12345678'],
    ['UPS', '1ZINSTAJESS1234567'], ['UPS', 'whatsapp 44 7700 900123']]) {
    check(`...and flagged as a suspected handover: ${t}`, E(c, t)?.suspicious === true);
  }
  // Round 16: only an app name is logged; a word or a malformed number is a typo.
  for (const [c, t] of [['USPS', 'jessxo2'], ['Other', 'jess@x.co 12345678'], ['UPS', '1Z999AA1012345678']]) {
    check(`...refused but NOT flagged: ${t}`, E(c, t) && !E(c, t).suspicious, JSON.stringify(E(c, t)));
  }
  check('a typo is not flagged as a handover', !E('UPS', '1Z999AA1012345678')?.suspicious && !E('UPS', '1Z999AA10123456785')?.suspicious);
  for (const [c, t] of [
    ['USPS', '9405 5118 9922 3197 4284 90'], ['USPS', '9400111899223197428497'], ['USPS', 'EA123456785US'], ['usps', '9200190175547700000005'],
    ['UPS', '1Z999AA10123456784'], ['ups', '1z 999 aa1 0123 4567 84'], ['FedEx', '7489 1234 5679'], ['FedEx', '123456789012345'],
    ['DHL', '1234567890'], ['DHL', '12345678901'], ['DHL', 'JD014600006281230704'], ['Other', 'RR123456785GB'], ['Other', 'GM2951173225174494'],
    ['Other', '7777000012345678'], ['Other', 'CP123456785CA'], ['Other', 'LX123456785SC'],
    // Real numbers with their check digits (UPS mod-10, USPS GS1 mod-10, FedEx mod-11, S10 mod-11).
    ['UPS', '1Z12345E6605272234'], ['USPS', '9361289878700317633795'], ['USPS', '70160910000108310009'], ['USPS', '03071790000523483741'],
    ['FedEx', '986578788855'], ['FedEx', '477179081230'], ['FedEx', '041441760228964'], ['FedEx', '9611020987654312345672'],
    ['Other', 'TBA123456789012'], ['Other', 'C12345678901234'], ['Other', 'LX12345678'], ['Other', 'RB123456785GB'],
  ]) {
    check(`accepted: ${c} | ${t}`, !E(c, t), JSON.stringify(E(c, t)));
  }
  for (const c of ['Snap', 'Tele gram', 'WhatsApp', 'Cash-App', 'kik', 'text']) {
    const e = E(c, '1Z999AA10123456784');
    check(`an app as the carrier is refused and flagged: ${c}`, e?.field === 'carrier' && e.suspicious === true, JSON.stringify(e));
  }
  check('a real carrier off the list is refused, not flagged', E('Royal Mail', 'RR123456785GB')?.field === 'carrier' && !E('Royal Mail', 'RR123456785GB').suspicious);
  const norm = rules.normalizeTracking({ carrier: ' fedex ', trackingNumber: '7489-1234 5679' });
  check('normalizeTracking stores the canonical carrier and the compact number', norm.carrier === 'FedEx' && norm.trackingNumber === '748912345679', JSON.stringify(norm));
  check('the carrier list is exported for the dashboard', rules.SHIPPING_CARRIERS.join() === 'USPS,UPS,FedEx,DHL,Other' && orders.SHIPPING_CARRIERS === rules.SHIPPING_CARRIERS);

  await reset();
  const { creator, user } = await mkCreatorUser();
  const fan = await mkFan();
  const addr = encryptShippingAddress({ fullName: 'A B', line1: '1 Main St', city: 'X', postalCode: '1', country: 'US' });
  const mkOrder = async (buyerId = String(fan.id)) => String((await query('insert into orders (data) values ($1::jsonb) returning id',
    [JSON.stringify({ creatorId: String(creator.id), buyerId, title: 'Signed poster', kind: 'physical', status: 'pending_shipment', shippingAddress: addr })])).rows[0].id);
  const o = await mkOrder();
  const ship = (carrier, trackingNumber, orderId = o) => call(shipRoute, { user, body: { orderId, carrier, trackingNumber } });
  // Round 16: a phone-shaped number is no longer refused (see above); a word
  // is refused as a typo and NOT logged; an app name is refused and logged.
  const word = await ship('USPS', 'jessxo2');
  check('the route refuses a handle under USPS (400, trackingNumber)', word.statusCode === 400 && word.body.field === 'trackingNumber', JSON.stringify(word.body));
  check('...without logging a violation', (await query('select count(*)::int as n from violations')).rows[0].n === 0);
  const wa = await ship('UPS', 'whatsapp 44 7700 900123');
  check('...and an app + number under UPS', wa.statusCode === 400 && wa.body.field === 'trackingNumber');
  const handle = await ship('Other', 'SNAP12345678');
  check('...and an app name + digits under Other', handle.statusCode === 400 && handle.body.field === 'trackingNumber');
  const viol = (await query('select data from violations order by id')).rows.map((r) => r.data.context);
  check('the suspected handovers are logged as order_tracking_shape', viol.filter((c) => c === 'order_tracking_shape').length === 2, JSON.stringify(viol));
  check('none of that shipped the order', (await query(`select data->>'status' as s from orders where id = $1`, [o])).rows[0].s === 'pending_shipment');
  const ok = await ship('ups', '1z999aa1 0123 4567 84');
  check('a real UPS number ships, stored canonical', ok.statusCode === 200 && ok.body.order.carrier === 'UPS' && ok.body.order.trackingNumber === '1Z999AA10123456784',
    JSON.stringify(ok.body));
}

// ---------------------------------------------------------------------------
section('money#1 / dashboard#0 / dashboard#1: first shipments are not limited; corrections are; the count is exposed');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const fan = await mkFan();
  const addr = encryptShippingAddress({ fullName: 'A B', line1: '1 Main St', city: 'X', postalCode: '1', country: 'US' });
  const mkOrder = async () => String((await query('insert into orders (data) values ($1::jsonb) returning id',
    [JSON.stringify({ creatorId: String(creator.id), buyerId: String(fan.id), title: 'Print', kind: 'physical', status: 'pending_shipment', shippingAddress: addr })])).rows[0].id);
  const ids = [];
  for (let i = 0; i < 45; i++) ids.push(await mkOrder());
  const ship = (orderId, trackingNumber, carrier = 'FedEx') => call(shipRoute, { user, body: { orderId, carrier, trackingNumber } });
  let firstOk = 0;
  for (let i = 0; i < ids.length; i++) {
    const r = await ship(ids[i], String(100000000000000 + i));
    if (r.statusCode === 200) firstOk++;
  }
  check('all 45 first shipments go through in one session', firstOk === 45, String(firstOk));
  // A few typos and same-value re-saves burn nothing.
  for (let i = 0; i < 10; i++) await ship(ids[0], 'bad');
  for (let i = 0; i < 10; i++) await ship(ids[0], String(100000000000000));
  let view = (await orders.getOrdersForCreator(creator.id)).find((x) => String(x.id) === ids[0]);
  check('the creator view carries trackingCorrectionsLeft = 3 after the first ship', view.trackingCorrectionsLeft === 3 && !('trackingHistory' in view),
    JSON.stringify(view));
  // 30 corrections across ten orders (3 each), then the 31st is limited.
  let corrOk = 0;
  for (let k = 0; k < 10; k++) {
    for (let j = 1; j <= 3; j++) {
      const r = await ship(ids[k], String(200000000000000 + k * 10 + j));
      if (r.statusCode === 200) corrOk++;
    }
  }
  check('30 corrections are accepted', corrOk === 30, String(corrOk));
  view = (await orders.getOrdersForCreator(creator.id)).find((x) => String(x.id) === ids[0]);
  check('...and an order with all three used shows 0 left', view.trackingCorrectionsLeft === 0, JSON.stringify(view));
  const capped = await ship(ids[0], '150000000000009');
  check('a correction past the per-order cap is still a 409, not a rate limit', capped.statusCode === 409 && capped.body.code === orders.TRACKING_EDIT_LIMIT,
    JSON.stringify(capped.body));
  const limited = await ship(ids[10], '300000000000001');
  check('the 31st correction in the hour is a 429', limited.statusCode === 429, JSON.stringify(limited.body));
  const pendingOrder = await mkOrder();
  const firstAfter = await ship(pendingOrder, '400000000000001');
  check('...while a first shipment still goes through', firstAfter.statusCode === 200, JSON.stringify(firstAfter.body));
}

// ---------------------------------------------------------------------------
section('legal-journeys#2: no notification is recorded for a deleted buyer');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const fan = await mkFan();
  const ghostId = crypto.randomUUID();
  const addr = encryptShippingAddress({ fullName: 'A B', line1: '1 Main St', city: 'X', postalCode: '1', country: 'US' });
  const mk = async (buyerId) => String((await query('insert into orders (data) values ($1::jsonb) returning id',
    [JSON.stringify({ creatorId: String(creator.id), buyerId, title: 'Print', kind: 'physical', status: 'pending_shipment', shippingAddress: addr })])).rows[0].id);
  const gone = await mk(ghostId);
  const live = await mk(String(fan.id));
  const r1 = await call(shipRoute, { user, body: { orderId: gone, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' } });
  const r2 = await call(shipRoute, { user, body: { orderId: gone, carrier: 'UPS', trackingNumber: '1Z999AA10123456793' } });
  // Round 16 (legal-journeys#0): it ships, and at that moment the deleted
  // buyer's address and tracking number are erased. Round 17 (money#2): the
  // seller's correction is accepted like any other, but only into the
  // seller-side copy -- nothing is written back into the erased buyer copy.
  check('an order whose buyer was deleted still ships', r1.statusCode === 200, JSON.stringify(r1.body));
  check('...its tracking is erased at once; a correction touches only the seller copy', r2.statusCode === 200
    && (await query('select data from orders where id = $1', [gone])).rows[0].data.trackingNumber === null, JSON.stringify(r2.body));
  check('...with no notification row for the deleted uid', (await query('select count(*)::int as n from notifications where user_id = $1', [ghostId])).rows[0].n === 0);
  await call(shipRoute, { user, body: { orderId: live, carrier: 'UPS', trackingNumber: '1Z999AA10123456800' } });
  check('a live buyer is still notified', (await query('select count(*)::int as n from notifications where user_id = $1', [String(fan.id)])).rows[0].n === 1);
}

// ---------------------------------------------------------------------------
section('accounts#0: minor age + sexual word refused through the real profile route, every field');
{
  await reset();
  const { user } = await mkCreatorUser();
  for (const [field, value] of [['tags', 'sixteenslut, 16slut'], ['tags', 'cosplay, Sixteen Slut'], ['name', 'Sixteen Slut'],
    ['bio', 'horny sixteen slut here'], ['location', 'fifteenporn city'], ['name', '16 slut']]) {
    const r = await call(profileRoute, { user, body: { fields: { [field]: value } } });
    check(`${field} "${value}" is refused`, r.statusCode === 400, JSON.stringify(r.body));
  }
  const handle = await call(profileRoute, { user, body: { fields: { handle: '@slutsixteen' } } });
  check('the reverse glued order is refused as a handle', handle.statusCode === 400, JSON.stringify(handle.body));
  for (const [field, value] of [['tags', 'nineteen, cosplay, sweet sixteen'], ['name', 'Kirsteen Dickson'], ['location', 'Essex Ten'],
    ['bio', 'Top 10 sex toys reviewed, 15 nudes for $30']]) {
    const r = await call(profileRoute, { user, body: { fields: { [field]: value } } });
    check(`${field} "${value}" still saves`, r.statusCode === 200, JSON.stringify(r.body));
  }
  const v = (await query(`select data from violations`)).rows.map((r) => r.data.context);
  check('the refusals are logged', v.length >= 6, JSON.stringify(v));
}

// ---------------------------------------------------------------------------
section('accounts#1 / accounts#2: promotion after a price passes; a curly apostrophe still bridges');
{
  for (const t of ['Customs from $20 and follow me on IG', 'Sets from $9 and follow me on insta!', 'Tip $5 and follow me on instagram',
    'Pics $5 each and follow me on ig for teasers', 'just tipped $5 and followed you on insta', 'Sets from $12 and check me out on insta']) {
    check(`passes: ${t}`, !detectPaymentCircumvention(t).flagged, JSON.stringify(detectPaymentCircumvention(t).reasons));
  }
  for (const t of ['$20 and join me on telegram', 'pay $20 and see u on snap', 'pay 20 and I’ll send on snap', 'pay $20 and I’ll add you on snap',
    'pay 20 and Iʼll send on snap', "pay 20 and i'll send on snap"]) {
    check(`still refused: ${t}`, detectPaymentCircumvention(t).flagged);
  }
  await reset();
  const { user } = await mkCreatorUser();
  const bio = await call(profileRoute, { user, body: { fields: { bio: 'Custom sets from $20 and follow me on IG for previews' } } });
  check('the bio from the finding saves', bio.statusCode === 200, JSON.stringify(bio.body));
  check('...and logs no violation', (await query('select count(*)::int as n from violations')).rows[0].n === 0);
}

// ---------------------------------------------------------------------------
section('accounts#3: a website over 200 characters is refused, not truncated');
{
  const long = `https://example.com/${'a'.repeat(SOCIAL_WEBSITE_MAX)}`;
  const exact = `https://example.com/${'b'.repeat(SOCIAL_WEBSITE_MAX - 20)}`;
  check('the limit is 200', SOCIAL_WEBSITE_MAX === 200 && exact.length === 200);
  const bad = invalidSocialHandles({ website: long });
  check('invalidSocialHandles refuses the long link', bad.length === 1 && bad[0].key === 'website', JSON.stringify(bad));
  check('...and accepts one of exactly 200', invalidSocialHandles({ website: exact }).length === 0);
  check('sanitizeSocials keeps a 200-character link whole', sanitizeSocials({ website: exact }).website === exact);
  await reset();
  const { creator, user } = await mkCreatorUser();
  const r = await call(profileRoute, { user, body: { fields: { socials: { website: long } } } });
  check('the profile route answers 400 naming the field', r.statusCode === 400 && r.body.field === 'social_website', JSON.stringify(r.body));
  const a = await call(adminProfileRoute, { admin: true, body: { creatorId: String(creator.id), fields: { socials: { website: long } } } });
  check('...and so does the admin route', a.statusCode === 400, JSON.stringify(a.body));
  const stored = await creators.getCreatorById(creator.id);
  check('...and nothing truncated was stored', !stored.socials?.website, JSON.stringify(stored.socials));
  const good = await call(profileRoute, { user, body: { fields: { socials: { website: exact } } } });
  check('a 200-character link saves whole', good.statusCode === 200 && (await creators.getCreatorById(creator.id)).socials.website === exact,
    JSON.stringify(good.body));
}

// ---------------------------------------------------------------------------
section('srv-auth-core#1: the outbox log tells the operator to look the server id up first');
{
  await reset();
  const uid = crypto.randomUUID();
  await outbox.enqueueStandingPushes([{ uid, status: 'active', role: 'creator' }]);
  const logged = [];
  const saved = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await outbox.deliverStandingPushes({
      uids: [uid],
      fetchImpl: async () => new Response(JSON.stringify({ error: outbox.BAN_NEEDS_SERVER_ADMIN }), { status: 409, headers: { 'content-type': 'application/json' } }),
    });
  } finally {
    console.error = saved;
  }
  const line = logged.find((l) => l.includes(uid)) || '';
  check('the log names GET /admin/users/by-site-uid/<uid> first', line.includes(`GET /admin/users/by-site-uid/${uid}`)
    && line.indexOf('by-site-uid') < line.indexOf('/status'), line);
  const pending = await outbox.listPendingStandingPushes();
  check('...and the row stays flagged needsServerAdmin', pending.length === 1 && pending[0].needsServerAdmin === true, JSON.stringify(pending));
}

for (const f of failures) console.log('  FAILED:', f);
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
