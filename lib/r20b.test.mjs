// Regression tests for the round-20 backend fixes (package R20B), run against a
// real scratch Postgres (it truncates tables). The text-screen findings
// (accounts#0-#11) have their own pure suites: lib/screen-generated.test.mjs
// (a generator FAMILY per rule) and lib/screen-corpus.test.mjs (every named
// string).
//  - media#0 / social#0: a DM takedown's copy lists a deleted participant as
//    null; no admin response (ncii-reports, ncii-reports-resolve,
//    content-takedown POST/GET) carries the "<a>__<b>" conversation id; the
//    content lookup returns a SEALED reference for a thread with a deleted
//    participant, which the thread lookup and the takedown accept; deleting
//    an account nulls its id in stored takedown copies;
//  - social#1: a wall comment, a report and a sender-named notification
//    racing their author's account deletion wait for it and then write
//    nothing;
//  - legal-journeys#0: the §2257 keep-until date runs from the record's
//    creation / last amendment, never earlier;
//  - dashboard#0 (backend): /api/credits/balance says whether the SAVED
//    payout wallet can be paid.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r20b.test.mjs

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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r20b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r20b';
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
const wall = await import('./wall-store.js');
const ncii = await import('./ncii-reports-store.js');
const records = await import('./performer-records-store.js');
const takedown = await import('./content-takedown.js');
const { AUTHOR_ACCOUNT_GONE } = await import('./author-lock.js');
const { payoutWalletStatus } = await import('./credits-store.js');
const { createSessionToken } = await import('./session.js');
const { default: nciiListRoute } = await import('../pages/api/admin/ncii-reports.js');
const { default: nciiResolveRoute } = await import('../pages/api/admin/ncii-reports-resolve.js');
const { default: takedownRoute } = await import('../pages/api/admin/content-takedown.js');
const { default: lookupRoute } = await import('../pages/api/admin/content-lookup.js');
const { default: balanceRoute } = await import('../pages/api/credits/balance.js');

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
  const req = { method, body, query: q, headers, cookies, socket: { remoteAddress: `10.98.${Math.floor(ipN / 250)}.${ipN % 250}` } };
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r20bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r20b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r20b.test`, password: 'password123', role: 'fan' });
}
async function mkConversation(a, b, msgs) {
  const id = messages.conversationIdBetween(String(a), String(b));
  await query(`insert into conversations (id, data) values ($1, $2::jsonb)`, [id, JSON.stringify({
    id, participantIds: [String(a), String(b)],
    messages: msgs.map((m) => ({ createdAt: new Date().toISOString(), ...m })),
    senders: [...new Set(msgs.map((m) => String(m.senderId)))],
  })]);
  return id;
}
// A second connection holding the account's users row FOR UPDATE, the way
// deleteFanAccount / creator deletion do, then deleting it.
async function withDeletionInProgress(userId, raceFn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('begin');
    await c.query('select id from users where id = $1 for update', [String(userId)]);
    const racing = quiet(() => raceFn()).then((v) => ({ v }), (e) => ({ e }));
    await sleep(200);
    await c.query('delete from notifications where user_id = $1', [String(userId)]);
    await c.query('delete from users where id = $1', [String(userId)]);
    await c.query('commit');
    return await racing;
  } finally {
    await c.end();
  }
}

// ---------------------------------------------------------------------------
section('media#0 / social#0: a DM takedown never hands the admin a deleted participant\'s id');
{
  await reset();
  const { user: creatorUser } = await mkCreatorUser();
  const purged = 'purged-fan-uid-r20b';
  const convo = await mkConversation(purged, creatorUser.id, [
    { id: 'm-1', senderId: String(creatorUser.id), text: 'the reported message' },
    { id: 'm-2', senderId: String(creatorUser.id), text: 'another one' },
  ]);
  const hasId = (v) => JSON.stringify(v).includes(convo) || JSON.stringify(v).includes(purged);

  // The lookup seals the id of a thread with a deleted participant.
  const list = await call(lookupRoute, { method: 'GET', admin: true, q: { kind: 'conversations', userId: String(creatorUser.id) } });
  const ref = list.body?.conversations?.[0]?.id;
  check('the conversation list returns a sealed reference', list.statusCode === 200 && typeof ref === 'string' && ref.startsWith('ref.'),
    JSON.stringify(list.body));
  check('...with neither id in the whole response', !hasId(list.body), JSON.stringify(list.body));
  const thread = await call(lookupRoute, { method: 'GET', admin: true, q: { kind: 'messages', conversationId: ref } });
  check('the thread lookup opens the sealed reference', thread.statusCode === 200 && thread.body.conversation?.messageCount === 2,
    JSON.stringify(thread.body));
  check('...and returns it sealed again, with no id anywhere', thread.body.conversation?.id?.startsWith('ref.') && !hasId(thread.body),
    JSON.stringify(thread.body));
  const forged = await call(lookupRoute, { method: 'GET', admin: true, q: { kind: 'messages', conversationId: 'ref.AAAAforged' } });
  check('a forged reference is not a conversation', forged.statusCode === 404, JSON.stringify(forged.body));
  check('parseTakedownTarget opens the reference to the real id',
    takedown.parseTakedownTarget({ type: 'message', conversationId: ref, messageId: 'm-1' }).target?.conversationId === convo);
  check('...and refuses a forged one', !!takedown.parseTakedownTarget({ type: 'message', conversationId: 'ref.zzzz', messageId: 'm-1' }).error);

  // A live thread keeps its plain id.
  const { user: other } = await mkCreatorUser();
  const liveConvo = await mkConversation(other.id, creatorUser.id, [{ id: 'm-9', senderId: String(other.id), text: 'hi' }]);
  const list2 = await call(lookupRoute, { method: 'GET', admin: true, q: { kind: 'conversations', userId: String(other.id) } });
  check('a thread whose participants all exist keeps its plain id', list2.body?.conversations?.[0]?.id === liveConvo, JSON.stringify(list2.body));

  // The takedown, through the real route, with the sealed reference.
  const req = await ncii.addNciiReport({ category: 'self', contentLocation: 'a DM', description: 'x', consentStatement: true });
  const td = await call(takedownRoute, { admin: true, body: { type: 'message', conversationId: ref, messageId: 'm-1', nciiReportId: String(req.id) } });
  check('the takedown by sealed reference removes the message', td.statusCode === 200 && td.body.result === 'removed', JSON.stringify(td.body));
  check('...and its response carries neither id', !hasId(td.body), JSON.stringify(td.body));
  const { rows: act } = await query('select data from moderation_actions order by id desc limit 1');
  check('the stored audit row keeps the conversation id (the audit record)', act[0].data.target?.conversationId === convo, JSON.stringify(act[0].data));
  check('...and its copy lists the deleted participant as null',
    JSON.stringify(act[0].data.snapshot?.participantIds) === JSON.stringify([null, String(creatorUser.id)]), JSON.stringify(act[0].data.snapshot));
  const audit = await call(takedownRoute, { method: 'GET', admin: true, q: { nciiReportId: String(req.id) } });
  check('GET content-takedown (the audit trail) carries neither id', audit.statusCode === 200 && audit.body.actions?.length === 1
    && !hasId(audit.body), JSON.stringify(audit.body));
  const page = await call(nciiListRoute, { method: 'GET', admin: true, q: { status: 'all' } });
  const entry = page.body?.reports?.find((r) => String(r.id) === String(req.id));
  check('GET ncii-reports lists the takedown', entry?.takedowns?.length === 1 && entry.takedowns[0].target?.messageId === 'm-1', JSON.stringify(entry));
  check('...with neither id in takedowns or history', !hasId(page.body), JSON.stringify(entry));
  const resolved = await call(nciiResolveRoute, { admin: true, body: { id: String(req.id), action: 'removed' } });
  check('the resolve response carries neither id', resolved.statusCode === 200 && !hasId(resolved.body), JSON.stringify(resolved.body));
  const { rows: stored } = await query('select data from ncii_reports where id = $1', [req.id]);
  check('...while the stored request keeps it', stored[0].data.takedowns?.[0]?.target?.conversationId === convo);

  // Deleting an account AFTER the takedown nulls it in the stored copy.
  const fan = await mkFan();
  const convo2 = await mkConversation(fan.id, creatorUser.id, [{ id: 'm-5', senderId: String(creatorUser.id), text: 'x' }]);
  const req2 = await ncii.addNciiReport({ category: 'self', contentLocation: 'a DM', description: 'y', consentStatement: true });
  await quiet(() => takedown.takeDownContent({ type: 'message', conversationId: convo2, messageId: 'm-5' }, { nciiReportId: String(req2.id) }));
  const { rows: before } = await query('select data from ncii_reports where id = $1', [req2.id]);
  check('a live participant is in the copy before deletion',
    JSON.stringify(before[0].data.takedowns[0].snapshot.participantIds) === JSON.stringify([String(fan.id), String(creatorUser.id)]));
  await users.deleteFanAccount(fan.id, { force: true });
  const { rows: after } = await query('select data from ncii_reports where id = $1', [req2.id]);
  check('deleting the account nulls it in the stored takedown copy',
    JSON.stringify(after[0].data.takedowns[0].snapshot.participantIds) === JSON.stringify([null, String(creatorUser.id)]),
    JSON.stringify(after[0].data.takedowns[0].snapshot));
  const audit2 = await takedown.listModerationActions({ nciiReportId: String(req2.id) });
  check('the audit trail reads the deleted participant as null',
    JSON.stringify(audit2[0]?.snapshot?.participantIds) === JSON.stringify([null, String(creatorUser.id)])
    && !JSON.stringify(audit2).includes(String(fan.id)), JSON.stringify(audit2));

  // snapshotMessage itself (also the report-filing copy).
  const snap = await reportsStore.snapshotMessage({ id: 'x', senderId: String(creatorUser.id), text: 't' },
    { conversationId: 'a__b', participantIds: ['gone-uid', String(creatorUser.id)] });
  check('snapshotMessage copies a participant with no account as null', JSON.stringify(snap.participantIds) === JSON.stringify([null, String(creatorUser.id)]));
}

// ---------------------------------------------------------------------------
section('social#1: a comment / report / notification racing its author\'s deletion writes nothing');
{
  await reset();
  const { creator, user: creatorUser } = await mkCreatorUser();
  const fan = await mkFan();
  const r1 = await withDeletionInProgress(fan.id, () => wall.addWallPost({
    creatorId: String(creator.id), authorId: String(fan.id), authorName: 'F', text: 'racing comment', requireAuthor: true,
  }));
  check('the comment waited and was refused (account gone)', r1.e?.code === AUTHOR_ACCOUNT_GONE, JSON.stringify(r1));
  const { rows: posts } = await query(`select 1 from wall_posts where data->>'authorId' = $1`, [String(fan.id)]);
  check('...and no comment row exists', posts.length === 0);

  const fan2 = await mkFan();
  const r2 = await withDeletionInProgress(fan2.id, () => reportsStore.addReport({
    targetType: 'wall_post', targetId: '1', category: 'other', reason: 'x', reporterId: String(fan2.id),
  }, { requireReporter: true }));
  check('the report waited and was refused', r2.e?.code === AUTHOR_ACCOUNT_GONE, JSON.stringify(r2));
  const { rows: reps } = await query(`select 1 from reports where data->>'reporterId' = $1`, [String(fan2.id)]);
  check('...and no report names the deleted reporter', reps.length === 0);

  const fan3 = await mkFan();
  await withDeletionInProgress(fan3.id, () => notes.createNotification({
    userId: String(creatorUser.id), type: 'message', message: 'New message from fan3', meta: { fromUserId: String(fan3.id) },
    coalesceKey: 'fromUserId', actorId: String(fan3.id),
  }));
  const { rows: bell } = await query(`select 1 from notifications where meta->>'fromUserId' = $1`, [String(fan3.id)]);
  check('a notification naming a sender deleted in between is not written', bell.length === 0);
  await notes.createNotification({ userId: String(creatorUser.id), type: 'wall_comment', message: 'x', meta: {}, actorId: 'never-existed' });
  check('...nor one naming an account that does not exist', (await query(`select 1 from notifications where type = 'wall_comment'`)).rows.length === 0);
  const fan4 = await mkFan();
  await notes.createNotification({ userId: String(creatorUser.id), type: 'message', message: 'hi', meta: { fromUserId: String(fan4.id) },
    coalesceKey: 'fromUserId', actorId: String(fan4.id) });
  check('a live sender\'s notification is written', (await query(`select 1 from notifications where meta->>'fromUserId' = $1`, [String(fan4.id)])).rows.length === 1);

  // A live author is not blocked by the lock.
  const post = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan4.id), authorName: 'F4', text: 'hello', requireAuthor: true });
  check('a live author\'s comment posts', !!post?.id);
  const own = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(creatorUser.id), authorName: 'C', text: 'owner', isWallOwner: true, requireAuthor: true });
  check('...and the wall owner\'s', !!own?.id);
  const gone = await wall.addWallPost({ creatorId: String(creator.id), authorId: 'nobody', authorName: 'N', text: 'x', requireAuthor: true }).catch((e) => e);
  check('a comment by an account that does not exist is refused', gone?.code === AUTHOR_ACCOUNT_GONE);
}

// ---------------------------------------------------------------------------
section('legal-journeys#0: §2257 keep-until runs from creation / last amendment');
{
  await reset();
  const floor = () => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() + 7); return d.getTime() - 60_000; };
  const rec = await records.createPerformerRecord({ legalName: 'Ada Example', dateOfBirth: '1990-01-01', producedAt: '2019-03-01' });
  check('a record for 2019 content created today keeps until at least today + 7 years',
    new Date(rec.retainUntil).getTime() >= floor(), rec.retainUntil);
  check('retainUntil(producedAt) never counts from a past production date',
    new Date(records.retainUntil('2019-03-01')).getTime() >= floor());
  await query(`update performer_records set data = jsonb_set(data, '{retainUntil}', '"2026-03-01T00:00:00.000Z"') where id = $1`, [rec.id]);
  const upd = await records.updatePerformerRecord(rec.id, { notes: 'renewed alias' });
  check('an amendment moves an earlier keep-until to now + 7 years', new Date(upd.retainUntil).getTime() >= floor(), upd.retainUntil);
  await query(`update performer_records set data = jsonb_set(data, '{retainUntil}', '"2099-01-01T00:00:00.000Z"') where id = $1`, [rec.id]);
  const upd2 = await records.updatePerformerRecord(rec.id, { notes: 'again' });
  check('...and never moves a later one earlier', upd2.retainUntil === '2099-01-01T00:00:00.000Z', upd2.retainUntil);
  await query(`update performer_records set data = jsonb_set(data, '{retainUntil}', '"2020-01-01T00:00:00.000Z"') where id = $1`, [rec.id]);
  const att = await records.attachPerformerDocument(rec.id, Buffer.from('fake-jpeg-bytes'), 'image/jpeg', 'id.jpg');
  check('attaching an ID document is an amendment too', new Date(att.retainUntil).getTime() >= floor(), att.retainUntil);
  await query(`update performer_records set data = jsonb_set(data, '{retainUntil}', '"2020-01-01T00:00:00.000Z"') where id = $1`, [rec.id]);
  const arch = await records.archivePerformerRecord(rec.id, 'duplicate');
  check('so is archiving', arch && new Date(arch.retainUntil).getTime() >= floor(), arch?.retainUntil);
}

// ---------------------------------------------------------------------------
section('dashboard#0 (backend): the balance says whether the saved payout wallet can be paid');
{
  await reset();
  const lower = '0x52908400098527886e0f7030069857d2e4169ee7';
  const badChecksum = '0x52908400098527886E0F7030069857D2E4169eE7';
  const { user } = await mkCreatorUser({ walletAddress: badChecksum, payoutMethod: 'usdg' });
  const r = await call(balanceRoute, { method: 'GET', user });
  check('a legacy bad-checksum wallet reads saved but not payable', r.statusCode === 200 && r.body.payoutWallet?.saved === true
    && r.body.payoutWallet.payable === false && typeof r.body.payoutWallet.error === 'string', JSON.stringify(r.body));
  const { user: u2 } = await mkCreatorUser({ walletAddress: lower, payoutMethod: 'usdg' });
  const r2 = await call(balanceRoute, { method: 'GET', user: u2 });
  check('a valid wallet is payable', r2.body.payoutWallet?.payable === true && r2.body.payoutWallet.error === null, JSON.stringify(r2.body));
  const { user: u3 } = await mkCreatorUser({});
  const r3 = await call(balanceRoute, { method: 'GET', user: u3 });
  check('no wallet reads not saved', r3.body.payoutWallet?.saved === false && r3.body.payoutWallet.payable === false, JSON.stringify(r3.body));
  const fan = await mkFan();
  const r4 = await call(balanceRoute, { method: 'GET', user: fan });
  check('a fan gets payoutWallet: null', r4.statusCode === 200 && r4.body.payoutWallet === null, JSON.stringify(r4.body));
  check('payoutWalletStatus agrees with the payout rule', payoutWalletStatus('  ').saved === false && payoutWalletStatus(lower).payable === true
    && payoutWalletStatus('0x0000000000000000000000000000000000000000').payable === false);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
for (const f of failures) console.log('  FAILED:', f);
await closePool();
process.exit(fail ? 1 : 0);
