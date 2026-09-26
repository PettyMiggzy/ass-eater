// Regression tests for the round-14 backend fixes (package R14B), run against a
// real scratch Postgres (it truncates tables). Every fix is tested in both
// directions (the bug, and its nearest harmless neighbours):
//  - accounts#0: spelled minor ages glued to a sexual word ("sixteenslut") are
//    refused in name mode; adult ages ("nineteenslut") and real names pass;
//  - accounts#1: porn-category descriptors glued to "teen"/"loli"
//    ("asianteen", "legalteen", "teenanal", "animeloli") are refused in name
//    mode; the real-name corpus still passes;
//  - accounts#2: the price-to-app bridge catches the round-12 handover
//    phrasings again; the round-13 false positives still pass;
//  - accounts#3: a website without https:// is refused with a field, not
//    silently dropped;
//  - gates-token#0: login/signup refuse a cross-site form POST;
//  - public-pages#0 / dashboard#0 / dashboard#1: ship-route screening and
//    charset, tracking history + correction cap, buyer notifications;
//  - media#0: a DM / wall-comment takedown never removes the item without its
//    audit copy committing with it;
//  - social#0 / admin-ui#0: an unknown `before` in the admin thread lookup is
//    a stale-cursor signal (409), not a silent last page;
//  - social#1: the admin conversation list is keyset-paged.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r14b.test.mjs

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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r14b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r14b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
if (!process.env.ORDERS_ENCRYPTION_KEY) process.env.ORDERS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const realBlob = await import('@vercel/blob');
mock.module('@vercel/blob', {
  namedExports: { ...realBlob, head: async () => ({ contentType: 'image/jpeg', size: 1024 }) },
});

const { query, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const users = await import('./users-store.js');
const orders = await import('./orders-store.js');
const wall = await import('./wall-store.js');
const ncii = await import('./ncii-reports-store.js');
const { screenPublicText } = await import('./prohibited-terms.js');
const { detectPaymentCircumvention } = await import('./payment-circumvention-filter.js');
const { invalidSocialHandles, sanitizeSocials } = await import('./creator-status.js');
const { crossSiteReason } = await import('./same-origin.js');
const { takeDownContent, lookupConversation, lookupConversationsFor } = await import('./content-takedown.js');
const { encryptShippingAddress } = await import('./crypto.js');
const { createSessionToken } = await import('./session.js');
const { default: lookupRoute } = await import('../pages/api/admin/content-lookup.js');
const { default: profileRoute } = await import('../pages/api/me/profile.js');
const { default: adminProfileRoute } = await import('../pages/api/admin/profile.js');
const { default: loginRoute } = await import('../pages/api/auth/login.js');
const { default: signupRoute } = await import('../pages/api/auth/signup.js');
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
const errOf = async (fn) => { try { await quiet(fn); return null; } catch (e) { return e; } };
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
async function call(route, { method = 'POST', body, query: q = {}, admin = false, user = null, headers: extra = {} } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = { ...extra };
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  const cookieJar = {};
  if (user) cookieJar.oa_session = createSessionToken(user.id, user.sessionVersion || 0);
  if (Object.keys(cookieJar).length) headers.cookie = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  const req = { method, body, query: q, headers, cookies: cookieJar, socket: { remoteAddress: `10.98.${Math.floor(ipN / 250)}.${ipN % 250}` } };
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r14bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r14b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r14b.test`, password: 'password123', role: 'fan' });
}

// ---------------------------------------------------------------------------
// The name-mode corpus (accounts#0, accounts#1). Must-flag: every string from
// the round-14 findings plus the round-11..13 name-mode must-flag strings.
// Must-pass: every real name and ordinary handle those rounds protect.
const NAME_MUST_FLAG = [
  // accounts#0 (spelled minor ages)
  'sixteenslut', 'fifteenporn', 'thirteensex', 'seventeenpussy', 'fourteenslut', 'SixteenSlut', 'sixteen_slut', 'slut.fifteen',
  'twelveporn', 'ten_slut', 'Sixteen Slut', 'slut fifteen', 'twelve_sluts', 'porn.twelve',
  // accounts#1 (descriptors, "a" tails, loli leads)
  'asianteen', 'ebonyteen', 'latinateen', 'legalteen', 'legalteens', 'blondeteen', 'amateurteen', 'thickteen', 'curvyteen',
  'chubbyteen', 'redheadteen', 'gingerteen', 'freakyteen', 'nastyteen', 'bratteen', 'teenanal', 'teenamateur', 'teenasian',
  'teenaddict', 'animeloli', 'hentailoli', 'asianloli', 'Ebony_Teen', 'EbonyTeen',
  // round 13
  'naughtyteen', 'teenqueen', 'sweetteen', 'kinkyteen', 'teenangel', 'shyteen', 'myteen', 'teenlover', 'teeny', 'teenie',
  'lolilover', 'loliqueen', 'myloli', 'rapeplay', 'ageplaybabe', 'teenass', 't33nqueen', 'teen_queen', 'x_teenqueen_x',
  'teenslut', 'pornteen', 'teensex', 'incestporn', 'lolisex',
  // round 12
  'sexyschoolgirl', 'hotteen', 'underagebabe', 'jailbaitbabe', 'mylolita',
];
const NAME_MUST_PASS = [
  'nineteenslut', 'eighteenslut', 'nineteenporn', 'kirsteen', 'teena', 'teenamarie', 'Teena_Marie', 'laurapeters', 'kiaraperez',
  'paulolima', 'vincestone', 'steen', 'jessteen', 'hotsteen', 'christeen', 'justeen', 'mateen', 'rexteen_fan', 'cuteengineer',
  'kirsteenangel', 'christeenqueen', 'amyteenstra', 'essexrapelje', 'paigeplayford', 'sweetpea', 'queenb', 'angelface',
  'princesspeach', 'dollface', 'cutiepie', 'kittycat', 'myriam', 'rapeseedoil', 'therapist', 'canteenqueen', 'youngblood',
  'hotelmodel', 'kirsteendickson', 'justeencummings', 'kirsteensexton', 'mateenhornyak', 'christeencockburn', 'clarapearson',
  'marapetrova', 'danilolima', 'anneloliver', 'sweetsixteencandles', 'realestate', 'wildflower', 'asianfood', 'legalaid',
  'kirsteenasian', 'mateenlegal', 'newton', 'perfectday', 'tencummings', 'nineteen_slut', 'sexten', 'essexten', 'twelvetrees',
  'dickten', 'eighteen_porn',
  // round-14 fix-up: a spelled age next to a surname or place that merely
  // STARTS or ENDS with a sexual word
  'Ten Dickson', 'ten_dickson', 'Ten Cummings', 'Eleven Cumming', 'Essex Ten', 'essex_ten', 'middlesex ten', 'Wessex Twelve',
  'dick.ten', 'Dick Ten', 'Twelve Cockburn', 'Sixteen Pornell',
];

section('accounts#0 + accounts#1: name-mode corpus');
for (const context of ['handle', 'username', 'social_instagram']) {
  for (const h of NAME_MUST_FLAG) {
    check(`${context} refused: ${h}`, screenPublicText(h, { context })?.kind === 'prohibited', JSON.stringify(screenPublicText(h, { context })));
  }
  for (const h of NAME_MUST_PASS) {
    check(`${context} passes: ${h}`, !screenPublicText(h, { context }), JSON.stringify(screenPublicText(h, { context })));
  }
}
check('tag mode still refuses "asianteen"', screenPublicText('asianteen', { context: 'tag' })?.kind === 'prohibited');
check('tag mode still passes "nineteen"', !screenPublicText('nineteen', { context: 'tag' }));
check('free text "sweet sixteen party" passes', !screenPublicText('sweet sixteen party pics'));

// ---------------------------------------------------------------------------
section('accounts#2: the bridge tail catches the handovers again');
{
  const block = ['$15 and u get my snap', 'pay $20 and get my kik', '$10 and get added on snap', 'pay $25 and then hmu on telegram',
    'Tip $10 and I add you on snap', '$25 and i text you on telegram', 'pay 20 and ill send on snap', "pay 20 and i'll send on snap",
    'cheaper deals but only on my telegram', 'cheaper deals but just on my telegram', 'prices are cheaper so check my telegram',
    'pay $20 here and I will snap you', '$20 then my snap', 'cheaper and faster on telegram', '$20 and join me on telegram', 'pay $20 and see u on snap',
    // round-13 must-catch shapes, still refused
    'send $40 and I snap you', 'pay 20 and hit me on snap', 'send $20 and I send on snap', '$20 then telegram', '$20 and snap',
    'pay me here telegram', '$20 and hit my snap', 'cheaper prices on my snap', 'pay me on insta'];
  for (const t of block) check(`refused: ${t}`, detectPaymentCircumvention(t).flagged);
  const pass = ['Pay attention to my insta stories', 'pay my rent then post on insta', 'prices from $9 on here and my insta has previews',
    'Sets from $9 on here and my insta has free previews', 'cheaper here and my snap has previews', 'Sets from $9 on here, follow my insta too',
    'Sets from $9 on here. Follow my insta too', 'cheaper than insta', 'Just paid for your set, found you on insta',
    'pay my rent and then my insta goes private',
    // round-14 fix-up: ordinary cross-promotion after a price
    'Sets from $9 and follow my insta for updates', 'Customs $20 and you can see my insta for previews',
    'Unlock for $12 and check my instagram stories', 'Subs are $10 and join my telegram for news',
    'cheaper bundles then my instagram gets the teasers', 'Bundles from $15 and check out my tiktok', 'Pics $10 and see my tiktok'];
  for (const t of pass) check(`passes: ${t}`, !detectPaymentCircumvention(t).flagged, JSON.stringify(detectPaymentCircumvention(t).reasons));
}

// ---------------------------------------------------------------------------
section('accounts#3: a website without https:// is refused, not dropped');
{
  for (const w of ['jessxo.com', 'www.jessxo.com', 'http://jessxo.com', 'javascript:alert(1)', 'https://jess xo.com']) {
    const bad = invalidSocialHandles({ website: w });
    check(`invalidSocialHandles flags "${w}"`, bad.length === 1 && bad[0].key === 'website', JSON.stringify(bad));
  }
  check('an https website is fine', invalidSocialHandles({ website: 'https://jessxo.com/links' }).length === 0);
  check('an empty website is fine (clears it)', invalidSocialHandles({ website: '' }).length === 0 && invalidSocialHandles({ website: '  ' }).length === 0);
  check('sanitizeSocials still keeps an https website', sanitizeSocials({ website: 'https://a.com' }).website === 'https://a.com');

  await reset();
  const { creator, user } = await mkCreatorUser();
  const ok = await call(profileRoute, { user, body: { fields: { socials: { website: 'https://jess.com' } } } });
  check('an https website saves', ok.statusCode === 200, JSON.stringify(ok.body));
  const bad = await call(profileRoute, { user, body: { fields: { socials: { website: 'jess.com/links' } } } });
  check('a scheme-less website is a 400 naming social_website', bad.statusCode === 400 && bad.body.field === 'social_website', JSON.stringify(bad.body));
  const after = await creators.getCreatorById(creator.id);
  check('...and the stored website is untouched', after?.socials?.website === 'https://jess.com', JSON.stringify(after?.socials));
  const echo = await call(profileRoute, { user, body: { fields: { socials: { website: 'https://jess.com' }, bio: 'an unrelated edit here' } } });
  check('an unchanged echo still saves', echo.statusCode === 200, JSON.stringify(echo.body));
  const adm = await call(adminProfileRoute, { admin: true, body: { creatorId: String(creator.id), fields: { socials: { website: 'http://jess.com' } } } });
  check('the admin editor refuses it too, naming the field', adm.statusCode === 400 && adm.body.field === 'social_website', `${adm.statusCode} ${JSON.stringify(adm.body)}`);
}

// ---------------------------------------------------------------------------
section('gates-token#0: login/signup refuse cross-site form posts');
{
  const r = (headers) => ({ headers });
  check('no Origin / Sec-Fetch-Site is allowed (non-browser)', crossSiteReason(r({ host: 'www.joinonlyone.com' })) === null);
  check('same-origin JSON is allowed', crossSiteReason(r({ host: 'www.joinonlyone.com', origin: 'https://www.joinonlyone.com',
    'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })) === null);
  check('the forwarded host counts as own', crossSiteReason(r({ host: 'internal', 'x-forwarded-host': 'shoponeonly.com', origin: 'https://shoponeonly.com' })) === null);
  check('Sec-Fetch-Site cross-site is refused', crossSiteReason(r({ host: 'a.com', 'sec-fetch-site': 'cross-site' })) === 'sec-fetch-site');
  check('a foreign Origin is refused', crossSiteReason(r({ host: 'www.joinonlyone.com', origin: 'https://evil.example' })) === 'origin');
  check('Origin "null" is refused', crossSiteReason(r({ host: 'www.joinonlyone.com', origin: 'null' })) === 'origin');
  check('a form encoding is refused', crossSiteReason(r({ host: 'a.com', 'content-type': 'application/x-www-form-urlencoded' })) === 'content-type');
  check('text/plain is refused', crossSiteReason(r({ host: 'a.com', 'content-type': 'text/plain;charset=UTF-8' })) === 'content-type');

  await reset();
  await users.createUser({ email: 'victimtarget@r14b.test', password: 'password123', role: 'fan' });
  const csrf = await call(loginRoute, { body: { email: 'victimtarget@r14b.test', password: 'password123' },
    headers: { host: 'www.joinonlyone.com', origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' } });
  check('a cross-site login form is a 403 with no session cookie', csrf.statusCode === 403 && !csrf.headers['set-cookie'], `${csrf.statusCode} ${JSON.stringify(csrf.headers)}`);
  const own = await call(loginRoute, { body: { email: 'victimtarget@r14b.test', password: 'password123' },
    headers: { host: 'www.joinonlyone.com', origin: 'https://www.joinonlyone.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } });
  check('the site\'s own JSON login still signs in', own.statusCode === 200 && !!own.headers['set-cookie'], `${own.statusCode} ${JSON.stringify(own.body)}`);
  const bare = await call(loginRoute, { body: { email: 'victimtarget@r14b.test', password: 'password123' } });
  check('a header-less login (no browser) still works', bare.statusCode === 200, `${bare.statusCode}`);
  const su = await call(signupRoute, { body: { email: 'newfan14', password: 'password123', role: 'fan' },
    headers: { host: 'www.joinonlyone.com', 'sec-fetch-site': 'cross-site' } });
  check('a cross-site signup is a 403', su.statusCode === 403, `${su.statusCode} ${JSON.stringify(su.body)}`);
  check('...and created no account', !(await users.findUserByEmail('newfan14')));
}

// ---------------------------------------------------------------------------
section('public-pages#0 / dashboard#0 / dashboard#1: shipping text, history, notifications');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const fan = await mkFan();
  const addr = encryptShippingAddress({ fullName: 'A B', line1: '1 Main St', city: 'X', postalCode: '1', country: 'US' });
  const mkOrder = async () => String((await query('insert into orders (data) values ($1::jsonb) returning id',
    [JSON.stringify({ creatorId: String(creator.id), buyerId: String(fan.id), title: 'Signed poster', kind: 'physical', status: 'pending_shipment', shippingAddress: addr })])).rows[0].id);
  const o = await mkOrder();
  const ship = (carrier, trackingNumber, orderId = o) => call(shipRoute, { user, body: { orderId, carrier, trackingNumber } });

  const cash = await ship('Cash App $jessxo 20% off direct', '9405511899223197428490');
  check('a Cash App carrier is refused', cash.statusCode === 400 && cash.body.field === 'carrier', JSON.stringify(cash.body));
  const phone = await ship('text', '617 555 1234');
  check('carrier + tracking joined as a phone handover is refused', phone.statusCode === 400, JSON.stringify(phone.body));
  // Round 15: the carrier is a fixed list, so both are refused as carriers;
  // an app named as the carrier is still logged as a handover attempt.
  const viol = (await query('select data from violations')).rows.map((r) => r.data.context);
  check('...both are logged to the violations queue', viol.filter((c) => c === 'order_carrier').length === 2, JSON.stringify(viol));
  const charset = await ship('UPS', 'call me 555!');
  check('a tracking number outside the charset is a 400 naming it', charset.statusCode === 400 && charset.body.field === 'trackingNumber', JSON.stringify(charset.body));
  const longCarrier = await ship('A'.repeat(41), '1Z999AA10123456784');
  check('a 41-character carrier is refused', longCarrier.statusCode === 400 && longCarrier.body.field === 'carrier', JSON.stringify(longCarrier.body));
  check('none of that shipped the order', (await query(`select data->>'status' as s from orders where id = $1`, [o])).rows[0].s === 'pending_shipment');

  const first = await ship('USPS', '9405 5118 9922 3197 4284 90');
  check('a real USPS number ships', first.statusCode === 200 && first.body.order.status === 'shipped', JSON.stringify(first.body));
  check('...and the creator view carries no history or buyer id', !('trackingHistory' in first.body.order) && !('buyerId' in first.body.order));
  let notes = (await query(`select type, message, meta from notifications where user_id = $1 order by id`, [String(fan.id)])).rows;
  check('the buyer is notified it shipped', notes.length === 1 && notes[0].type === 'order_shipped' && notes[0].meta.orderId === o, JSON.stringify(notes));
  check('...without the tracking number in the text', !/9405/.test(notes[0].message), notes[0].message);

  const same = await ship('USPS', '9405 5118 9922 3197 4284 90');
  check('re-saving the same values is a no-op 200', same.statusCode === 200 && !same.body.order.trackingUpdatedAt, JSON.stringify(same.body));
  const fix1 = await ship('UPS', '1Z999AA10123456784');
  check('a correction saves', fix1.statusCode === 200 && fix1.body.order.trackingNumber === '1Z999AA10123456784');
  const hist = (await query(`select data->'trackingHistory' as h from orders where id = $1`, [o])).rows[0].h;
  check('...and keeps the replaced carrier/number in trackingHistory', Array.isArray(hist) && hist.length === 1
    // Round 15: stored compacted (spaces dropped).
    && hist[0].carrier === 'USPS' && hist[0].trackingNumber === '9405511899223197428490' && !!hist[0].replacedAt, JSON.stringify(hist));
  notes = (await query(`select type from notifications where user_id = $1 order by id`, [String(fan.id)])).rows.map((r) => r.type);
  check('the buyer is told the tracking changed', notes.join() === 'order_shipped,tracking_updated', notes.join());
  await ship('FedEx', '7489 1234 5679');
  notes = (await query(`select type from notifications where user_id = $1 and read_at is null order by id`, [String(fan.id)])).rows.map((r) => r.type);
  check('repeated corrections fold into one unread bell', notes.join() === 'order_shipped,tracking_updated', notes.join());
  // Round 15: a DHL eCommerce "GM..." number is not a DHL Express format; it is "Other".
  const fix3 = await ship('Other', 'GM2951173225174494');
  check('a third correction is still allowed', fix3.statusCode === 200, JSON.stringify(fix3.body));
  const fix4 = await ship('USPS', 'EA123456785US');
  check('a fourth correction is refused (409)', fix4.statusCode === 409 && fix4.body.code === orders.TRACKING_EDIT_LIMIT, JSON.stringify(fix4.body));
  const stored = (await query(`select data from orders where id = $1`, [o])).rows[0].data;
  check('...and changes nothing', stored.trackingNumber === 'GM2951173225174494' && stored.trackingHistory.length === 3, JSON.stringify(stored));
  const buyerView = (await orders.getOrdersForBuyer(String(fan.id)))[0];
  check('the buyer view carries no history', !('trackingHistory' in buyerView) && buyerView.trackingNumber === 'GM2951173225174494', JSON.stringify(buyerView));
  const creatorView = (await orders.getOrdersForCreator(creator.id))[0];
  check('the creator order list carries no history', !('trackingHistory' in creatorView));
  const adminView = (await orders.getOrderSummariesForAdmin({ orderId: o }))[0];
  check('the admin summary carries the whole history', adminView.trackingHistory.length === 3 && adminView.trackingNumber === 'GM2951173225174494', JSON.stringify(adminView));

  // A buyer whose account is gone: shipping still works, nobody is notified.
  const o2 = String((await query('insert into orders (data) values ($1::jsonb) returning id',
    [JSON.stringify({ creatorId: String(creator.id), buyerId: null, kind: 'physical', status: 'pending_shipment', shippingAddress: addr })])).rows[0].id);
  const ghost = await ship('UPS', '1Z999AA10123456793', o2);
  check('an order with no buyer id still ships', ghost.statusCode === 200, JSON.stringify(ghost.body));
  // Round 15: the carrier is one of a fixed list; every listed carrier takes
  // a number in its own format, and a small or international carrier is "Other".
  check('the store helper accepts every listed carrier', [['USPS', '9405511899223197428490'], ['UPS', '1Z999AA10123456784'],
    ['FedEx', '748912345679'], ['DHL', '1234567890'], ['Other', 'RR123456785GB']]
    .every(([c, t]) => !orders.trackingFieldsError({ carrier: c, trackingNumber: t })));
  check('...and refuses a carrier outside the list', ['Royal Mail', 'DHL eCommerce', 'J&T Express']
    .every((c) => orders.trackingFieldsError({ carrier: c, trackingNumber: 'RR123456785GB' })?.field === 'carrier'));
  // Round-14 fix-up: an app named as the carrier with a handle or number as
  // the tracking number, which the text screen cannot see in two short fields.
  for (const [c, t] of [['Snap', 'jessxo99'], ['Tele gram', 'jessxo99'], ['WhatsApp', '44 7700 900123'], ['Cash-App', '12345'],
    ['kik', 'jess 99'], ['Insta', '12345'], ['Telegram Express', '12345']]) {
    const e = orders.trackingFieldsError({ carrier: c, trackingNumber: t });
    check(`an app as the carrier is refused: ${c}`, e?.field === 'carrier', JSON.stringify(e));
  }
  const handle = orders.trackingFieldsError({ carrier: 'UPS', trackingNumber: 'jessxo' });
  check('a tracking number with no digit is refused', handle?.field === 'trackingNumber', JSON.stringify(handle));
  // Round 15: a real carrier outside the list is a plain refusal, not a
  // suspected handover.
  check('real carriers that merely contain an app-like word are not treated as handovers',
    ['Instant Courier', 'XPO Logistics', 'Line Haul Express', 'Royal Mail', 'Chronopost', 'Canpar', 'Purolator', 'Evri', 'Yodel', 'La Poste']
      .every((c) => { const e = orders.trackingFieldsError({ carrier: c, trackingNumber: 'RR123456785GB' }); return e?.field === 'carrier' && !e.suspicious; }));
  const viaRoute = await ship('WhatsApp', '44 7700 900123', o2);
  check('the ship route refuses an app carrier (400, field carrier)', viaRoute.statusCode === 400 && viaRoute.body.field === 'carrier', JSON.stringify(viaRoute.body));
}

// ---------------------------------------------------------------------------
section('media#0: a DM / comment takedown commits its copy with the removal');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const fan = await mkFan();
  const conv = 'conv-r14b';
  const msgs = [{ id: 'm1', senderId: String(fan.id), text: 'the evidence text', createdAt: new Date().toISOString() },
    { id: 'm2', senderId: String(fan.id), text: 'other', createdAt: new Date().toISOString() }];
  await query('insert into conversations (id, data) values ($1, $2)', [conv, { id: conv, participantIds: [String(fan.id), '999'], messages: msgs, senders: [] }]);
  const post = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan.id), authorName: 'F', text: 'the comment evidence' });
  const req = await ncii.addNciiReport({ category: 'minor', contentLocation: 'a DM', description: 'x', goodFaithStatement: true });

  // Make the audit insert fail inside the transaction: nothing may be removed.
  await query('alter table moderation_actions add constraint r14b_block check (false) not valid');
  const e1 = await errOf(() => takeDownContent({ type: 'message', conversationId: conv, messageId: 'm1' }, { nciiReportId: String(req.id) }));
  const e2 = await errOf(() => takeDownContent({ type: 'wall_post', postId: String(post.id) }, { nciiReportId: String(req.id) }));
  await query('alter table moderation_actions drop constraint r14b_block');
  check('both takedowns fail when their copy cannot be written', !!e1 && !!e2);
  const still = (await query('select data from conversations where id = $1', [conv])).rows[0].data.messages.map((m) => m.id);
  check('...and the message is still in the conversation', still.join() === 'm1,m2', still.join());
  check('...and the comment still exists', (await query('select 1 from wall_posts where id = $1', [String(post.id)])).rows.length === 1);
  check('...and the request has no half-recorded takedown', !((await query('select data from ncii_reports where id = $1', [String(req.id)])).rows[0].data.takedowns || []).length);

  const ok1 = await takeDownContent({ type: 'message', conversationId: conv, messageId: 'm1' }, { nciiReportId: String(req.id) });
  check('the retried message takedown removes it', ok1.result === 'removed' && ok1.snapshot?.text === 'the evidence text', JSON.stringify(ok1));
  const ok2 = await takeDownContent({ type: 'wall_post', postId: String(post.id) }, { nciiReportId: String(req.id) });
  check('the retried comment takedown removes it', ok2.result === 'removed' && ok2.snapshot?.text === 'the comment evidence', JSON.stringify(ok2));
  const acts = (await query(`select data from moderation_actions order by id`)).rows.map((r) => r.data);
  check('both copies are in moderation_actions', acts.length === 2 && acts[0].snapshot.text === 'the evidence text' && acts[1].snapshot.text === 'the comment evidence');
  const td = (await query('select data from ncii_reports where id = $1', [String(req.id)])).rows[0].data.takedowns;
  check('...and on the request', td.length === 2 && td.every((t) => t.result === 'removed' && t.snapshot), JSON.stringify(td));
  const again = await takeDownContent({ type: 'message', conversationId: conv, messageId: 'm1' });
  check('a second takedown of the same message is already_gone', again.result === 'already_gone');
  const gone = await takeDownContent({ type: 'wall_post', postId: String(post.id) });
  check('...and of the same comment', gone.result === 'already_gone');
  // Neighbour: an author still deletes their own comment the ordinary way.
  const p2 = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan.id), authorName: 'F', text: 'mine' });
  await wall.deleteWallPost(String(p2.id), String(fan.id));
  check('an author can still delete their own comment', !(await query('select 1 from wall_posts where id = $1', [String(p2.id)])).rows.length);
  const p3 = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan.id), authorName: 'F', text: 'theirs' });
  const nope = await errOf(() => wall.deleteWallPost(String(p3.id), '424242'));
  check('...and a stranger still cannot', nope?.message === 'Not authorized to delete this comment');
}

// ---------------------------------------------------------------------------
section('social#0 / admin-ui#0: an unknown cursor is a stale signal');
{
  await reset();
  const all = [];
  for (let i = 1; i <= 150; i++) all.push({ id: `m${i}`, senderId: '1', text: `msg ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
  await query('insert into conversations (id, data) values ($1, $2)', ['conv-s', { id: 'conv-s', participantIds: ['1', '2'], messages: all, senders: [] }]);
  const stale = await lookupConversation({ conversationId: 'conv-s', before: 'gone-id' });
  check('the store flags an unknown before as stale', stale.stale === true && stale.messages.length === 0, JSON.stringify(stale).slice(0, 200));
  const known = await lookupConversation({ conversationId: 'conv-s', before: 'm51' });
  check('a known cursor is not stale', !known.stale && known.messages.length === 50 && known.messages[0].id === 'm1');
  const first = await lookupConversation({ conversationId: 'conv-s' });
  check('the first page is not stale', !first.stale && first.nextBefore === 'm51');
  const r = await call(lookupRoute, { method: 'GET', admin: true, query: { kind: 'messages', conversationId: 'conv-s', before: 'gone-id' } });
  check('the route answers 409 stale_cursor', r.statusCode === 409 && r.body.code === 'stale_cursor', `${r.statusCode} ${JSON.stringify(r.body)}`);
  const ok = await call(lookupRoute, { method: 'GET', admin: true, query: { kind: 'messages', conversationId: 'conv-s', before: 'm51' } });
  check('...and 200 for a known cursor', ok.statusCode === 200 && ok.body.conversation.messages.length === 50);
}

// ---------------------------------------------------------------------------
section('social#1: the admin conversation list is keyset-paged');
{
  await reset();
  const fan = await mkFan();
  const uid = String(fan.id);
  for (let i = 1; i <= 5; i++) {
    await query(`insert into conversations (id, data, updated_at) values ($1, $2, $3)`,
      [`c${i}`, { id: `c${i}`, participantIds: [uid, `o${i}`], messages: [{ id: `x${i}`, senderId: uid, text: 't' }] }, new Date(Date.UTC(2026, 0, i))]);
  }
  const p1 = await lookupConversationsFor(uid, { limit: 2 });
  check('page one is the two newest', p1.conversations.map((c) => c.id).join() === 'c5,c4' && p1.hasMore && !!p1.nextCursor, JSON.stringify(p1).slice(0, 200));
  // c2 gets a new message while the admin reads page one.
  await query(`update conversations set updated_at = now() where id = 'c2'`);
  const p2 = await lookupConversationsFor(uid, { limit: 2, cursor: p1.nextCursor });
  check('page two has no duplicate of page one', p2.conversations.map((c) => c.id).join() === 'c3,c1', p2.conversations.map((c) => c.id).join());
  check('...and is the last page', !p2.hasMore && p2.nextCursor === null);
  const fresh = await lookupConversationsFor(uid, { limit: 2 });
  check('reloading page one shows the moved conversation', fresh.conversations[0].id === 'c2');
  const junk = await lookupConversationsFor(uid, { limit: 2, cursor: 'not-a-cursor' });
  check('a malformed cursor reads as the first page', junk.conversations.map((c) => c.id).join() === 'c2,c5');
  const legacy = await lookupConversationsFor(uid, { limit: 2, offset: 2 });
  check('offset paging still answers for an old client', legacy.conversations.length === 2 && legacy.nextOffset === 4);
  const route = await call(lookupRoute, { method: 'GET', admin: true, query: { kind: 'conversations', userId: uid, cursor: p1.nextCursor } });
  check('the route passes the cursor through', route.statusCode === 200 && !route.body.conversations.some((c) => ['c5', 'c4'].includes(c.id)),
    `${route.statusCode} ${JSON.stringify(route.body).slice(0, 200)}`);
}

for (const f of failures) console.log('  FAILED:', f);
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
