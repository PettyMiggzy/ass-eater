// Regression tests for the round-17 backend fixes (package R17B), run against a
// real scratch Postgres (it truncates tables). Every fix is tested in both
// directions (the bug, and its nearest harmless neighbours):
//  - money#0 / dashboard#1: real carrier numbers with letter runs (DHL Parcel
//    "JVGL...", PostNL "3S" + customer code, UPS 1Z shippers spelling SNAP /
//    KIK) pass and are never logged; app names and "@" are still refused;
//  - media#0 / social#1: the admin TAKE IT DOWN wall-comment takedown takes
//    the reports lock before wall_posts, so it no longer deadlocks against a
//    report resolve of the same comment;
//  - social#0: remove_and_ban on a reported DM locks the conversation before
//    the creator, so it no longer deadlocks against a paid fan -> creator DM;
//  - media#1: the owner path serves only files still on the record or an
//    upload in progress -- never a taken-down file waiting on a hold;
//  - money#1 / legal-journeys#0: closing a deleted buyer's order erases their
//    address whatever the admin ticked; the cron sweeps what is left;
//  - money#2 / dashboard#0: the seller's view does not change when the buyer
//    erases (tracking number and correction count look the same);
//  - legal-journeys#1: a deleted account's filed reports stop naming it;
//  - admin-ui#3: contentRemovedAt is an ISO string.
// The screen corpus (accounts#0-#3) is lib/screen-corpus.test.mjs.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r17b.test.mjs

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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r17b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r17b';
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

const { query, closePool } = await import('./db.js');
const pg = (await import('pg')).default;
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const orders = await import('./orders-store.js');
const reportsStore = await import('./reports-store.js');
const wall = await import('./wall-store.js');
const messages = await import('./messages-store.js');
const credits = await import('./credits-store.js');
const rules = await import('./tracking-rules.js');
const { takeDownContent } = await import('./content-takedown.js');
const { encryptShippingAddress } = await import('./crypto.js');
const { createSessionToken } = await import('./session.js');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    send(b) { this.body = b; this.headersSent = true; return this; },
    redirect(a, b) { this.statusCode = typeof a === 'number' ? a : 302; this.headers.location = typeof a === 'number' ? b : a; this.headersSent = true; return this; },
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r17bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r17b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r17b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
const galleryFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'gallery', creatorId, contentType: 'image/jpeg' }));
const pathOf = (src) => src.replace('/api/media/', '').split('/');
const addr = () => encryptShippingAddress({ fullName: 'A B', line1: '1 Main St', city: 'X', postalCode: '1', country: 'US' });
async function mkOrder(creatorId, buyerId, fields = {}) {
  const { rows } = await query('insert into orders (data) values ($1::jsonb) returning id', [JSON.stringify({
    creatorId: String(creatorId), buyerId: String(buyerId), title: 'Signed poster', kind: 'physical', status: 'pending_shipment',
    shippingAddress: addr(), ...fields,
  })]);
  return String(rows[0].id);
}
const orderData = async (id) => (await query('select data from orders where id = $1', [id])).rows[0].data;
const count = async (sql, params = []) => (await query(sql, params)).rows[0].n;

// ---------------------------------------------------------------------------
section('money#0 / dashboard#1: real carrier numbers with letter runs pass and are never logged');
{
  let seed = 0x17b;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (chars, k) => Array.from({ length: k }, () => chars[Math.floor(rnd() * chars.length)]).join('');
  const D = '0123456789';
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  // Shippers spelling the SHORT app names (a real shipper can); a whole long
  // app name (VENMO, WHATSAPP ...) is refused even there -- asserted below.
  const shippers = ['SNAP12', 'KIK3A1', 'INSTA1', 'XSNAPX', 'INSTAX', 'SNAPIG', 'XXKIKX', 'A1KIK2', 'IGSNAP'];
  const gens = [
    ['DHL', () => `JVGL${pick(D, 16 + Math.floor(rnd() * 5))}`],
    ['Other', () => `JVGL${pick(D, 16 + Math.floor(rnd() * 5))}`],
    ['Other', () => `3S${pick(L, 4)}${pick(D, 7 + Math.floor(rnd() * 9))}`],
    ['UPS', () => `1Z${shippers[Math.floor(rnd() * shippers.length)]}${pick(A, 2)}${pick(D, 8)}`],
    ['UPS', () => `1Z${pick(L, 6)}${pick(L, 2)}${pick(D, 8)}`],
    ['Other', () => `H${pick(D, 2)}${pick(L, 3)}${pick(D, 10)}`],
  ];
  for (const [carrier, gen] of gens) {
    let refused = 0;
    let flagged = 0;
    let example = null;
    for (let i = 0; i < 3000; i++) {
      const t = gen();
      const e = rules.trackingFieldsError({ carrier, trackingNumber: t });
      if (e) { refused++; if (e.suspicious) flagged++; example = example || [t, e]; }
    }
    check(`3000 random real-shaped ${carrier} numbers (${gen().slice(0, 4)}...) all pass`, refused === 0 && flagged === 0, JSON.stringify([refused, flagged, example]));
  }
  const E = (c, t) => rules.trackingFieldsError({ carrier: c, trackingNumber: t });
  for (const [c, t] of [['DHL', 'JVGL06208213000123456789'], ['DHL', 'JVGL0620821300012345'], ['Other', '3SABCD1234567'], ['Other', '3SDEVC123456789'],
    ['Other', '3SDEVC0123456789'], ['UPS', '1Z12KIK3A123456789'], ['UPS', '1ZSNAP120312345678'], ['UPS', '1ZINSTA1YW12345678'], ['Other', '3SSNAP1234567'],
    ['Other', 'JESS61755512340'], ['Other', 'CNGBA1234567890']]) {
    check(`accepted: ${c} | ${t}`, !E(c, t), JSON.stringify(E(c, t)));
  }
  for (const [c, t] of [['Other', 'SNAP12345678'], ['Other', 'SNAPME12345678'], ['Other', 'VENMO12345678'], ['Other', 'WHATSAPP447700900123'],
    ['USPS', 'KIK123456789'], ['UPS', '1ZSNAPJESSXO123456'], ['UPS', '1ZWHATSAPPJ1234567'], ['UPS', 'whatsapp 44 7700 900123'],
    // a whole long app name inside a 1Z shipper + service segment (reviewer fix-up)
    ['UPS', '1ZVENMO05551234567'], ['Other', '1ZVENMO05551234567'], ['UPS', '1ZWHATSAPP55512345'], ['UPS', '1ZCASHAPP555123456'],
    ['UPS', '1ZTELEGRAM12345678'], ['UPS', '1ZZELLE05551234567'], ['UPS', '1ZWHATSAPP12345678'], ['UPS', '1ZPAYPAL0112345678']]) {
    check(`an app name is still refused AND flagged: ${c} | ${t}`, E(c, t)?.suspicious === true, JSON.stringify(E(c, t)));
  }
  // Round 19 (money#0): 'jessxo2' (one digit) is now accepted -- no digit floor.
  for (const [c, t] of [['Other', 'jess@mail.com123456'], ['UPS', '1Z12345']]) {
    const e = E(c, t);
    check(`still refused, not flagged: ${c} | ${t}`, e && !e.suspicious, JSON.stringify(e));
  }
  check('a JVGL number under DHL has no warning', rules.trackingFormatWarning({ carrier: 'DHL', trackingNumber: 'JVGL06208213000123456789' }) === null);
  check('a PostNL 3S number under Other has no warning', rules.trackingFormatWarning({ carrier: 'Other', trackingNumber: '3SDEVC123456789' }) === null);
  check('an unknown letter run only gets a non-blocking warning', !!rules.trackingFormatWarning({ carrier: 'Other', trackingNumber: 'JESS61755512340' })
    && !E('Other', 'JESS61755512340'));
  check('the Other hint matches the enforced rule (no letter-run rule mentioned)', !/word/i.test(rules.TRACKING_FORMAT_HINTS.Other));

  // Through the route: a PostNL / DHL Parcel number ships and logs nothing.
  await reset();
  const { creator, user } = await mkCreatorUser();
  const fan = await mkFan();
  const o = await mkOrder(creator.id, fan.id);
  const r = await call(shipRoute, { user, body: { orderId: o, carrier: 'Other', trackingNumber: '3SDEVC123456789' } });
  check('a PostNL 3S number ships through the route', r.statusCode === 200 && r.body.order.trackingNumber === '3SDEVC123456789', JSON.stringify(r.body));
  const o2 = await mkOrder(creator.id, fan.id);
  const r2 = await call(shipRoute, { user, body: { orderId: o2, carrier: 'DHL', trackingNumber: 'JVGL 0620 8213 0001 2345' } });
  check('...and a DHL Parcel JVGL number', r2.statusCode === 200 && r2.body.order.trackingNumber === 'JVGL0620821300012345', JSON.stringify(r2.body));
  const o3 = await mkOrder(creator.id, fan.id);
  const r3 = await call(shipRoute, { user, body: { orderId: o3, carrier: 'UPS', trackingNumber: '1ZSNAP120312345678' } });
  check('...and a UPS 1Z number whose shipper reads SNAP', r3.statusCode === 200, JSON.stringify(r3.body));
  check('none of them logged a violation', (await count('select count(*)::int as n from violations')) === 0);
  const o4 = await mkOrder(creator.id, fan.id);
  const r4 = await call(shipRoute, { user, body: { orderId: o4, carrier: 'Other', trackingNumber: 'SNAPCHAT 12345678' } });
  check('neighbour: an app name is still refused and logged', r4.statusCode === 400
    && (await count(`select count(*)::int as n from violations where data->>'context' = 'order_tracking_shape'`)) === 1, JSON.stringify(r4.body));
}

// ---------------------------------------------------------------------------
section('media#0 / social#1: a wall-comment takedown waits for the reports lock instead of deadlocking');
{
  for (let round = 0; round < 2; round++) {
    await reset();
    const { creator } = await mkCreatorUser();
    const fan = await mkFan();
    const post = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan.id), authorName: 'f', text: 'hello there' });
    await reportsStore.addReport({ targetType: 'wall_post', targetId: String(post.id), category: 'non_consensual', reason: 'x', reporterId: 'u1' });
    // What reports-resolve's Remove Content does: the reports rows first,
    // then (a moment later) the wall_posts row.
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    let emulated = 'ok';
    let takedown;
    try {
      await client.query('begin');
      await client.query(`select 1 from reports where data->>'targetType' = 'wall_post' and data->>'targetId' = $1 order by id for update`, [String(post.id)]);
      takedown = quiet(() => takeDownContent({ type: 'wall_post', postId: String(post.id) })).then((x) => x, (e) => e);
      await sleep(300);
      try {
        await client.query('select 1 from wall_posts where id = $1 for update', [String(post.id)]);
        await client.query('commit');
      } catch (err) {
        emulated = err.code || err.message;
        await client.query('rollback').catch(() => {});
      }
    } finally {
      await client.end();
    }
    const out = await takedown;
    check(`round ${round}: the resolve side is not aborted as a deadlock`, emulated === 'ok', emulated);
    check(`round ${round}: the takedown completes`, out && !(out instanceof Error) && out.result === 'removed', out instanceof Error ? `${out.code} ${out.message}` : JSON.stringify(out));
    check(`round ${round}: the comment is gone`, !(await wall.getWallPostById(String(post.id))));
  }
  // End to end: a Remove Content and a TAKE IT DOWN takedown racing on one comment.
  for (let round = 0; round < 4; round++) {
    await reset();
    const { creator } = await mkCreatorUser();
    const fan = await mkFan();
    const post = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan.id), authorName: 'f', text: 'hello there' });
    const rep = await reportsStore.addReport({ targetType: 'wall_post', targetId: String(post.id), category: 'non_consensual', reason: 'x', reporterId: 'u1' });
    const [a, b] = await Promise.all([
      call(reportsResolveRoute, { admin: true, body: { id: String(rep.id), action: 'remove_content' } }),
      quiet(() => takeDownContent({ type: 'wall_post', postId: String(post.id) })).then((x) => x, (e) => e),
    ]);
    check(`race ${round}: both succeed`, a.statusCode === 200 && b && !(b instanceof Error), `${a.statusCode} ${JSON.stringify(a.body)} / ${b instanceof Error ? b.message : JSON.stringify(b)}`);
    const outcomes = [a.body?.content, b?.result === 'removed' ? 'removed' : 'already_gone'].sort().join(',');
    check(`race ${round}: exactly one removed it`, outcomes === 'already_gone,removed', outcomes);
  }
}

// ---------------------------------------------------------------------------
section('social#0: remove_and_ban on a reported DM waits for the conversation instead of deadlocking');
{
  await reset();
  const { creator, user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: String(fan.id), cents: 10000, type: 'test' });
  const first = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hi there', expectedPriceCents: 99 });
  const reply = await messages.sendDirectMessage({ sender: cu, recipientId: fan.id, text: 'hello you' });
  const conversationId = first.conversation.id;
  const found = await messages.findConversationMessage(fan.id, String(cu.id), reply.message.id);
  const rep = await reportsStore.addReport({
    targetType: 'message', targetId: reply.message.id, conversationId, reporterId: fan.id, reason: 'x', category: 'minor',
    reportedContent: await reportsStore.snapshotMessage(found.message, { conversationId, participantIds: found.participantIds }),
  });
  // What a paid fan -> creator send does: the conversation first, then (a
  // moment later) the recipient's users and creators rows FOR SHARE.
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let emulated = 'ok';
  let resolved;
  try {
    await client.query('begin');
    await client.query('select 1 from conversations where id = $1 for update', [conversationId]);
    resolved = call(reportsResolveRoute, { admin: true, body: { id: String(rep.id), action: 'remove_and_ban' } });
    await sleep(400);
    try {
      await client.query('select 1 from users where id = $1 for share', [String(cu.id)]);
      await client.query('select 1 from creators where id = $1 for share', [String(creator.id)]);
      await client.query('commit');
    } catch (err) {
      emulated = err.code || err.message;
      await client.query('rollback').catch(() => {});
    }
  } finally {
    await client.end();
  }
  const res = await resolved;
  check('the paid-send side is not aborted as a deadlock', emulated === 'ok', emulated);
  check('remove_and_ban completes', res.statusCode === 200 && res.body.content === 'removed' && !!res.body.bannedCreatorId, JSON.stringify(res.body));
  check('...the creator is banned', (await creators.getCreatorById(String(creator.id))).status === 'banned');
  const conv = (await query('select data from conversations where id = $1', [conversationId])).rows[0].data;
  check('...and the reported message is gone, the fan\'s own kept', !conv.messages.some((m) => m.id === reply.message.id)
    && conv.messages.some((m) => m.id === first.message.id));
  // Neighbour: a real concurrent paid DM and remove_and_ban both finish.
  await reset();
  const { creator: c2, user: u2 } = await mkCreatorUser();
  const f2 = await mkFan();
  await credits.creditAccount({ userId: String(f2.id), cents: 10000, type: 'test' });
  const m1 = await messages.sendDirectMessage({ sender: f2, recipientId: u2.id, text: 'hi there', expectedPriceCents: 99 });
  const m2 = await messages.sendDirectMessage({ sender: u2, recipientId: f2.id, text: 'hello you' });
  const f2found = await messages.findConversationMessage(f2.id, String(u2.id), m2.message.id);
  const rep2 = await reportsStore.addReport({
    targetType: 'message', targetId: m2.message.id, conversationId: m1.conversation.id, reporterId: f2.id, reason: 'x', category: 'minor',
    reportedContent: await reportsStore.snapshotMessage(f2found.message, { conversationId: m1.conversation.id, participantIds: f2found.participantIds }),
  });
  const [rr, sent] = await Promise.all([
    call(reportsResolveRoute, { admin: true, body: { id: String(rep2.id), action: 'remove_and_ban' } }),
    quiet(() => messages.sendDirectMessage({ sender: f2, recipientId: u2.id, text: 'another one', expectedPriceCents: 99 })).then((x) => x, (e) => e),
  ]);
  check('a racing remove_and_ban succeeds', rr.statusCode === 200, JSON.stringify(rr.body));
  check('...and the racing DM either went through or was refused cleanly (never a deadlock)',
    !(sent instanceof Error) || (sent.code !== '40P01' && !!sent.code), sent instanceof Error ? `${sent.code} ${sent.message}` : 'sent');
  void c2;
}

// ---------------------------------------------------------------------------
section('media#1: the owner is served only files on their record or an upload in progress');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const l = await listings.createListing(creator.id, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true });
  const src = listingFile(creator.id, l.id);
  await listings.addListingMedia(l.id, { type: 'image', src });
  const head = (s, u = user) => call(mediaRoute, { method: 'HEAD', user: u, query: { path: pathOf(s) } });
  check('the owner is served a file on their live listing', (await head(src)).statusCode === 200);
  // A possible-minor in-product report holds the listing's files.
  await reportsStore.addReport({ targetType: 'listing', targetId: String(l.id), category: 'minor', reason: 'x', reporterId: 'u' }, { holdMedia: [src] });
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_r17b';
  deleted.length = 0;
  const out = await quiet(() => takeDownContent({ type: 'listing', listingId: String(l.id) }));
  delete process.env.BLOB_READ_WRITE_TOKEN;
  check('the takedown removed the listing', out.result === 'removed', JSON.stringify(out));
  check('...and the held file was not deleted (it waits for the hold)', !deleted.includes(src.replace('/api/media/', '')), JSON.stringify(deleted));
  const after = await head(src);
  check('the taken-down, held file is no longer served to its (active) owner', after.statusCode === 404, String(after.statusCode));

  // An upload in progress (a live 'token' row, no record yet) is still served.
  const l2 = await listings.createListing(creator.id, { title: 'Set 2', priceCents: 500, kind: 'digital', unlimited: true });
  const up = listingFile(creator.id, l2.id);
  await media.recordPendingMediaPath(up.replace('/api/media/', ''), 'token');
  check('an upload in progress is served to its owner', (await head(up)).statusCode === 200);
  const fan = await mkFan();
  check('...but not to anyone else', (await head(up, fan)).statusCode === 404);
  // A file queued for deletion (the reference gone) is not.
  const gone = listingFile(creator.id, l2.id);
  await query(`insert into media_uploads (pathname, reason) values ($1, 'delete_pending')`, [gone.replace('/api/media/', '')]);
  check('a file queued for deletion is not served to its owner', (await head(gone)).statusCode === 404);

  // Gallery: on the record (even with a hold) -> served; off it with a hold -> not.
  const g = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g }, []);
  await query(`insert into media_holds (pathname, report_id) values ($1, 'report:999')`, [g.replace('/api/media/', '')]);
  check('a gallery file still on the record is served even while held', (await head(g)).statusCode === 200);
  await creators.removeGalleryItem(String(creator.id), { src: g });
  check('...and not once it is off the record (still held, not yet deleted)', (await head(g)).statusCode === 404);
  const g2 = galleryFile(creator.id);
  await media.recordPendingMediaPath(g2.replace('/api/media/', ''), 'token');
  check('a gallery upload in progress is served to its owner', (await head(g2)).statusCode === 200);
}

// ---------------------------------------------------------------------------
section('money#1 / legal-journeys#0: closing a deleted buyer\'s order erases their address');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const fan = await mkFan();
  const o = await mkOrder(creator.id, fan.id);
  await users.deleteFanAccount(String(fan.id), { force: true, strict: true });
  check('an admin-forced deletion leaves the pending order\'s address', !!(await orderData(o)).shippingAddress);
  await query(`update creators set data = data || '{"status":"banned"}'::jsonb where id = $1`, [String(creator.id)]);
  const closed = await orders.closeUnfulfilledOrder(o, { reason: 'seller banned' });
  const d = await orderData(o);
  check('closing it WITHOUT eraseAddress still erases the deleted buyer\'s address', d.status === 'closed_unfulfilled' && d.shippingAddress === null
    && !!d.addressErasedAt && closed.erased === true, JSON.stringify({ closed, d }));
  check('...and no notification is written for the gone account', (await count('select count(*)::int as n from notifications where user_id = $1', [String(fan.id)])) === 0);
  // Neighbour: a live buyer's address stays unless asked, and they are told.
  const live = await mkFan();
  const o2 = await mkOrder(creator.id, live.id);
  const c2 = await orders.closeUnfulfilledOrder(o2, { reason: 'seller banned' });
  check('a live buyer\'s closed order keeps its address unless erase was ticked', !!(await orderData(o2)).shippingAddress && c2.erased === false);
  check('...and the live buyer is notified', (await count('select count(*)::int as n from notifications where user_id = $1', [String(live.id)])) === 1);
  // The cron sweep catches a finished order of a gone buyer left from before.
  const ghost = await mkOrder(creator.id, 'deleted-user-xyz', { status: 'closed_unfulfilled', closedAt: new Date().toISOString() });
  const ghostShipped = await mkOrder(creator.id, 'deleted-user-xyz', { status: 'shipped', carrier: 'UPS', trackingNumber: '1Z999AA10123456784' });
  const ghostPending = await mkOrder(creator.id, 'deleted-user-xyz');
  const liveClosed = await mkOrder(creator.id, live.id, { status: 'closed_unfulfilled' });
  const swept = await orders.eraseAddressesOfDeletedBuyers();
  // Round 18 (decided): the address goes, the seller's tracking number stays.
  check('the sweep erases the closed and shipped orders of a gone buyer', swept === 2 && (await orderData(ghost)).shippingAddress === null
    && (await orderData(ghostShipped)).shippingAddress === null && (await orderData(ghostShipped)).trackingNumber === '1Z999AA10123456784', String(swept));
  check('...leaves a gone buyer\'s PENDING order (it still has to ship)', !!(await orderData(ghostPending)).shippingAddress);
  check('...and never touches a live buyer', !!(await orderData(liveClosed)).shippingAddress);
  check('a second sweep has nothing to do', (await orders.eraseAddressesOfDeletedBuyers()) === 0);
}

// ---------------------------------------------------------------------------
// Round 18 (DECIDED, money#1/#2, public-pages#0, legal-journeys#0): the
// tracking number is the seller's carrier reference, not the buyer's data --
// an erasure removes only the name and address, there is ONE copy of the
// number, and buyer and seller see the same order. These expectations were
// rewritten to that decision (round 17 kept a seller-only copy).
section('money#2 / dashboard#0: the seller\'s view does not change when the buyer erases');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const fan = await mkFan();
  const o = await mkOrder(creator.id, fan.id);
  await call(shipRoute, { user, body: { orderId: o, carrier: 'USPS', trackingNumber: '9405511899223197428490' } });
  const view = async () => (await orders.getOrdersForCreator(creator.id)).find((x) => String(x.id) === o);
  const before = await view();
  await orders.eraseOrderShippingAddress(o);
  const after = await view();
  check('the stored number stays (only the address is erased)', (await orderData(o)).trackingNumber === '9405511899223197428490'
    && (await orderData(o)).shippingAddress === null);
  check('...and the seller still sees the number they entered', after.trackingNumber === '9405511899223197428490', JSON.stringify(after));
  check('...and the same correction count', after.trackingCorrectionsLeft === before.trackingCorrectionsLeft && after.trackingCorrectionsLeft === 3,
    `${before.trackingCorrectionsLeft} ${after.trackingCorrectionsLeft}`);
  check('the seller view is key-for-key the same', JSON.stringify(Object.keys(before).sort()) === JSON.stringify(Object.keys(after).sort())
    && !('sellerTrackingNumber' in after), JSON.stringify([Object.keys(before), Object.keys(after)]));
  const buyer = (await orders.getOrdersForBuyer(String(fan.id)))[0];
  check('the buyer sees the same number and no seller copy', buyer.trackingNumber === '9405511899223197428490' && !('sellerTrackingNumber' in buyer),
    JSON.stringify(buyer));
  const admin = (await orders.getOrderSummariesForAdmin({ orderId: o }))[0];
  check('the admin summary shows the same number and no seller copy', admin && !('sellerTrackingNumber' in admin)
    && admin.trackingNumber === '9405511899223197428490', JSON.stringify(admin));
  const same = await call(shipRoute, { user, body: { orderId: o, carrier: 'USPS', trackingNumber: '9405511899223197428490' } });
  check('re-saving the same number answers as for any order', same.statusCode === 200 && same.body.order.trackingNumber === '9405511899223197428490', JSON.stringify(same.body));
  const fix = await call(shipRoute, { user, body: { orderId: o, carrier: 'USPS', trackingNumber: '9405511899223197428506' } });
  const d = await orderData(o);
  check('a correction answers 200 with the new number and one fewer correction', fix.statusCode === 200
    && fix.body.order.trackingNumber === '9405511899223197428506' && fix.body.order.trackingCorrectionsLeft === 2, JSON.stringify(fix.body));
  check('...into the one shared copy, the replaced number kept in history', d.trackingNumber === '9405511899223197428506'
    && !('sellerTrackingNumber' in d) && d.trackingHistory.length === 1 && d.trackingHistory[0].trackingNumber === '9405511899223197428490', JSON.stringify(d));
  check('...and the buyer (who still has an account) is told, like anyone', (await count(`select count(*)::int as n from notifications where user_id = $1 and type = 'tracking_updated'`, [String(fan.id)])) === 1);

  // A buyer already gone at ship time: the ship response shows what was typed.
  const gone = await mkFan();
  const o2 = await mkOrder(creator.id, gone.id);
  await users.deleteFanAccount(String(gone.id), { force: true, strict: true });
  const r = await call(shipRoute, { user, body: { orderId: o2, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' } });
  check('shipping a gone buyer\'s order returns the number the seller typed, 3 corrections left', r.statusCode === 200
    && r.body.order.trackingNumber === '1Z999AA10123456784' && r.body.order.trackingCorrectionsLeft === 3, JSON.stringify(r.body));
  const d2 = await orderData(o2);
  check('...while the stored address is erased and the number kept', d2.trackingNumber === '1Z999AA10123456784' && d2.shippingAddress === null
    && !!d2.addressErasedAt && !d2.trackingErasedAt, JSON.stringify(d2));
  // Neighbour: an ordinary order's correction still reaches the buyer.
  const live = await mkFan();
  const o3 = await mkOrder(creator.id, live.id);
  await call(shipRoute, { user, body: { orderId: o3, carrier: 'USPS', trackingNumber: '9405511899223197428490' } });
  await call(shipRoute, { user, body: { orderId: o3, carrier: 'USPS', trackingNumber: '9405511899223197428506' } });
  const d3 = await orderData(o3);
  check('a live buyer\'s correction still updates their copy', d3.trackingNumber === '9405511899223197428506' && !('sellerTrackingNumber' in d3), JSON.stringify(d3));
  // The cap is the same for both.
  for (const t of ['9405511899223197428513', '9405511899223197428520']) await call(shipRoute, { user, body: { orderId: o, carrier: 'USPS', trackingNumber: t } });
  const capped = await call(shipRoute, { user, body: { orderId: o, carrier: 'USPS', trackingNumber: '9405511899223197428537' } });
  for (const t of ['9405511899223197428513', '9405511899223197428520']) await call(shipRoute, { user, body: { orderId: o3, carrier: 'USPS', trackingNumber: t } });
  const capped3 = await call(shipRoute, { user, body: { orderId: o3, carrier: 'USPS', trackingNumber: '9405511899223197428537' } });
  check('the correction cap answers identically for an erased and a live order', capped.statusCode === 409 && capped3.statusCode === 409
    && capped.body.error === capped3.body.error, JSON.stringify([capped.body, capped3.body]));
}

// ---------------------------------------------------------------------------
section('legal-journeys#1: a deleted account\'s filed reports stop naming it');
{
  await reset();
  const { user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: String(fan.id), cents: 1000, type: 'test' });
  const first = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hi there', expectedPriceCents: 99 });
  const reply = await messages.sendDirectMessage({ sender: cu, recipientId: fan.id, text: 'hello you' });
  const found = await messages.findConversationMessage(fan.id, String(cu.id), reply.message.id);
  const rep = await reportsStore.addReport({
    targetType: 'message', targetId: reply.message.id, conversationId: first.conversation.id, reporterId: String(fan.id), reason: 'my own story', category: 'other',
    reportedContent: await reportsStore.snapshotMessage(found.message, { conversationId: first.conversation.id, participantIds: found.participantIds }),
  });
  const other = await mkFan();
  const keep = await reportsStore.addReport({ targetType: 'listing', targetId: '1', reason: 'x', category: 'other', reporterId: String(other.id) });
  await users.deleteFanAccount(String(fan.id), { force: true, strict: true });
  const after = (await query('select data from reports where id = $1', [String(rep.id)])).rows[0].data;
  check('the report stays, without the reporter id', after && !('reporterId' in after) && !!after.reporterDeletedAt && after.reason === 'my own story', JSON.stringify(after));
  check('...and the DM copy no longer lists the reporter as a participant',
    !after.reportedContent.participantIds.includes(String(fan.id)) && after.reportedContent.participantIds.includes(String(cu.id))
    && after.reportedContent.senderId === String(cu.id), JSON.stringify(after.reportedContent));
  const k = (await query('select data from reports where id = $1', [String(keep.id)])).rows[0].data;
  check('another account\'s report is untouched', k.reporterId === String(other.id) && !k.reporterDeletedAt);
  check('the conversationId is kept (the moderation key for the reported message)',
    after.conversationId === first.conversation.id && after.reportedContent.conversationId === first.conversation.id, JSON.stringify(after));
  // A participant id stored as a JSON number is nulled too (reviewer fix-up).
  const { withTransaction } = await import('./db.js');
  const legacy = await reportsStore.addReport({
    targetType: 'message', targetId: 'm1', conversationId: '424242__zz', reporterId: '424242', reason: 'legacy', category: 'other',
    reportedContent: { kind: 'message', senderId: 'zz', participantIds: [424242, 'zz'], conversationId: '424242__zz' },
  });
  await withTransaction((client) => users.purgeUserContent(client, '424242'));
  const lg = (await query('select data from reports where id = $1', [String(legacy.id)])).rows[0].data;
  check('a number-typed participant id is nulled as well',
    !('reporterId' in lg) && lg.reportedContent.participantIds[0] === null && lg.reportedContent.participantIds[1] === 'zz', JSON.stringify(lg));
}

// ---------------------------------------------------------------------------
section('admin-ui#3: contentRemovedAt is an ISO 8601 string');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const g = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g }, []);
  const rep = await reportsStore.addReport({ targetType: 'gallery_item', targetId: String(creator.id), src: g, category: 'other', reason: 'x', reporterId: 'u' });
  const res = await call(reportsResolveRoute, { admin: true, body: { id: String(rep.id), action: 'remove_content' } });
  const data = (await query('select data from reports where id = $1', [String(rep.id)])).rows[0].data;
  check('the gallery removal resolves', res.statusCode === 200 && res.body.content === 'removed', JSON.stringify(res.body));
  check('contentRemovedAt is ISO (parses everywhere, ends in Z)', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.contentRemovedAt || '')
    && data.contentRemovedAt === new Date(data.contentRemovedAt).toISOString(), data.contentRemovedAt);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
for (const f of failures) console.log('  FAILED:', f);
await closePool();
process.exit(fail ? 1 : 0);
