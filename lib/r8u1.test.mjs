// Regression tests for the round-8 UI package (R8U1) backend touch points, run
// against a real scratch Postgres (it truncates tables), never mocks:
//  - dashboard#0: a block-only conversation (a wall commenter blocked from the
//    wall, who never DMed) is listed in the BLOCKER's inbox while the block
//    stands -- so it can be lifted there even after the comment is deleted --
//    never in the blocked account's, and drops out again once unblocked;
//  - public-pages#0: the wall's owner (and only the owner) gets a per-comment
//    `authorBlocked` flag from /api/wall/list, and a block/unblock answers
//    with every comment id by that author, never the author's account id.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r8u1.test.mjs

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
delete process.env.NCII_ALERT_WEBHOOK_URL;
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.SIGNUPS_OPEN = 'true';

const { query, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const users = await import('./users-store.js');
const messages = await import('./messages-store.js');
const wall = await import('./wall-store.js');
const { createSessionToken } = await import('./session.js');
const { default: wallPostRoute } = await import('../pages/api/wall/post.js');
const { default: wallBlockRoute } = await import('../pages/api/wall/block.js');
const { default: wallListRoute } = await import('../pages/api/wall/list.js');
const { default: wallDeleteRoute } = await import('../pages/api/wall/delete.js');
const { default: msgBlockRoute } = await import('../pages/api/messages/block.js');
const { default: conversationsRoute } = await import('../pages/api/messages/conversations.js');

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
async function call(route, { method = 'POST', body, query: q = {}, user = null } = {}) {
  ipN++;
  const res = fakeRes();
  const addr = `10.88.${Math.floor(ipN / 250)}.${ipN % 250}`;
  const headers = { 'x-forwarded-for': addr };
  if (user) headers.cookie = `oa_session=${createSessionToken(user.id, user.sessionVersion || 0)}`;
  const req = { method, body, query: q, headers, cookies: user ? { oa_session: createSessionToken(user.id, user.sessionVersion || 0) } : {}, socket: { remoteAddress: addr } };
  await quiet(() => route(req, res));
  return res;
}
async function reset() {
  await query(`truncate creators, users, listings, orders, credit_balances, credit_ledger, conversations, wall_posts,
    notifications, reports, violations restart identity`);
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
let n = 0;
async function mkCreatorUser() {
  n++;
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r8uc${n}`, status: 'active' });
  const user = await users.createUser({ email: `c${n}@r8u1.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r8u1.test`, password: 'password123', role: 'fan' });
}
async function comment(fan, creatorId, text) {
  const r = await call(wallPostRoute, { user: fan, body: { creatorId: String(creatorId), text } });
  return r.body?.post?.id != null ? String(r.body.post.id) : null;
}

await reset();

section('dashboard#0: a block-only row is listed to the blocker, not the blocked, and not after unblock');
{
  await reset();
  const c = await mkCreatorUser();
  const fan = await mkFan();
  const postId = await comment(fan, c.creator.id, 'rude comment');
  check('the fan commented', !!postId);
  const blocked = await call(wallBlockRoute, { user: c.user, body: { postId } });
  check('the owner blocks from the wall', blocked.statusCode === 200 && blocked.body.blocked === true, JSON.stringify(blocked.body));

  // The comment is deleted -- the normal cleanup -- so the wall can no longer reach the author.
  const del = await call(wallDeleteRoute, { user: c.user, body: { id: postId } });
  check('the owner deletes the comment', del.statusCode === 200, JSON.stringify(del.body));

  const mine = await messages.getConversationsForUser(c.user.id);
  check('the blocker sees the block-only row', mine.length === 1 && (mine[0].blockedBy || []).map(String).includes(String(c.user.id)), JSON.stringify(mine));
  const theirs = await messages.getConversationsForUser(fan.id);
  check('the blocked account does not', theirs.length === 0, JSON.stringify(theirs));

  const api = await call(conversationsRoute, { method: 'GET', user: c.user, query: {} });
  const row = api.body?.conversations?.[0];
  check('the inbox API lists it with blockedByMe and no messages', api.statusCode === 200 && row?.blockedByMe === true && row?.lastMessage === null, JSON.stringify(api.body));
  check('...naming the other side without their email', !!row?.other?.name && !JSON.stringify(api.body).includes('@r8u1.test'), JSON.stringify(row?.other));

  // The Inbox Unblock path for a block-only row. Round 9 (social#0) stopped
  // sending that row's counterpart id, so it is unblocked by its opaque
  // handle: POST /api/messages/block { blockHandle, blocked: false }.
  check('...and without their account id', row?.other?.userId === null && !JSON.stringify(api.body).includes(String(fan.id)), JSON.stringify(row));
  const unblock = await call(msgBlockRoute, { user: c.user, body: { blockHandle: row.blockHandle, blocked: false } });
  check('the blocker can unblock from the inbox', unblock.statusCode === 200 && unblock.body.ok === true, JSON.stringify(unblock.body));
  check('the empty row drops out of the blocker\'s inbox once unblocked', (await messages.getConversationsForUser(c.user.id)).length === 0);
  check('the fan can comment again', !!(await comment(fan, c.creator.id, 'sorry')));
}

section('dashboard#0: a real thread is unaffected by the change');
{
  await reset();
  const c = await mkCreatorUser();
  const fan = await mkFan();
  await messages.sendMessage(fan.id, c.user.id, 'hi');
  await messages.setConversationBlocked(c.user.id, fan.id, true);
  check('a thread with messages stays listed to both sides',
    (await messages.getConversationsForUser(c.user.id)).length === 1 && (await messages.getConversationsForUser(fan.id)).length === 1);
  await messages.setConversationBlocked(c.user.id, fan.id, false);
  check('...and after unblocking', (await messages.getConversationsForUser(c.user.id)).length === 1);
}

section('dashboard#0: a block the OTHER side made does not surface a block-only row');
{
  await reset();
  const a = await mkCreatorUser();
  const b = await mkCreatorUser();
  await messages.setConversationBlocked(a.user.id, b.user.id, true);
  check('the blocker (a) sees it', (await messages.getConversationsForUser(a.user.id)).length === 1);
  check('the blocked (b) does not', (await messages.getConversationsForUser(b.user.id)).length === 0);
}

section('public-pages#0: the wall owner sees authorBlocked on every comment by a blocked author');
{
  await reset();
  const c = await mkCreatorUser();
  const fan = await mkFan();
  const other = await mkFan();
  const p1 = await comment(fan, c.creator.id, 'first');
  const p2 = await comment(fan, c.creator.id, 'second');
  const p3 = await comment(other, c.creator.id, 'unrelated');
  check('three comments posted', !!(p1 && p2 && p3));

  const blocked = await call(wallBlockRoute, { user: c.user, body: { postId: p1 } });
  check('blocking via comment 1 answers every comment by that author',
    blocked.statusCode === 200 && [p1, p2].every((id) => blocked.body.postIds?.includes(id)) && !blocked.body.postIds?.includes(p3),
    JSON.stringify(blocked.body));
  check('...and no account id', !JSON.stringify(blocked.body).includes(`"${fan.id}"`) && !('authorId' in blocked.body));

  const list = await call(wallListRoute, { method: 'GET', user: c.user, query: { creatorId: String(c.creator.id) } });
  const flag = Object.fromEntries((list.body?.posts || []).map((p) => [String(p.id), p.authorBlocked]));
  check('owner list: both of the blocked author\'s comments flagged', flag[p1] === true && flag[p2] === true, JSON.stringify(flag));
  check('owner list: the other commenter is not', flag[p3] === false, JSON.stringify(flag));
  check('owner list: no commenter account ids', (list.body?.posts || []).every((p) => !('authorId' in p)), JSON.stringify(list.body?.posts));

  const anon = await call(wallListRoute, { method: 'GET', query: { creatorId: String(c.creator.id) } });
  check('a signed-out visitor gets no authorBlocked flag', (anon.body?.posts || []).length === 3 && anon.body.posts.every((p) => !('authorBlocked' in p)), JSON.stringify(anon.body));
  const byOther = await call(wallListRoute, { method: 'GET', user: other, query: { creatorId: String(c.creator.id) } });
  check('another signed-in viewer gets no authorBlocked flag', byOther.body.posts.every((p) => !('authorBlocked' in p)));

  const unblock = await call(wallBlockRoute, { user: c.user, body: { postId: p2, blocked: false } });
  check('unblocking via comment 2 answers both ids', unblock.statusCode === 200 && unblock.body.blocked === false && [p1, p2].every((id) => unblock.body.postIds?.includes(id)), JSON.stringify(unblock.body));
  const after = await call(wallListRoute, { method: 'GET', user: c.user, query: { creatorId: String(c.creator.id) } });
  check('after unblocking, nothing is flagged', after.body.posts.every((p) => p.authorBlocked === false), JSON.stringify(after.body.posts));
}

section('public-pages#0: store helpers');
{
  await reset();
  const c = await mkCreatorUser();
  const fan = await mkFan();
  const other = await mkFan();
  await messages.setConversationBlocked(c.user.id, fan.id, true);
  await messages.setConversationBlocked(other.id, c.user.id, true); // other blocked the creator
  const set = await messages.accountsBlockedBy(c.user.id, [fan.id, other.id, c.user.id, null]);
  check('accountsBlockedBy: only blocks made BY the user', set.has(String(fan.id)) && !set.has(String(other.id)) && set.size === 1, JSON.stringify([...set]));
  check('accountsBlockedBy: empty input is an empty set', (await messages.accountsBlockedBy(c.user.id, [])).size === 0);
  const flags = await wall.wallBlockFlagsFor(c.user.id, [{ id: 1, authorId: fan.id }, { id: 2, authorId: other.id }, { id: 3 }]);
  check('wallBlockFlagsFor maps post ids', flags.get('1') === true && flags.get('2') === false && flags.get('3') === false);
  check('wallPostIdsByAuthor of nobody is empty', (await wall.wallPostIdsByAuthor(c.creator.id, null)).length === 0);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
