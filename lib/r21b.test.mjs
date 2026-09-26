// Regression tests for the round-21 backend fixes (package R21B), run against a
// real scratch Postgres (it truncates tables). The text-screen findings
// (accounts#0-#8) have their own pure suites: lib/screen-benign.test.mjs (the
// legitimate text that must pass), lib/screen-generated.test.mjs (a generator
// family per rule) and lib/screen-corpus.test.mjs.
//  - media#1 / social#2: a sealed conversation reference is DETERMINISTIC, so
//    the panel can page a thread with a deleted participant;
//  - social#0: the admin conversation-lookup cursor is sealed -- no raw pair
//    id in it -- and still pages correctly; a forged cursor is page one;
//  - media#0 / social#1: GET /api/admin/ncii-reports and both
//    ncii-reports-resolve responses read a copied participant whose account
//    is gone as null, even when the stored copy still names it;
//  - media#2: a favorite / DM block / wall block racing an account deletion
//    waits for it and then writes nothing;
//  - gates-token#2: logout and token-gate clear refuse a cross-site request
//    before any cookie-clearing header is set.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r21b.test.mjs

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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r21b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r21b';
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
const messages = await import('./messages-store.js');
const favorites = await import('./favorites-store.js');
const ncii = await import('./ncii-reports-store.js');
const takedown = await import('./content-takedown.js');
const { AUTHOR_ACCOUNT_GONE } = await import('./author-lock.js');
const { createSessionToken } = await import('./session.js');
const { default: nciiListRoute } = await import('../pages/api/admin/ncii-reports.js');
const { default: nciiResolveRoute } = await import('../pages/api/admin/ncii-reports-resolve.js');
const { default: lookupRoute } = await import('../pages/api/admin/content-lookup.js');
const { default: logoutRoute } = await import('../pages/api/auth/logout.js');
const { default: holderClearRoute } = await import('../pages/api/token-gate/clear.js');
const { default: favoriteRoute } = await import('../pages/api/favorites/toggle.js');

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
async function call(route, { method = 'POST', body, user = null, admin = false, q = {}, headers: extra = {} } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = { host: 'www.joinonlyone.com', ...extra };
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r21bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r21b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r21b.test`, password: 'password123', role: 'fan' });
}
async function mkConversation(a, b, msgs, updatedAt = null) {
  const id = messages.conversationIdBetween(String(a), String(b));
  await query(`insert into conversations (id, data${updatedAt ? ', updated_at' : ''}) values ($1, $2::jsonb${updatedAt ? ', $3' : ''})`, [id, JSON.stringify({
    id, participantIds: [String(a), String(b)],
    messages: msgs.map((m) => ({ createdAt: new Date().toISOString(), ...m })),
    senders: [...new Set(msgs.map((m) => String(m.senderId)))],
  }), ...(updatedAt ? [updatedAt] : [])]);
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
    await c.query('delete from favorites where fan_id = $1', [String(userId)]);
    await c.query('delete from wall_blocks where owner_user_id = $1 or author_id = $1', [String(userId)]);
    await c.query('delete from users where id = $1', [String(userId)]);
    await c.query('commit');
    return await racing;
  } finally {
    await c.end();
  }
}

// ---------------------------------------------------------------------------
section('media#1 / social#2: a sealed conversation reference is the same every time');
{
  await reset();
  const a = takedown.sealConversationRef('gone-uid__u-1');
  const b = takedown.sealConversationRef('gone-uid__u-1');
  const c = takedown.sealConversationRef('gone-uid__u-2');
  check('the same conversation seals to the same reference', a === b && a.startsWith('ref.'), `${a} ${b}`);
  check('a different conversation seals differently', a !== c);
  check('the reference still opens to the conversation id', takedown.openConversationRef(a) === 'gone-uid__u-1');
  check('...names neither participant', !a.includes('gone-uid') && !a.includes('u-1'));
  const tampered = a.slice(0, -2) + (a.endsWith('A') ? 'BB' : 'AA');
  check('a tampered reference does not open', takedown.openConversationRef(tampered) === null);

  // Paging a thread with a deleted participant: both pages carry the same id.
  const { user: creatorUser } = await mkCreatorUser();
  const msgs = Array.from({ length: 130 }, (_, i) => ({ id: `m-${i}`, senderId: String(creatorUser.id), text: `msg ${i}` }));
  const convo = await mkConversation('purged-r21b', creatorUser.id, msgs);
  const first = await call(lookupRoute, { method: 'GET', admin: true, q: { kind: 'messages', conversationId: takedown.sealConversationRef(convo) } });
  const older = await call(lookupRoute, { method: 'GET', admin: true, q: { kind: 'messages', conversationId: first.body?.conversation?.id, before: first.body?.conversation?.nextBefore } });
  check('the newest page and the older page carry the SAME sealed id', first.statusCode === 200 && older.statusCode === 200
    && first.body.conversation.id === older.body.conversation.id && first.body.conversation.id.startsWith('ref.'),
  `${first.body?.conversation?.id} ${older.body?.conversation?.id}`);
  check('...and the older page is the rest of the thread', older.body.conversation.messages.length === 30
    && older.body.conversation.messages[0].id === 'm-0', JSON.stringify(older.body?.conversation?.messages?.slice(0, 1)));
  const list1 = await call(lookupRoute, { method: 'GET', admin: true, q: { kind: 'conversations', userId: String(creatorUser.id) } });
  const list2 = await call(lookupRoute, { method: 'GET', admin: true, q: { kind: 'conversations', userId: String(creatorUser.id) } });
  check('two conversation lists give the thread the same id', list1.body.conversations[0].id === list2.body.conversations[0].id
    && list1.body.conversations[0].id === first.body.conversation.id);
}

// ---------------------------------------------------------------------------
section('social#0: the conversation-lookup cursor never carries a raw pair id');
{
  await reset();
  const { user: creatorUser } = await mkCreatorUser();
  const t0 = Date.now();
  // Four threads, the older two with deleted participants.
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const other = i < 2 ? `gone-r21b-${i}` : String((await mkFan()).id);
    ids.push(await mkConversation(other, creatorUser.id, [{ id: `x${i}`, senderId: String(creatorUser.id), text: 'hi' }],
      new Date(t0 - (4 - i) * 60_000).toISOString()));
  }
  const p1 = await takedown.lookupConversationsFor(String(creatorUser.id), { limit: 3 });
  const decoded = Buffer.from(String(p1.nextCursor), 'base64url').toString('latin1');
  check('page one has a next cursor', p1.hasMore === true && typeof p1.nextCursor === 'string', JSON.stringify(p1));
  check('...which names no participant and no conversation id', !ids.some((id) => decoded.includes(id) || p1.nextCursor.includes(id))
    && !decoded.includes('gone-r21b') && !p1.nextCursor.includes('gone-r21b'), decoded);
  const p2 = await takedown.lookupConversationsFor(String(creatorUser.id), { limit: 3, cursor: p1.nextCursor });
  check('the sealed cursor pages to the last thread', p2.conversations.length === 1 && p2.hasMore === false
    && takedown.openConversationRef(p2.conversations[0].id) === ids[0], JSON.stringify(p2));
  const legacy = Buffer.from(JSON.stringify(['2020-01-01T00:00:00.000000Z', ids[3]]), 'utf8').toString('base64url');
  const p3 = await takedown.lookupConversationsFor(String(creatorUser.id), { limit: 3, cursor: legacy });
  check('an unsealed (forged) cursor is ignored: page one', p3.conversations.length === 3 && p3.hasMore === true);
  const r = await call(lookupRoute, { method: 'GET', admin: true, q: { kind: 'conversations', userId: String(creatorUser.id), cursor: 'garbage' } });
  check('the route answers a garbage cursor with page one', r.statusCode === 200 && r.body.conversations?.length === 4, JSON.stringify(r.body));
  check('...and no response carries a raw id of a deleted-participant thread', !JSON.stringify(r.body).includes('gone-r21b'));
}

// ---------------------------------------------------------------------------
section('media#0 / social#1: the NCII admin view nulls a participant whose account is gone');
{
  await reset();
  const { user: creatorUser } = await mkCreatorUser();
  const fan = await mkFan();
  const req = await ncii.addNciiReport({ category: 'self', contentLocation: 'a DM', description: 'x', consentStatement: true });
  // The copy a takedown committed while the fan's deletion was in flight: it
  // names an account that no longer exists (the purge UPDATE never saw it).
  const entry = {
    at: new Date().toISOString(), by: 'admin', result: 'removed',
    target: { type: 'message', conversationId: 'raced-r21b__x', messageId: 'm-1' },
    snapshot: { type: 'message', conversationId: 'raced-r21b__x', text: 't', participantIds: ['raced-r21b', String(fan.id)] },
  };
  await query(`update ncii_reports set data = data || jsonb_build_object('takedowns', jsonb_build_array($2::jsonb), 'history', jsonb_build_array($2::jsonb))
    where id = $1`, [req.id, JSON.stringify(entry)]);
  const page = await call(nciiListRoute, { method: 'GET', admin: true, q: { status: 'all' } });
  const got = page.body?.reports?.find((x) => String(x.id) === String(req.id));
  check('GET ncii-reports reads the gone participant as null', JSON.stringify(got?.takedowns?.[0]?.snapshot?.participantIds)
    === JSON.stringify([null, String(fan.id)]), JSON.stringify(got));
  check('...in history too', JSON.stringify(got?.history?.find((h) => h.snapshot)?.snapshot?.participantIds) === JSON.stringify([null, String(fan.id)]));
  check('...and the response nowhere names it', !JSON.stringify(page.body).includes('raced-r21b'));
  const resolved = await call(nciiResolveRoute, { admin: true, body: { id: String(req.id), action: 'removed' } });
  check('the resolve response nulls it too', resolved.statusCode === 200 && !JSON.stringify(resolved.body).includes('raced-r21b')
    && JSON.stringify(resolved.body.report?.takedowns?.[0]?.snapshot?.participantIds) === JSON.stringify([null, String(fan.id)]),
  JSON.stringify(resolved.body));
  const req2 = await ncii.addNciiReport({ category: 'self', contentLocation: 'a DM', description: 'y', consentStatement: true });
  await query(`update ncii_reports set data = data || jsonb_build_object('takedowns', jsonb_build_array($2::jsonb)) where id = $1`,
    [req2.id, JSON.stringify(entry)]);
  const dismissed = await call(nciiResolveRoute, { admin: true, body: { id: String(req2.id), action: 'dismiss', reason: 'not ours' } });
  check('the dismiss response nulls it too', dismissed.statusCode === 200 && !JSON.stringify(dismissed.body).includes('raced-r21b'),
    JSON.stringify(dismissed.body));
  const reopened = await call(nciiResolveRoute, { admin: true, body: { id: String(req2.id), action: 'reopen', reason: 'check again' } });
  check('the reopen response nulls it too', reopened.statusCode === 200 && !JSON.stringify(reopened.body).includes('raced-r21b'),
    JSON.stringify(reopened.body));
  const { rows } = await query('select data from ncii_reports where id = $1', [req.id]);
  check('the stored record is unchanged (the audit record)', rows[0].data.takedowns[0].snapshot.participantIds[0] === 'raced-r21b');
  // A live participant stays.
  const view = await ncii.adminNciiReportsView([{ id: '1', takedowns: [{ snapshot: { participantIds: [String(fan.id), String(creatorUser.id)] } }] }]);
  check('live participants are kept', JSON.stringify(view[0].takedowns[0].snapshot.participantIds) === JSON.stringify([String(fan.id), String(creatorUser.id)]));
}

// ---------------------------------------------------------------------------
section('media#2: favorites and blocks racing an account deletion write nothing');
{
  await reset();
  const { creator, user: creatorUser } = await mkCreatorUser();
  const fan = await mkFan();
  const r1 = await withDeletionInProgress(fan.id, () => favorites.toggleFavorite(String(fan.id), String(creator.id)));
  check('the favorite waited and was refused (account gone)', r1.e?.code === AUTHOR_ACCOUNT_GONE, JSON.stringify(r1));
  check('...and no favorites row names the deleted fan', (await query('select 1 from favorites where fan_id = $1', [String(fan.id)])).rows.length === 0);

  const fan2 = await mkFan();
  const r2 = await withDeletionInProgress(fan2.id, () => messages.setConversationBlocked(String(creatorUser.id), String(fan2.id), true));
  check('a DM block of an account being deleted is refused as not found', r2.e?.code === messages.DM_ERRORS.RECIPIENT_NOT_FOUND, JSON.stringify(r2));
  check('...and no createdByBlock row names it', (await query(`select 1 from conversations where data->'participantIds' ? $1`, [String(fan2.id)])).rows.length === 0);

  const fan3 = await mkFan();
  const r3 = await withDeletionInProgress(fan3.id, () => messages.setConversationBlocked(String(fan3.id), String(creatorUser.id), true));
  check('a DM block BY an account being deleted is refused (account gone)', r3.e?.code === AUTHOR_ACCOUNT_GONE, JSON.stringify(r3));
  check('...and writes no row', (await query(`select 1 from conversations where data->'participantIds' ? $1`, [String(fan3.id)])).rows.length === 0);

  const fan4 = await mkFan();
  const r4 = await withDeletionInProgress(fan4.id, () => messages.setWallBlocked(String(creatorUser.id), String(fan4.id), true));
  check('a wall block of an account being deleted is refused as not found', r4.e?.code === messages.DM_ERRORS.RECIPIENT_NOT_FOUND, JSON.stringify(r4));
  check('...and no wall_blocks row names it', (await query('select 1 from wall_blocks where author_id = $1', [String(fan4.id)])).rows.length === 0);

  // Live accounts still work.
  const fan5 = await mkFan();
  check('a live fan favorites', (await favorites.toggleFavorite(String(fan5.id), String(creator.id))).favorited === true);
  const conv = await messages.setConversationBlocked(String(creatorUser.id), String(fan5.id), true);
  check('a live DM block works', conv?.blockedByMe === true, JSON.stringify(conv));
  check('a live wall block works', (await messages.setWallBlocked(String(creatorUser.id), String(fan5.id), true)).changed === true);
  check('...and unblocking too', (await messages.setWallBlocked(String(creatorUser.id), String(fan5.id), false)).changed === true);
  const gone = await messages.setConversationBlocked(String(creatorUser.id), 'never-existed-r21b', true).catch((e) => e);
  check('blocking an account that never existed is RECIPIENT_NOT_FOUND', gone?.code === messages.DM_ERRORS.RECIPIENT_NOT_FOUND);
  const route = await call(favoriteRoute, { user: { id: 'ghost-r21b', sessionVersion: 0 }, body: { creatorId: String(creator.id) } });
  check('the favorites route never 500s for a gone account', route.statusCode === 401, JSON.stringify(route.body));
}

// ---------------------------------------------------------------------------
section('gates-token#2: logout and token-gate clear refuse cross-site');
{
  await reset();
  const fan = await mkFan();
  for (const [name, route] of [['logout', logoutRoute], ['token-gate clear', holderClearRoute]]) {
    const cross = await call(route, { user: fan, headers: { 'sec-fetch-site': 'cross-site' } });
    check(`${name}: a cross-site POST is 403`, cross.statusCode === 403, JSON.stringify(cross.body));
    check(`${name}: ...and sets no cookie`, cross.headers['set-cookie'] === undefined, JSON.stringify(cross.headers));
    const form = await call(route, { user: fan, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' } });
    check(`${name}: a foreign-origin form POST is 403 with no cookie`, form.statusCode === 403 && form.headers['set-cookie'] === undefined);
    const same = await call(route, { user: fan, headers: { 'sec-fetch-site': 'same-origin', origin: 'https://www.joinonlyone.com' } });
    check(`${name}: the site's own request still works`, same.statusCode === 200 && same.headers['set-cookie'] !== undefined,
      JSON.stringify({ s: same.statusCode, b: same.body, h: same.headers }));
  }
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
for (const f of failures) console.log('  FAILED:', f);
await closePool();
process.exit(fail ? 1 : 0);
