// Regression tests for the round-18 backend fixes (package R18B), run against a
// real scratch Postgres (it truncates tables). Every fix is tested in both
// directions (the bug, and its nearest harmless neighbours):
//  - money#0: short / low-digit carrier references (GLS "ZF8YY6HP") and a
//    three-letter merchant code inside a number ("33KIK...") ship; app names,
//    "@" and digit-less values are still refused;
//  - money#1/#2, legal-journeys#0, public-pages#0 (DECIDED): an erasure
//    removes only the shipping name and address; the tracking number is the
//    seller's reference and there is ONE copy; the stored seller-only copy
//    is folded back by the schema migration;
//  - money#3: rejecting a deleted account's payout forfeits it (a net-zero
//    ledger pair) instead of crediting a balance for a login that is gone;
//  - media#0 / social#0: account deletion locks its conversations before any
//    report, so it no longer deadlocks against a report resolve holding the
//    conversation; withTransactionRetryOnDeadlock retries a 40P01 once;
//  - social#1: the admin reports payload drops conversationId and shows a gone
//    participant as null, and the legacy delete-time copy no longer puts a
//    purged reporter's id back;
//  - admin-ui#0: a §2257 alias search typed with "@" finds the alias;
//  - srv-auth-core#1 (site half): a run of single-word tags is judged as a
//    label (strict, squashed). The text corpus is lib/screen-corpus.test.mjs.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r18b.test.mjs

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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r18b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r18b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
if (!process.env.ORDERS_ENCRYPTION_KEY) process.env.ORDERS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const realBlob = await import('@vercel/blob');
mock.module('@vercel/blob', {
  namedExports: {
    ...realBlob,
    head: async () => ({ contentType: 'image/jpeg', size: 1024 }),
    del: async () => {},
  },
});

const db = await import('./db.js');
const { query, closePool } = db;
const pg = (await import('pg')).default;
const creators = await import('./creators-store.js');
const users = await import('./users-store.js');
const orders = await import('./orders-store.js');
const reportsStore = await import('./reports-store.js');
const messages = await import('./messages-store.js');
const credits = await import('./credits-store.js');
const records = await import('./performer-records-store.js');
const rules = await import('./tracking-rules.js');
const { findCircumventionInTags } = await import('./listings-store.js');
const { encryptShippingAddress } = await import('./crypto.js');
const { createSessionToken } = await import('./session.js');
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
    end(b) { this.headersSent = true; if (b) { try { this.body = JSON.parse(b); } catch { this.body = b; } } },
  };
}
let ipN = 0;
async function call(route, { method = 'POST', body, user = null } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = {};
  const cookies = {};
  if (user) cookies.oa_session = createSessionToken(user.id, user.sessionVersion || 0);
  if (Object.keys(cookies).length) headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const req = { method, body, query: {}, headers, cookies, socket: { remoteAddress: `10.98.${Math.floor(ipN / 250)}.${ipN % 250}` } };
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r18bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r18b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r18b.test`, password: 'password123', role: 'fan' });
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
const count = async (sql, params = []) => (await query(sql, params)).rows[0].n;

// ---------------------------------------------------------------------------
section('money#0: short and low-digit carrier references ship; handovers are still refused');
{
  const E = (c, t) => rules.trackingFieldsError({ carrier: c, trackingNumber: t });
  for (const t of ['ZF8YY6HP', 'Z4JKW5X1', 'S2MXPQG3', 'ZF 8YY-6HP']) {
    check(`GLS TrackID ${t} is accepted`, E('Other', t) === null, JSON.stringify(E('Other', t)));
  }
  check('...with a non-blocking note only', typeof rules.trackingFormatWarning({ carrier: 'Other', trackingNumber: 'ZF8YY6HP' }) === 'string');
  check('an Australia Post merchant code "KIK" inside the number is accepted', E('Other', '33KIK1234567890') === null, JSON.stringify(E('Other', '33KIK1234567890')));
  const kik = E('Other', 'KIK12345678');
  check('...while "KIK" opening the number is still a suspected handover', kik && kik.suspicious === true, JSON.stringify(kik));
  check('an app name inside a number is still refused and suspicious', E('Other', 'VENMO123456')?.suspicious === true);
  check('an email address is still refused (not suspicious)', !!E('Other', 'jess@mail.com') && !E('Other', 'jess@mail.com').suspicious);
  // Round 19 (money#0, DECIDED): no digit minimum at all -- one-digit GLS
  // TrackIDs are real. A bare word/handle is the accepted residual; it gets
  // the non-blocking warning, and an app name is still refused.
  for (const t of ['ZFXYAB6H', 'ZF XYAB-6H', 'SVGKCEM', 'JESSXO1']) {
    check(`accepted with no digit floor: ${t}`, E('Other', t) === null, JSON.stringify(E('Other', t)));
    check(`...with a non-blocking note: ${t}`, typeof rules.trackingFormatWarning({ carrier: 'Other', trackingNumber: t }) === 'string');
  }
  check('a value under 6 characters is refused', !!E('Other', 'AB12'));
  check('real long numbers still pass with no note', E('UPS', '1Z999AA10123456784') === null
    && rules.trackingFormatWarning({ carrier: 'UPS', trackingNumber: '1Z999AA10123456784' }) === null);

  await reset();
  const { user } = await mkCreatorUser();
  const fan = await mkFan();
  const { rows } = await query('select id from creators order by id desc limit 1');
  const o = await mkOrder(rows[0].id, fan.id);
  const r = await call(shipRoute, { user, body: { orderId: o, carrier: 'Other', trackingNumber: 'ZF8YY6HP' } });
  check('the ship route marks a GLS order shipped', r.statusCode === 200 && r.body.order.trackingNumber === 'ZF8YY6HP', JSON.stringify(r.body));
  check('...and logs nothing to the violations queue', (await count('select count(*)::int as n from violations')) === 0);
  const o2 = await mkOrder(rows[0].id, fan.id);
  const r2 = await call(shipRoute, { user, body: { orderId: o2, carrier: 'Other', trackingNumber: '33KIK1234567890' } });
  check('a "33KIK..." number ships and is not logged', r2.statusCode === 200 && (await count('select count(*)::int as n from violations')) === 0,
    JSON.stringify(r2.body));
}

// ---------------------------------------------------------------------------
section('money#1/#2, legal-journeys#0, public-pages#0: erasure removes the address only; one shared tracking copy');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const fan = await mkFan();
  const o = await mkOrder(creator.id, fan.id);
  await call(shipRoute, { user, body: { orderId: o, carrier: 'UPS', trackingNumber: '1Z999AA10123456784' } });
  await orders.eraseOrderShippingAddress(o);
  const d = await orderData(o);
  check('the address is erased', d.shippingAddress === null && typeof d.addressErasedAt === 'string');
  check('...the carrier and tracking number stay, with no seller-only copy and no tracking stamp',
    d.carrier === 'UPS' && d.trackingNumber === '1Z999AA10123456784' && !('sellerTrackingNumber' in d) && !('trackingErasedAt' in d), JSON.stringify(d));
  const fix = await call(shipRoute, { user, body: { orderId: o, carrier: 'FedEx', trackingNumber: '748912345679' } });
  const buyer = (await orders.getOrdersForBuyer(String(fan.id)))[0];
  const seller = (await orders.getOrdersForCreator(creator.id))[0];
  check('a correction after the erasure is what BOTH sides see', fix.statusCode === 200 && buyer.carrier === 'FedEx' && seller.carrier === 'FedEx'
    && buyer.trackingNumber === '748912345679' && seller.trackingNumber === '748912345679', JSON.stringify({ buyer, seller }));
  check('...the buyer copy carries no address', buyer.shippingAddress === null);
  // Deleting the seller leaves nothing buyer-identifying on the order: the
  // address is already gone and the number is the seller's own reference.
  await quiet(() => creators.deleteCreator(String(creator.id), { force: true }));
  const after = await orderData(o);
  check('deleting the seller leaves no seller-only copy behind', !('sellerTrackingNumber' in after) && after.shippingAddress === null, JSON.stringify(after));

  // The cron sweep erases only the address of a gone buyer's order.
  const { creator: c2 } = await mkCreatorUser();
  const ghost = await mkOrder(c2.id, 'gone-user-r18b', { status: 'shipped', carrier: 'UPS', trackingNumber: '1Z999AA10123456793' });
  const swept = await orders.eraseAddressesOfDeletedBuyers();
  const g = await orderData(ghost);
  check('the sweep erases a gone buyer\'s address and keeps the number', swept === 1 && g.shippingAddress === null
    && g.trackingNumber === '1Z999AA10123456793', JSON.stringify(g));
  check('...and a second sweep has nothing to do', (await orders.eraseAddressesOfDeletedBuyers()) === 0);
}

section('the schema migration folds a stored seller-only copy back into trackingNumber');
{
  await reset();
  const a = await mkOrder('9', 'b1', { status: 'shipped', shippingAddress: null, carrier: 'UPS', trackingNumber: null,
    sellerTrackingNumber: '1Z999AA10123456784', trackingErasedAt: '2026-09-20T00:00:00.000Z', addressErasedAt: '2026-09-20T00:00:00.000Z',
    trackingHistory: [{ carrier: 'UPS', trackingNumber: null, replacedAt: '2026-09-19T00:00:00.000Z' }] });
  const b = await mkOrder('9', 'b2', { status: 'shipped', shippingAddress: null, carrier: 'UPS', trackingNumber: null,
    sellerTrackingNumber: null, trackingErasedAt: '2026-09-20T00:00:00.000Z' });
  const c = await mkOrder('9', 'b3', { status: 'shipped', shippingAddress: null, carrier: 'UPS', trackingNumber: null,
    trackingErasedAt: '2026-09-01T00:00:00.000Z' });
  const live = await mkOrder('9', 'b4', { status: 'shipped', carrier: 'USPS', trackingNumber: '9405511899223197428490' });
  // Force the schema (and its migrations) to apply again on the next query.
  await query(`delete from app_meta where key = 'schema_version'`);
  await closePool();
  await query('select 1');
  const da = await orderData(a);
  check('a stored seller copy becomes the one tracking number, and the stale erasure stamp goes',
    da.trackingNumber === '1Z999AA10123456784' && !('sellerTrackingNumber' in da) && !('trackingErasedAt' in da)
    && da.addressErasedAt === '2026-09-20T00:00:00.000Z' && da.trackingHistory.length === 1, JSON.stringify(da));
  const dbb = await orderData(b);
  check('an empty seller copy is just dropped (the order still says the number was erased)', !('sellerTrackingNumber' in dbb)
    && dbb.trackingNumber === null && !!dbb.trackingErasedAt, JSON.stringify(dbb));
  const dc = await orderData(c);
  check('an older erasure with no seller copy is untouched', dc.trackingErasedAt === '2026-09-01T00:00:00.000Z' && dc.trackingNumber === null, JSON.stringify(dc));
  check('an ordinary order is untouched', (await orderData(live)).trackingNumber === '9405511899223197428490');
  // A correction on an order erased before round 18 restores the number for the buyer too.
  const { creator: cc } = await mkCreatorUser();
  await query(`update orders set data = jsonb_set(data, '{creatorId}', to_jsonb($1::text)) where id = $2`, [String(cc.id), c]);
  const fixed = await orders.markOrderShipped(c, cc.id, { carrier: 'UPS', trackingNumber: '1Z999AA10123456801' });
  const after = await orderData(c);
  check('a correction on a legacy-erased order writes the number and drops the stale stamp', fixed.trackingNumber === '1Z999AA10123456801'
    && after.trackingNumber === '1Z999AA10123456801' && !('trackingErasedAt' in after), JSON.stringify(after));
}

// ---------------------------------------------------------------------------
section('money#3: rejecting a deleted account\'s payout forfeits it, never credits a balance for nobody');
{
  await reset();
  const WALLET = '0x' + '2'.repeat(40);
  const { creator, user } = await mkCreatorUser();
  await credits.creditAccount({ userId: String(user.id), cents: 25000, type: 'test_earn', withdrawable: true });
  const req = await credits.requestPayout({ userId: String(user.id), cents: 25000, payoutWallet: WALLET });
  await quiet(() => creators.deleteCreator(String(creator.id), { force: true }));
  check('setup: the login is gone and the payout still pending',
    (await count('select count(*)::int as n from users where id = $1', [String(user.id)])) === 0
    && (await credits.getPayoutRequest(req.id)).status === 'pending');
  const desc = (await credits.describePayoutRows([await credits.getPayoutRequest(req.id)]))[0];
  check('the admin payout row says the account is deleted', desc.account.deleted === true && desc.frozen === true, JSON.stringify(desc.account));
  const balBefore = await credits.getBalanceCents(String(user.id));
  const out = await credits.rejectPayout(req.id, 'account deleted');
  check('the request is rejected and flagged forfeited', out.status === 'rejected' && out.forfeited === true, JSON.stringify(out));
  check('...no balance was credited to the gone account', (await credits.getBalanceCents(String(user.id))) === balBefore, String(balBefore));
  const { rows: led } = await query(
    `select type, amount_cents from credit_ledger where user_id = $1 and meta->>'payoutRequestId' = $2 order by id`,
    [String(user.id), String(req.id)],
  );
  check('...the ledger records the reversal and the forfeiture, net zero',
    led.length === 2 && led[0].type === 'payout_reversed' && Number(led[0].amount_cents) === 25000
    && led[1].type === 'account_deleted' && Number(led[1].amount_cents) === -25000, JSON.stringify(led));
  check('...and no notification is written', (await count('select count(*)::int as n from notifications where user_id = $1', [String(user.id)])) === 0);
  let again = null;
  try { await credits.rejectPayout(req.id, 'again'); } catch (e) { again = e; }
  check('a second reject is refused (not pending)', again && again.code === credits.PAYOUT_NOT_PENDING, again && again.code);

  // Neighbour: a live account's rejected payout is refunded as withdrawable.
  const { user: u2 } = await mkCreatorUser();
  await credits.creditAccount({ userId: String(u2.id), cents: 3000, type: 'test_earn', withdrawable: true });
  const r2 = await credits.requestPayout({ userId: String(u2.id), cents: 3000, payoutWallet: WALLET });
  const desc2 = (await credits.describePayoutRows([await credits.getPayoutRequest(r2.id)]))[0];
  check('a live account is not marked deleted', desc2.account.deleted === false);
  const out2 = await credits.rejectPayout(r2.id, 'bad wallet');
  check('a live account\'s reject refunds the credits as withdrawable', !out2.forfeited
    && (await credits.getBalanceCents(String(u2.id))) === 3000 && (await credits.getWithdrawableCents(String(u2.id))) === 3000);
  check('...and tells them', (await count(`select count(*)::int as n from notifications where user_id = $1 and type = 'payout_rejected'`, [String(u2.id)])) === 1);
}

// ---------------------------------------------------------------------------
section('media#0 / social#0: deleting an account no longer deadlocks against a report resolve holding its DM');
{
  await reset();
  const { user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: String(fan.id), cents: 1000, type: 'test' });
  const first = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hi there', expectedPriceCents: 99 });
  const reply = await messages.sendDirectMessage({ sender: cu, recipientId: fan.id, text: 'hello you' });
  const convoId = first.conversation.id;
  const rep = await reportsStore.addReport({
    targetType: 'message', targetId: reply.message.id, conversationId: convoId, reporterId: String(fan.id), reason: 'r', category: 'other',
  });
  // The resolve's order: the conversation FIRST, then the report row.
  const a = new pg.Client({ connectionString: url });
  await a.connect();
  let aErr = null;
  let delErr = null;
  try {
    await a.query('begin');
    await a.query("set local lock_timeout = '8s'");
    await a.query('select 1 from conversations where id = $1 for update', [convoId]);
    const deletion = users.deleteFanAccount(String(fan.id), { force: true, strict: true }).catch((e) => { delErr = e; });
    await sleep(400);
    try {
      // The report row must be FREE: before round 18 the deletion already
      // held it here (and then waited on the conversation) -- a deadlock
      // that the deletion's own retry would only paper over. A short
      // lock_timeout (well under deadlock_timeout) makes any wait a failure.
      await a.query("set local lock_timeout = '250ms'");
      await a.query(`update reports set data = data || '{"r18bTouched": true}'::jsonb where id = $1`, [String(rep.id)]);
      await a.query('commit');
    } catch (e) {
      aErr = e;
      await a.query('rollback').catch(() => {});
    }
    await deletion;
  } finally {
    await a.end();
  }
  check('the resolve-side transaction commits (no deadlock, no wait on the report row)', !aErr, aErr && `${aErr.code} ${aErr.message}`);
  check('...and the deletion completes after it', !delErr && (await count('select count(*)::int as n from users where id = $1', [String(fan.id)])) === 0,
    delErr && `${delErr.code} ${delErr.message}`);
  const after = (await query('select data from reports where id = $1', [String(rep.id)])).rows[0].data;
  check('...the report stays, touched by the resolve and no longer naming the reporter', after.r18bTouched === true && !('reporterId' in after)
    && !!after.reporterDeletedAt, JSON.stringify(after));

  // social#1: the admin payload drops the conversation id and shows the gone reporter as null.
  const [shown] = await reportsStore.attachReportTargets([await reportsStore.getReportById(String(rep.id))]);
  check('the admin report carries no conversationId (it names the reporter)', !('conversationId' in shown)
    && !JSON.stringify(shown).includes(`${fan.id}__`) && !JSON.stringify(shown).includes(`__${fan.id}`), JSON.stringify(shown));
  check('...the live message target shows the gone participant as null', shown.target.exists === true
    && Array.isArray(shown.target.participantIds) && shown.target.participantIds.includes(null)
    && shown.target.participantIds.includes(String(cu.id)) && !shown.target.participantIds.includes(String(fan.id)), JSON.stringify(shown.target));
  check('...and never includes the reporter id anywhere', !JSON.stringify(shown).includes(String(fan.id)), JSON.stringify(shown));
}

section('social#1: a legacy report\'s delete-time copy does not put a purged reporter back');
{
  await reset();
  const { creator, user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: String(fan.id), cents: 1000, type: 'test' });
  const first = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hi there', expectedPriceCents: 99 });
  const reply = await messages.sendDirectMessage({ sender: cu, recipientId: fan.id, text: 'hello you' });
  // A report filed before filing-time copies existed: a pointer only.
  const rep = await reportsStore.addReport({
    targetType: 'message', targetId: reply.message.id, conversationId: first.conversation.id, reporterId: String(fan.id), reason: 'r', category: 'other',
  });
  await query(`update reports set data = data - 'reportedContent' where id = $1`, [String(rep.id)]);
  await users.deleteFanAccount(String(fan.id), { force: true, strict: true });
  await quiet(() => creators.deleteCreator(String(creator.id), { force: true }));
  const d = (await query('select data from reports where id = $1', [String(rep.id)])).rows[0].data;
  check('the sender\'s deletion copies the message onto the report', d.reportedContent && d.reportedContent.text === 'hello you', JSON.stringify(d));
  check('...with the purged reporter as null in its participant list', Array.isArray(d.reportedContent.participantIds)
    && d.reportedContent.participantIds.includes(null) && !d.reportedContent.participantIds.map(String).includes(String(fan.id)),
    JSON.stringify(d.reportedContent));
  const [shown] = await reportsStore.attachReportTargets([await reportsStore.getReportById(String(rep.id))]);
  check('...and the admin payload shows the snapshot without any conversation id', shown.target.fromSnapshot === true
    && !('conversationId' in shown.target) && !('conversationId' in (shown.reportedContent || {})) && !('conversationId' in shown), JSON.stringify(shown));
}

section('withTransactionRetryOnDeadlock retries a 40P01 once, and only that');
{
  let calls = 0;
  const r = await db.withTransactionRetryOnDeadlock(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    return 'ok';
  });
  check('a single deadlock is retried and succeeds', r === 'ok' && calls === 2, String(calls));
  let calls2 = 0;
  let err = null;
  try {
    await db.withTransactionRetryOnDeadlock(async () => { calls2 += 1; throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); });
  } catch (e) { err = e; }
  check('...a second deadlock is thrown', err && err.code === '40P01' && calls2 === 2, String(calls2));
  let calls3 = 0;
  err = null;
  try {
    await db.withTransactionRetryOnDeadlock(async () => { calls3 += 1; throw Object.assign(new Error('other'), { code: '23505' }); });
  } catch (e) { err = e; }
  check('...any other error is not retried', err && err.code === '23505' && calls3 === 1, String(calls3));
}

// ---------------------------------------------------------------------------
section('admin-ui#0: a §2257 alias search typed with "@" finds the alias');
{
  const rec = { id: '1', aliases: ['luna', 'luna rae'], contentUrls: ['https://joinonlyone.com/creator/3'], legalName: 'Jane Q Public' };
  check('"@luna" finds the stored alias "luna"', records.matchesRecord(rec, '@luna'));
  check('"@Luna Rae" finds the stored alias', records.matchesRecord(rec, '@Luna Rae'));
  check('"luna" still finds it', records.matchesRecord(rec, 'luna'));
  check('"@nobody" does not match', !records.matchesRecord(rec, '@nobody'));
  check('a bare "@" matches no alias (and no other field)', !records.matchesRecord({ ...rec, contentUrls: [] }, '@'));
  check('the legal-name check still uses the term as typed', records.matchesRecord(rec, 'jane q') && !records.matchesRecord(rec, '@jane q'));
}

// ---------------------------------------------------------------------------
section('srv-auth-core#1 (site half): a run of single-word tags is judged as one label');
{
  for (const t of [['16', 'girl'], ['16', 'hot', 'girl'], ['sixteen', 'and', 'ready'], ['fifteen', 'years', 'old'], ['16', 'and', 'petite'],
    ['16', 'tight', 'pussy'], ['hot', 'sixteen', 'slut'], ['cosplay', '16', 'virgin']]) {
    const hit = findCircumventionInTags(t);
    check(`${JSON.stringify(t)} is refused`, hit && hit.kind === 'prohibited', JSON.stringify(hit));
  }
  for (const t of [['1080p', 'girl'], ['y2k', 'girl'], ['16', 'girls'], ['cosplay', 'lingerie'], ['blonde', 'milf'], ['4k', 'video'],
    ['top', '10', 'babes'], ['size', '16', 'dress'], ['2016', 'girl'], ['essex', '16'], ['latex', 'redhead', 'curvy']]) {
    check(`${JSON.stringify(t)} passes`, findCircumventionInTags(t) === null, JSON.stringify(findCircumventionInTags(t)));
  }
}

for (const f of failures) console.log('  FAILED:', f);
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
