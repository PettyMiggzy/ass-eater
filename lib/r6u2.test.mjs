// Regression tests for the round-6 admin fixes (package R6U2), run against a
// real scratch Postgres (it truncates tables), never mocks:
//  - admin-ui#0: an admin can FIND a wall comment's id (by creator) and a DM's
//    conversation + message ids (by either side's login, user id or creator)
//    through GET /api/admin/content-lookup, and the ids it returns are the ones
//    POST /api/admin/content-takedown accepts -- the takedown then really
//    removes the item and records it on the TAKE IT DOWN request;
//  - the lookup route is admin-key gated and validates its input;
//  - admin-ui#1/#2 (server side, from R6B): GET /api/admin/user-moderation by
//    login (trimmed, case-insensitive) returns the user id the panel then uses.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r6u2.test.mjs

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
delete process.env.NCII_ALERT_WEBHOOK_URL;
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.BRIDGE_SECRET = 'test-bridge-secret-r6u2';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r6u2';

const { query, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const users = await import('./users-store.js');
const messages = await import('./messages-store.js');
const wall = await import('./wall-store.js');
const ncii = await import('./ncii-reports-store.js');
const takedown = await import('./content-takedown.js');
const { default: lookupRoute } = await import('../pages/api/admin/content-lookup.js');
const { default: takedownRoute } = await import('../pages/api/admin/content-takedown.js');
const { default: userModerationRoute } = await import('../pages/api/admin/user-moderation.js');

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
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() {},
  };
}
async function call(route, { method = 'GET', body, query: q = {}, admin = true } = {}) {
  const res = fakeRes();
  const headers = { 'x-forwarded-for': '10.77.0.1' };
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  await quiet(() => route({ method, body, query: q, headers, socket: { remoteAddress: '10.77.0.1' } }, res));
  return res;
}

await query(`truncate creators, users, listings, ncii_reports, moderation_actions, conversations, reports, wall_posts restart identity`);
await query('delete from app_meta');
await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);

const creator = await creators.createCreator({ name: 'Wall Owner', handle: '@r6u2wall', status: 'active' });
const creatorUser = await users.createUser({ email: 'owner@r6u2.test', password: 'password123', role: 'creator', creatorId: creator.id });
const fan = await users.createUser({ email: 'Jane.Doe@R6U2.test', password: 'password123', role: 'fan' });
const fan2 = await users.createUser({ email: 'quietfan', password: 'password123', role: 'fan' });

const c1 = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan.id), authorName: 'jane', text: 'first comment' });
const c2 = await wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan2.id), authorName: 'quietfan', text: 'the reported comment' });
await messages.sendMessage(creatorUser.id, fan.id, 'hello from the creator');
await messages.sendMessage(creatorUser.id, fan.id, 'the reported DM');
await messages.sendMessage(creatorUser.id, fan2.id, 'another thread');

const report = await ncii.addNciiReport({
  reporterName: 'Jane', reporterContact: 'jane@example.test', contentLocation: 'a DM from @r6u2wall and a wall comment',
  description: 'intimate image without consent', category: 'self', consentStatement: true,
});

section('admin-ui#0: content lookup');
{
  const denied = await call(lookupRoute, { query: { kind: 'wall', creatorId: String(creator.id) }, admin: false });
  check('lookup refuses without the admin key', denied.statusCode === 401 || denied.statusCode === 403, denied.statusCode);
  const bad = await call(lookupRoute, { query: { kind: 'wall', creatorId: 'abc' } });
  check('lookup rejects a non-numeric creator id', bad.statusCode === 400);
  const badKind = await call(lookupRoute, { query: { kind: 'everything' } });
  check('lookup rejects an unknown kind', badKind.statusCode === 400);
  const arr = await call(lookupRoute, { query: { kind: 'conversations', login: ['a', 'b'] } });
  check('lookup rejects a non-string login', arr.statusCode === 400);

  const w = await call(lookupRoute, { query: { kind: 'wall', creatorId: String(creator.id) } });
  check('wall lookup lists the comments with ids', w.statusCode === 200 && w.body.posts.length === 2, JSON.stringify(w.body));
  check('wall lookup is newest first', w.body.posts[0]?.id === String(c2.id));
  check('wall lookup names the author by login', w.body.posts[0]?.author?.login === 'quietfan' && w.body.posts[0]?.author?.userId === String(fan2.id));
  const older = await call(lookupRoute, { query: { kind: 'wall', creatorId: String(creator.id), before: String(c2.id) } });
  check('wall lookup pages with before', older.body.posts.length === 1 && older.body.posts[0].id === String(c1.id));

  const byLogin = await call(lookupRoute, { query: { kind: 'conversations', login: '  jane.doe@r6u2.TEST ' } });
  check('conversations by login (trimmed, case-insensitive)', byLogin.statusCode === 200 && byLogin.body.account?.userId === String(fan.id), JSON.stringify(byLogin.body));
  check('the fan has one conversation, with the creator', byLogin.body.conversations?.length === 1
    && byLogin.body.conversations[0].other?.creatorId === String(creator.id)
    && byLogin.body.conversations[0].messageCount === 2);
  const byCreator = await call(lookupRoute, { query: { kind: 'conversations', creatorId: String(creator.id) } });
  check('conversations by creator resolve the creator login account', byCreator.body.account?.userId === String(creatorUser.id) && byCreator.body.conversations.length === 2);
  const byId = await call(lookupRoute, { query: { kind: 'conversations', userId: String(fan2.id) } });
  check('conversations by user id', byId.body.conversations?.length === 1);
  const nobody = await call(lookupRoute, { query: { kind: 'conversations', login: 'nobody@r6u2.test' } });
  check('an unknown login is a 404', nobody.statusCode === 404);

  const convId = byLogin.body.conversations[0].id;
  const t = await call(lookupRoute, { query: { kind: 'messages', conversationId: convId } });
  check('thread lookup returns every message with its id', t.statusCode === 200 && t.body.conversation.messages.length === 2 && t.body.conversation.messages.every((m) => m.id));
  check('thread participants carry logins', t.body.conversation.participants.some((p) => p.login === 'Jane.Doe@R6U2.test'));
  const byPair = await call(lookupRoute, { query: { kind: 'messages', userA: String(fan.id), userB: String(creatorUser.id) } });
  check('thread lookup by the two participants computes the id server-side', byPair.body.conversation?.id === convId);
  const none = await call(lookupRoute, { query: { kind: 'messages', userA: String(fan.id), userB: String(fan2.id) } });
  check('no conversation between two accounts is a 404', none.statusCode === 404);

  // The ids from the lookup are exactly what the takedown accepts.
  const reported = t.body.conversation.messages.find((m) => m.text === 'the reported DM');
  const reportId = String(report.id);
  const td = await call(takedownRoute, {
    method: 'POST',
    body: { type: 'message', conversationId: convId, messageId: reported.id, nciiReportId: reportId },
  });
  check('takedown of the looked-up message removes it', td.statusCode === 200 && td.body.result === 'removed', JSON.stringify(td.body));
  const after = await call(lookupRoute, { query: { kind: 'messages', conversationId: convId } });
  check('the message is gone from the thread', after.body.conversation.messages.length === 1 && !after.body.conversation.messages.some((m) => m.id === reported.id));

  const tdw = await call(takedownRoute, { method: 'POST', body: { type: 'wall_post', postId: w.body.posts[0].id, nciiReportId: reportId } });
  check('takedown of the looked-up wall comment removes it', tdw.statusCode === 200 && tdw.body.result === 'removed', JSON.stringify(tdw.body));
  const wallAfter = await takedown.lookupWallComments({ creatorId: String(creator.id) });
  check('the comment is gone from the wall', wallAfter.posts.length === 1 && wallAfter.posts[0].id === String(c1.id));
  const { rows } = await query('select data from ncii_reports where id = $1', [reportId]);
  const recorded = (rows[0]?.data?.takedowns || []).filter((x) => x.result === 'removed');
  check('both removals are recorded on the TAKE IT DOWN request', recorded.length === 2, JSON.stringify(rows[0]?.data?.takedowns));

  check('conversationIdBetween is order-independent', messages.conversationIdBetween('b', 'a') === messages.conversationIdBetween('a', 'b'));
}

section('admin-ui#1: account lookup by login');
{
  const r = await call(userModerationRoute, { query: { login: 'QUIETFAN ' } });
  check('user-moderation finds a username account and returns its user id', r.statusCode === 200 && r.body.user?.userId === String(fan2.id) && r.body.user?.login === 'quietfan', JSON.stringify(r.body));
}

console.log(`\n${pass} passed, ${fail} failed`);
await closePool();
process.exit(fail ? 1 : 0);
