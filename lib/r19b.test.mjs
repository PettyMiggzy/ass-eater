// Regression tests for the round-19 backend fixes (package R19B), run against a
// real scratch Postgres (it truncates tables). The text-screen findings have
// their own pure suites: lib/screen-generated.test.mjs (the combinatorial
// minor-age spec) and lib/screen-corpus.test.mjs (every named string).
//  - money#0 (DECIDED): no digit minimum on a tracking number -- a one-digit
//    GLS TrackID ships through the real route; an app name is still refused;
//  - media#0 / admin-ui#0 / legal-journeys#0: every report body
//    /api/admin/reports-resolve returns (success, 409, reopen) is stripped of
//    the DM conversation id; the content lookup returns a deleted participant
//    without an id;
//  - media#1 / money#1: a DM send takes the users rows before the
//    conversation, so it waits behind an account deletion instead of
//    deadlocking with it -- and then refuses, the account being gone;
//  - public-pages#0: an unread notification older than the newest 30 is
//    listed and clearable; a coalesced notice is refreshed to the newest;
//    "mark all read" and exact-id marking;
//  - dashboard#0 (server half): an unchanged legacy wallet does not block an
//    unrelated profile save.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r19b.test.mjs

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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r19b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r19b';
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
const reportsStore = await import('./reports-store.js');
const messages = await import('./messages-store.js');
const notes = await import('./notifications-store.js');
const { encryptShippingAddress } = await import('./crypto.js');
const { createSessionToken } = await import('./session.js');
const { default: shipRoute } = await import('../pages/api/marketplace/orders/ship.js');
const { default: resolveRoute } = await import('../pages/api/admin/reports-resolve.js');
const { default: lookupRoute } = await import('../pages/api/admin/content-lookup.js');
const { default: notificationsRoute } = await import('../pages/api/notifications/index.js');
const { default: readRoute } = await import('../pages/api/notifications/read.js');
const { default: profileRoute } = await import('../pages/api/me/profile.js');

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
async function call(route, { method = 'POST', body, user = null, admin = false, q = {} } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = {};
  const cookies = {};
  if (user) cookies.oa_session = createSessionToken(user.id, user.sessionVersion || 0);
  if (Object.keys(cookies).length) headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  const req = { method, body, query: q, headers, cookies, socket: { remoteAddress: `10.97.${Math.floor(ipN / 250)}.${ipN % 250}` } };
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r19bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r19b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r19b.test`, password: 'password123', role: 'fan' });
}

// ---------------------------------------------------------------------------
section('money#0: a one-digit GLS TrackID ships through the real route; app names are still refused');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const fan = await mkFan();
  const addr = encryptShippingAddress({ fullName: 'A B', line1: '1 Main St', city: 'X', postalCode: '1', country: 'US' });
  const mk = async () => String((await query('insert into orders (data) values ($1::jsonb) returning id', [JSON.stringify({
    creatorId: String(creator.id), buyerId: String(fan.id), title: 'Poster', kind: 'physical', status: 'pending_shipment', shippingAddress: addr,
  })])).rows[0].id);
  const o1 = await mk();
  const r = await call(shipRoute, { user, body: { orderId: o1, carrier: 'Other', trackingNumber: 'ZFXYAB6H' } });
  check('a one-digit GLS TrackID ships', r.statusCode === 200 && r.body.order?.trackingNumber === 'ZFXYAB6H', JSON.stringify(r.body));
  check('...with a non-blocking warning', typeof r.body.warning === 'string', JSON.stringify(r.body));
  const o2 = await mk();
  const r2 = await call(shipRoute, { user, body: { orderId: o2, carrier: 'Other', trackingNumber: 'DISCORDJESS1' } });
  check('an app name with one digit is refused (400)', r2.statusCode === 400 && r2.body.field === 'trackingNumber', JSON.stringify(r2.body));
  const r3 = await call(shipRoute, { user, body: { orderId: o2, carrier: 'Other', trackingNumber: 'jess@mail.com' } });
  check('an email address is refused', r3.statusCode === 400, JSON.stringify(r3.body));
}

// ---------------------------------------------------------------------------
section('media#0 / admin-ui#0 / legal-journeys#0: no reports-resolve body carries the DM conversation id');
{
  await reset();
  const { user: creatorUser } = await mkCreatorUser();
  const reporterId = 'purged-reporter-uid';
  const convo = messages.conversationIdBetween(reporterId, String(creatorUser.id));
  const mkReport = (extra = {}) => reportsStore.addReport({
    targetType: 'message', targetId: 'm-1', conversationId: convo, category: 'spam', reason: 'x',
    reporterDeletedAt: new Date().toISOString(),
    reportedContent: { text: 'hi', senderId: String(creatorUser.id), conversationId: convo, participantIds: [null, String(creatorUser.id)] },
    ...extra,
  });
  const noConvo = (report) => !!report && !JSON.stringify(report).includes(convo) && !JSON.stringify(report).includes(reporterId);
  const rep = await mkReport();
  const ok = await call(resolveRoute, { admin: true, body: { id: String(rep.id), action: 'dismiss' } });
  check('the dismiss (200) body has no conversation id', ok.statusCode === 200 && noConvo(ok.body.report), JSON.stringify(ok.body));
  const again = await call(resolveRoute, { admin: true, body: { id: String(rep.id), action: 'dismiss' } });
  check('the 409 already_resolved body has none either', again.statusCode === 409 && again.body.code === 'already_resolved'
    && noConvo(again.body.report), JSON.stringify(again.body));
  const reopened = await call(resolveRoute, { admin: true, body: { id: String(rep.id), action: 'reopen', reason: 'second look' } });
  check('the reopen body has none either', reopened.statusCode === 200 && noConvo(reopened.body.report), JSON.stringify(reopened.body));
  const stored = await reportsStore.getReportById(String(rep.id));
  check('...while the STORED report keeps it (moderation reads it)', stored.conversationId === convo && stored.reportedContent?.conversationId === convo);
  check('stripReporterTrail drops the top-level id and the copies\'', (() => {
    const s = reportsStore.stripReporterTrail({ conversationId: 'a__b', reporterId: 'a', reporterDeletedAt: 'x',
      reportedContent: { conversationId: 'a__b', text: 't' }, removedContent: { conversationId: 'a__b' } });
    return !('conversationId' in s) && !('reporterId' in s) && !('conversationId' in s.reportedContent) && !('conversationId' in s.removedContent);
  })());
  check('...and keeps an unpurged reporter id', reportsStore.stripReporterTrail({ reporterId: 'r1', conversationId: 'r1__c' }).reporterId === 'r1');

  // The content lookup: a deleted participant carries no id.
  await query(`insert into conversations (id, data) values ($1, $2::jsonb)`, [convo, JSON.stringify({
    id: convo, participantIds: [reporterId, String(creatorUser.id)],
    messages: [
      { id: 'm-1', senderId: String(creatorUser.id), text: 'hi', createdAt: new Date().toISOString() },
      { id: 'm-2', senderId: reporterId, text: 'yo', createdAt: new Date().toISOString() },
    ], senders: [String(creatorUser.id), reporterId],
  })]);
  const look = await call(lookupRoute, { method: 'GET', admin: true, q: { kind: 'messages', conversationId: convo } });
  const gone = look.body?.conversation?.participants?.find((p) => p.deleted);
  check('the lookup marks the deleted participant', look.statusCode === 200 && !!gone, JSON.stringify(look.body));
  check('...with no id', gone && gone.userId === null && !JSON.stringify(look.body.conversation.participants).includes(reporterId),
    JSON.stringify(look.body?.conversation?.participants));
  const list = await call(lookupRoute, { method: 'GET', admin: true, q: { kind: 'conversations', userId: String(creatorUser.id) } });
  const other = list.body?.conversations?.[0]?.other;
  check('the conversation list shows the other side as deleted, no id', other?.deleted === true && other.userId === null, JSON.stringify(list.body));
  // R19U2: a message's senderId is null when its sender is the deleted account.
  const msgs = look.body?.conversation?.messages || [];
  check('a deleted sender\'s message carries senderId null', msgs.find((m) => m.id === 'm-2')?.senderId === null, JSON.stringify(msgs));
  check('...a live sender\'s keeps its id', msgs.find((m) => m.id === 'm-1')?.senderId === String(creatorUser.id), JSON.stringify(msgs));
  check('the deleted id is nowhere in the messages', !JSON.stringify(msgs).includes(reporterId), JSON.stringify(msgs));
  check('the conversation list\'s lastMessage from the deleted sender has senderId null',
    list.body?.conversations?.[0]?.lastMessage?.senderId === null, JSON.stringify(list.body?.conversations?.[0]));
}

// ---------------------------------------------------------------------------
section('media#1 / money#1: a DM send waits behind an account deletion instead of deadlocking with it');
{
  await reset();
  const a = await mkCreatorUser();
  const b = await mkCreatorUser();
  // creator <-> creator is allowed and free; the conversation exists already.
  const first = await messages.sendDirectMessage({ sender: a.user, recipientId: String(b.user.id), text: 'hello' });
  check('a first message goes through', !!first.message);
  const convo = messages.conversationIdBetween(String(a.user.id), String(b.user.id));
  const deleter = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const probe = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await deleter.connect();
  await probe.connect();
  try {
    await deleter.query('begin');
    await deleter.query('select id from users where id = $1 for update', [String(b.user.id)]);
    let settled = null;
    const sending = messages.sendDirectMessage({ sender: a.user, recipientId: String(b.user.id), text: 'during deletion' })
      .then((v) => { settled = { ok: v }; }, (e) => { settled = { err: e }; });
    await sleep(300);
    check('the send is waiting on the deletion', settled === null, JSON.stringify(settled));
    await probe.query('begin');
    let convoFree = true;
    try {
      await probe.query('select 1 from conversations where id = $1 for update nowait', [convo]);
    } catch {
      convoFree = false;
    }
    await probe.query('rollback');
    check('...WITHOUT holding the conversation lock (users are taken first)', convoFree);
    // The deletion now takes the conversation (as purgeUserContent does) and
    // deletes the account: no deadlock.
    await deleter.query('select 1 from conversations where id = $1 for update', [convo]);
    await deleter.query('delete from users where id = $1', [String(b.user.id)]);
    await deleter.query('commit');
    await sending;
    check('the send then refuses: the account is gone', settled?.err?.code === messages.DM_ERRORS.RECIPIENT_NOT_FOUND,
      String(settled?.err?.code || settled?.err?.message || JSON.stringify(settled?.ok?.message)));
  } finally {
    await deleter.end().catch(() => {});
    await probe.end().catch(() => {});
  }
  check('withTransactionRetryOnDeadlock is exported for the send', typeof db.withTransactionRetryOnDeadlock === 'function');
}

// ---------------------------------------------------------------------------
section('public-pages#0: every unread notification is listed and clearable; coalescing refreshes to the newest');
{
  await reset();
  const { user } = await mkCreatorUser();
  const uid = String(user.id);
  await notes.createNotification({ userId: uid, type: 'message', message: 'New message from A', meta: { fromUserId: 'a' }, coalesceKey: 'fromUserId' });
  const { rows: [oldest] } = await query('select id from notifications where user_id = $1', [uid]);
  for (let i = 0; i < 35; i++) await notes.createNotification({ userId: uid, type: 'sale', message: `sale ${i}` });
  const page = await call(notificationsRoute, { method: 'GET', user });
  const ids = page.body.notifications.map((x) => Number(x.id));
  check('the oldest unread row is in the list beyond the newest 30', ids.includes(Number(oldest.id)), JSON.stringify(ids.slice(-3)));
  check('unreadCount counts every unread row', page.body.unreadCount === 36, String(page.body.unreadCount));
  check('the list is newest first', ids.every((v, i) => i === 0 || ids[i - 1] > v));
  // A new message from A while its old notice is still unread: refreshed to
  // the newest, still one row.
  await notes.createNotification({ userId: uid, type: 'message', message: 'New message from A', meta: { fromUserId: 'a' }, coalesceKey: 'fromUserId' });
  const { rows: aRows } = await query(`select id from notifications where user_id = $1 and type = 'message'`, [uid]);
  const newest = await notes.getNotificationsForUser(uid, 1);
  check('one unread row for the sender', aRows.length === 1);
  check('...now the newest of all', Number(newest[0].id) === Number(aRows[0].id) && newest[0].type === 'message');
  // Exact ids: marking two shown rows leaves a row in the id gap unread.
  const all = (await notes.getNotificationsPage(uid)).map((x) => Number(x.id)).sort((x, y) => x - y);
  const [lo, mid, hi] = [all[0], all[1], all[2]];
  const r = await call(readRoute, { user, body: { ids: [lo, hi] } });
  check('ids marks exactly those rows', r.statusCode === 200 && r.body.marked === 2, JSON.stringify(r.body));
  const { rows: midRow } = await query('select read_at from notifications where id = $1', [mid]);
  check('...never the row between them', midRow[0].read_at === null);
  const other = await mkFan();
  const foreign = await call(readRoute, { user: other, body: { ids: [mid] } });
  check('another account cannot mark my rows', foreign.body.marked === 0 && (await query('select read_at from notifications where id = $1', [mid])).rows[0].read_at === null);
  const bad = await call(readRoute, { user, body: { ids: 'nope' } });
  check('a non-list ids is a 400', bad.statusCode === 400);
  const allRes = await call(readRoute, { user, body: { all: true } });
  check('mark all read clears every unread row', allRes.statusCode === 200 && allRes.body.unreadCount === 0, JSON.stringify(allRes.body));
  const legacy = await call(readRoute, { user, body: { upToId: 1 } });
  check('the legacy range form still answers', legacy.statusCode === 200);
  await notes.createNotification({ userId: uid, type: 'message', message: 'New message from A', meta: { fromUserId: 'a' }, coalesceKey: 'fromUserId' });
  check('after reading, the sender notifies again', (await notes.getUnreadCount(uid)) === 1);
}

// ---------------------------------------------------------------------------
section('dashboard#0 (server half): an unchanged legacy wallet does not block a profile save');
{
  await reset();
  // A mixed-case address whose EIP-55 checksum fails: saved under an older rule.
  const lower = '0x' + 'ab'.repeat(20);
  const legacy = '0xAbAbabababababababababababababababababaB';
  const { creator, user } = await mkCreatorUser({ walletAddress: legacy, payoutMethod: 'usdg' });
  const r = await call(profileRoute, { user, body: { fields: { bio: 'A brand new bio for round nineteen', walletAddress: legacy, payoutMethod: 'usdg' } } });
  check('the bio saves with the legacy wallet echoed unchanged', r.statusCode === 200, JSON.stringify(r.body));
  const saved = await creators.getCreatorById(creator.id);
  check('...and the wallet is left as it was', saved.walletAddress === legacy && /round nineteen/.test(saved.bio || ''), JSON.stringify([saved.walletAddress, saved.bio]));
  const changed = await call(profileRoute, { user, body: { fields: { walletAddress: '0xAbAbabababababababababababababababababaC' } } });
  check('a CHANGED bad-checksum wallet is still refused', changed.statusCode === 400, JSON.stringify(changed.body));
  const fine = await call(profileRoute, { user, body: { fields: { walletAddress: lower } } });
  check('a changed valid wallet saves (checksummed)', fine.statusCode === 200 && /^0x[0-9a-fA-F]{40}$/.test((await creators.getCreatorById(creator.id)).walletAddress));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
for (const f of failures) console.log('  FAILED:', f);
await closePool();
process.exit(fail ? 1 : 0);
