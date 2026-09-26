// Regression tests for the round-7 backend fixes (package R7B), run against a
// real scratch Postgres (it truncates tables), never mocks:
//  - gates-token#0: the owner/reviewer bypass keys have a GLOBAL guessing
//    budget in Postgres (the right key is refused while it is spent), and the
//    per-client bucket is the IPv6 /64;
//  - gates-token#1: an oversized login identifier/password is refused first;
//  - media#0: a deleted upload's path keeps a re-armed 'token' row, and an
//    owner is never served a reaped path;
//  - media#1 / public-pages#2: a report HOLD no longer blocks a sale;
//  - media#2: resolving an attributed takedown locks the creator first (no
//    deadlock against a gallery removal attributed to it);
//  - money#0: deleting a creator serializes against the creator's own deposit;
//  - money#1: a deposit for an account frozen mid-wait is refused unclaimed;
//  - money#2: checkout waits on the per-file locks a quarantine holds;
//  - money#3: re-verifying a hash already credited to you is a success;
//  - social#0: a creator can block a wall commenter who never DMed them;
//  - social#1: wall notifications coalesce per author;
//  - accounts#0/#1: cross-tag screening only joins whole single-word tags
//    for phrases, and never builds a contact handover across a tag boundary;
//  - accounts#2: an unapproved creator's account suspension is pushed with no end;
//  - accounts#3: an account ban/suspension carries onto a suspended profile;
//  - accounts#4: pets and things with a "my 12yo" age pass;
//  - accounts#5: the standing outbox never deletes a newer same-status decision;
//  - legal-journeys#0: a shipped order's address can be erased, and deleting
//    the fan account erases them.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r7b.test.mjs

import crypto from 'crypto';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
delete process.env.NCII_ALERT_WEBHOOK_URL;
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.BRIDGE_SECRET = 'test-bridge-secret-r7b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r7b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
process.env.OWNER_ACCESS_KEY = 'owner-key-r7b-test';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { query, withTransaction, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const preservation = await import('./media-preservation.js');
const blobCleanup = await import('./blob-cleanup.js');
const ncii = await import('./ncii-reports-store.js');
const messages = await import('./messages-store.js');
const credits = await import('./credits-store.js');
const orders = await import('./orders-store.js');
const deposit = await import('./deposit.js');
const outbox = await import('./standing-outbox.js');
const guard = await import('./bypass-guard.js');
const { networkBucket } = await import('./rate-limit.js');
const { screenPublicText } = await import('./prohibited-terms.js');
const { createSessionToken } = await import('./session.js');
const { default: ownerRoute } = await import('../pages/api/age-verify/owner.js');
const { default: loginRoute } = await import('../pages/api/auth/login.js');
const { default: mediaRoute } = await import('../pages/api/media/[...path].js');
const { default: wallPostRoute } = await import('../pages/api/wall/post.js');
const { default: wallBlockRoute } = await import('../pages/api/wall/block.js');
const { default: eraseRoute } = await import('../pages/api/admin/order-address-erase.js');

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
    writeHead(c, h = {}) { this.statusCode = c; for (const [k, v] of Object.entries(h)) this.headers[k.toLowerCase()] = v; return this; },
    end(b) { this.headersSent = true; if (b) { try { this.body = JSON.parse(b); } catch { this.body = b; } } },
    destroy() {},
    on() {}, once() {}, emit() {}, write() { return true; },
  };
}
let ipN = 0;
async function call(route, { method = 'POST', body, query: q = {}, admin = false, user = null, ip = null } = {}) {
  ipN++;
  const res = fakeRes();
  const addr = ip || `10.77.${Math.floor(ipN / 250)}.${ipN % 250}`;
  const headers = { 'x-forwarded-for': addr };
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  if (user) headers.cookie = `oa_session=${createSessionToken(user.id, user.sessionVersion || 0)}`;
  const req = { method, body, query: q, headers, socket: { remoteAddress: addr } };
  await quiet(() => route(req, res));
  return res;
}
async function reset() {
  await query(`truncate creators, users, listings, orders, credit_balances, credit_ledger, payout_requests, checkout_idempotency,
    used_payment_tx, ncii_reports, media_uploads, media_reaped, performer_records, media_preservations, media_holds, moderation_actions,
    server_standing_pushes, conversations, reports, violations, wall_posts, favorites, notifications, bypass_key_attempts restart identity`);
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
let n = 0;
async function mkCreatorUser(fields = {}) {
  n++;
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r7bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r7b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan(email = null) {
  n++;
  return users.createUser({ email: email || `f${n}@r7b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
const galleryFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'gallery', creatorId, contentType: 'image/jpeg' }));
const strip = (src) => src.replace('/api/media/', '');
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const buy = (buyer, listing, c) => orders.createOrdersFromCredits({
  buyerId: buyer.id,
  items: [{ listingId: String(listing.id), creatorId: String(c.creator.id), creatorUserId: c.user.id, title: 'Set', priceCents: 500, kind: 'digital', shippingCents: 0 }],
  ageConfirmed: true,
  tosAccepted: true,
});

// ---------------------------------------------------------------------------
await reset();

section('gates-token#0: global bypass budget, /64 buckets');
{
  check('IPv6 addresses in one /64 share a bucket', networkBucket('2001:db8:1:2:aaaa::1') === networkBucket('2001:db8:1:2:ffff:1:2:3'));
  check('...a different /64 does not', networkBucket('2001:db8:1:2::1') !== networkBucket('2001:db8:1:3::1'));
  check('IPv4 is kept as is', networkBucket('203.0.113.9') === '203.0.113.9');

  // Wrong keys from 30 different addresses: each address is under its own
  // per-IP limit, but the global budget runs out.
  const statuses = [];
  for (let i = 0; i < guard.BYPASS_GLOBAL_BUDGET + 3; i++) {
    statuses.push((await call(ownerRoute, { method: 'GET', query: { key: `guess-${i}` }, ip: `198.51.100.${i + 1}` })).statusCode);
  }
  check('every wrong key 404s', statuses.every((s) => s === 404));
  const right = await call(ownerRoute, { method: 'GET', query: { key: process.env.OWNER_ACCESS_KEY }, ip: '192.0.2.200' });
  check('while the budget is spent even the RIGHT key is refused', right.statusCode === 404, String(right.statusCode));
  // A new window: the right key works, and does not use up budget.
  await query(`update bypass_key_attempts set window_start = now() - interval '16 minutes'`);
  const ok = await call(ownerRoute, { method: 'GET', query: { key: process.env.OWNER_ACCESS_KEY }, ip: '192.0.2.201' });
  check('in a fresh window the right key is granted', ok.statusCode === 302 && /oa_age_verified=/.test(String(ok.headers['set-cookie'])), JSON.stringify(ok.headers));
  const { rows } = await query(`select attempts from bypass_key_attempts where endpoint = 'owner'`);
  check('...and its attempt was refunded', rows[0].attempts === 0, JSON.stringify(rows));

  // Concurrency: a parallel burst cannot overshoot the budget.
  await query('truncate bypass_key_attempts');
  const burst = await Promise.all(Array.from({ length: 40 }, () => guard.consumeBypassAttempt('burst-test')));
  check('a parallel burst gets exactly the budget', burst.filter((b) => b.allowed).length === guard.BYPASS_GLOBAL_BUDGET);
}

section('gates-token#1: oversized login fields refused before anything else');
{
  const big = await call(loginRoute, { body: { email: 'x'.repeat(5000) + '@r7b.test', password: 'password123' } });
  check('a huge identifier is a 400', big.statusCode === 400, JSON.stringify(big.body));
  const bigPw = await call(loginRoute, { body: { email: 'a@r7b.test', password: 'p'.repeat(5000) } });
  check('a huge password is a 400', bigPw.statusCode === 400, JSON.stringify(bigPw.body));
}

section('media#0: a deleted path stays on the sweep list; owners are never served a reaped path');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  const src = galleryFile(creator.id);
  const p = strip(src);
  await query(`insert into media_uploads (pathname, reason) values ($1, 'delete_pending')`, [p]);
  const out = await quiet(() => blobCleanup.deleteMediaQuietly([src], { deleteFile: async () => {} }));
  check('the file was deleted', out.deleted.includes(p));
  const { rows } = await query(`select reason, created_at > now() - interval '1 minute' as fresh from media_uploads where pathname = $1`, [p]);
  check('...and its row is re-armed as a fresh token row', rows.length === 1 && rows[0].reason === 'token' && rows[0].fresh, JSON.stringify(rows));
  // A fresh token row is not swept yet; an hour on, it is, and then dropped.
  const s1 = await media.sweepOrphanedMedia({ deleteFile: async () => {} });
  check('not swept while a token could still be live', s1.checked === 0, JSON.stringify(s1));
  await query(`update media_uploads set created_at = now() - interval '2 hours' where pathname = $1`, [p]);
  const swept = [];
  await media.sweepOrphanedMedia({ deleteFile: async (x) => { swept.push(x); } });
  check('an hour on, the sweep deletes whatever is at the path', swept.includes(p));
  check('...and forgets it for good', !(await query('select 1 from media_uploads where pathname = $1', [p])).rows.length);
  // A just-recorded removal the SWEEP deletes is re-armed too.
  const q = strip(galleryFile(creator.id));
  await query(`insert into media_uploads (pathname, reason) values ($1, 'delete_failed')`, [q]);
  await media.sweepOrphanedMedia({ deleteFile: async () => {} });
  const { rows: rq } = await query('select reason from media_uploads where pathname = $1', [q]);
  check('a recent removal deleted by the sweep is re-armed as a token row', rq.length === 1 && rq[0].reason === 'token', JSON.stringify(rq));
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const res = await call(mediaRoute, { method: 'GET', user, query: { path: p.split('/') } });
  check('the owner gets a 404 for a reaped path', res.statusCode === 404, String(res.statusCode));
}

section('media#1 / public-pages#2: a report hold does not stop a sale');
{
  await reset();
  const seller = await mkCreatorUser();
  const held = await mkListing(seller.creator.id);
  await preservation.holdMediaForReport(held.media, 'report:12');
  const buyer = await mkFan();
  await credits.creditAccount({ userId: buyer.id, cents: 5000, type: 'test' });
  const err = await errOf(() => buy(buyer, held, seller));
  check('checkout sells a held listing', !err, err && err.message);
  check('...and charged the buyer', (await credits.getBalanceCents(buyer.id)) === 4500);
  check('...and the hold is still in place', (await preservation.heldPathsForReport('report:12')).length === 1);
}

section('money#2: checkout waits on a quarantine holding the file locks');
{
  await reset();
  const seller = await mkCreatorUser();
  const l = await mkListing(seller.creator.id);
  const buyer = await mkFan();
  await credits.creditAccount({ userId: buyer.id, cents: 5000, type: 'test' });
  const p = strip(l.media[0].src);
  let release;
  const gate = new Promise((r) => { release = r; });
  let locked;
  const lockedP = new Promise((r) => { locked = r; });
  const quarantine = withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [p]);
    locked();
    await gate;
    await client.query(`insert into media_preservations (pathname, reason, retain_until) values ($1, 'x', now() + interval '1 day')`, [p]);
  });
  await lockedP;
  let done = false;
  const checkout = errOf(() => buy(buyer, l, seller)).then((e) => { done = true; return e; });
  await sleep(150);
  check('checkout is waiting on the file lock', !done);
  release();
  await quarantine;
  const err = await checkout;
  check('...and then refuses the quarantined listing', err?.code === 'LISTING_UNAVAILABLE', err && err.message);
  check('...charging nothing', (await credits.getBalanceCents(buyer.id)) === 5000);
}

section('media#2: resolving an attributed takedown locks the creator first');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const report = await ncii.addNciiReport({ category: 'nonconsensual', contentLocation: `/creator/${creator.id}`, description: 'x', goodFaithStatement: true });
  // The gallery-removal order: creator row, then (a moment later) the report row.
  let lockedCreator;
  const lockedP = new Promise((r) => { lockedCreator = r; });
  const galleryPath = withTransaction(async (client) => {
    await client.query('select id from creators where id = $1 for update', [String(creator.id)]);
    lockedCreator();
    await sleep(150);
    await client.query('select id from ncii_reports where id = $1 for update', [String(report.id)]);
    return 'ok';
  });
  await lockedP;
  const resolving = quiet(() => ncii.resolveNciiReport(String(report.id), 'removed', { creatorId: String(creator.id) }));
  const [a, b] = await Promise.allSettled([galleryPath, resolving]);
  check('the gallery path completed', a.status === 'fulfilled', a.reason && a.reason.message);
  check('the resolve completed (no deadlock)', b.status === 'fulfilled', b.reason && `${b.reason.code} ${b.reason.message}`);
}

section('money#0: deleting a creator waits for the creator\'s own deposit');
{
  await reset();
  const c = await mkCreatorUser();
  let release;
  const gate = new Promise((r) => { release = r; });
  let locked;
  const lockedP = new Promise((r) => { locked = r; });
  // What recordDepositCredit does: share-lock the login row, then credit.
  const depositing = withTransaction(async (client) => {
    await client.query('select 1 from users where id = $1 for share', [String(c.user.id)]);
    locked();
    await gate;
    await credits.creditAccount({ userId: c.user.id, cents: 4900, type: 'deposit', meta: { txHash: '0xabc' } }, client);
  });
  await lockedP;
  const deleting = errOf(() => quiet(() => creators.deleteCreator(c.creator.id)));
  await sleep(100);
  release();
  await depositing;
  const err = await deleting;
  check('the deletion saw the deposit and refused', err?.code === creators.CREATOR_HAS_OBLIGATIONS, err ? err.message : 'deleted');
  check('...and the login still exists', !!(await users.findUserById(c.user.id)));
}

section('money#1 + money#3: deposits re-check standing in the transaction; a retry is idempotent');
{
  await reset();
  const fan = await mkFan();
  const tx = '0x' + 'c'.repeat(64);
  await users.setUserModeration(fan.id, { status: 'banned', reason: 'x' });
  const frozen = await errOf(() => deposit.recordDepositCredit({ userId: fan.id, txHash: tx, grossCents: 5000, feeCents: 100, netCents: 4900 }));
  check('a frozen account is refused ACCOUNT_FROZEN', frozen?.code === deposit.ACCOUNT_FROZEN, frozen && frozen.message);
  check('...without claiming the hash', !(await query('select 1 from used_payment_tx where tx_hash = $1', [tx])).rows.length);
  const forced = await deposit.recordDepositCredit({ userId: fan.id, txHash: tx, grossCents: 5000, feeCents: 100, netCents: 4900, allowFrozen: true });
  check('the admin override still credits it', forced.creditedCents === 4900 && !forced.alreadyCredited);

  const live = await mkFan();
  const tx2 = '0x' + 'd'.repeat(64);
  const first = await deposit.recordDepositCredit({ userId: live.id, txHash: tx2, grossCents: 2500, feeCents: 50, netCents: 2450 });
  const again = await deposit.recordDepositCredit({ userId: live.id, txHash: tx2, grossCents: 2500, feeCents: 50, netCents: 2450 });
  check('a retry by the same account answers alreadyCredited', again.alreadyCredited === true && again.creditedCents === 2450 && again.balanceCents === first.balanceCents, JSON.stringify(again));
  check('...and credited only once', (await credits.getBalanceCents(live.id)) === 2450);
  const other = await mkFan();
  const stolen = await errOf(() => deposit.recordDepositCredit({ userId: other.id, txHash: tx2, grossCents: 2500, feeCents: 50, netCents: 2450 }));
  check('another account is still TX_ALREADY_USED', stolen?.code === deposit.TX_ALREADY_USED);

  const tx3 = '0x' + 'e'.repeat(64);
  const both = await Promise.allSettled([1, 2].map(() => deposit.recordDepositCredit({ userId: live.id, txHash: tx3, grossCents: 1000, feeCents: 20, netCents: 980 })));
  check('two concurrent submissions both succeed', both.every((r) => r.status === 'fulfilled'), JSON.stringify(both.map((r) => r.reason?.message)));
  check('...with exactly one credit', (await credits.getBalanceCents(live.id)) === 2450 + 980);
}

section('social#0: blocking a wall commenter who never DMed');
{
  await reset();
  const c = await mkCreatorUser();
  const fan = await mkFan();
  const post = await call(wallPostRoute, { user: fan, body: { creatorId: String(c.creator.id), text: 'hello there' } });
  check('the fan can comment', post.statusCode === 200, JSON.stringify(post.body));
  const postId = post.body.post?.id ?? (await query('select id from wall_posts order by id desc limit 1')).rows[0].id;
  const notOwner = await call(wallBlockRoute, { user: fan, body: { postId: String(postId) } });
  check('only the wall owner can block from a comment', notOwner.statusCode === 403);
  const blocked = await call(wallBlockRoute, { user: c.user, body: { postId: String(postId) } });
  check('the owner blocks the commenter', blocked.statusCode === 200 && blocked.body.blocked === true, JSON.stringify(blocked.body));
  check('...and the response carries no account id', !JSON.stringify(blocked.body).includes(String(fan.id)));
  const again = await call(wallPostRoute, { user: fan, body: { creatorId: String(c.creator.id), text: 'again' } });
  check('the blocked account can no longer comment', again.statusCode === 403, JSON.stringify(again.body));
  const inbox = await messages.getConversationsForUser(fan.id);
  check('the block row is not shown as a thread to the blocked account', inbox.length === 0, JSON.stringify(inbox));
  const unblock = await call(wallBlockRoute, { user: c.user, body: { postId: String(postId), blocked: false } });
  check('the owner can unblock', unblock.statusCode === 200 && unblock.body.blocked === false);
  const ghost = await errOf(() => messages.setConversationBlocked(c.user.id, 'no-such-user', true));
  check('blocking a non-existent account is refused', ghost?.code === messages.DM_ERRORS.RECIPIENT_NOT_FOUND);
}

section('social#1: wall notifications coalesce per author');
{
  await reset();
  const c = await mkCreatorUser();
  const alice = await mkFan('alice@r7b.test');
  const bob = await mkFan('bob@r7b.test');
  await call(wallPostRoute, { user: alice, body: { creatorId: String(c.creator.id), text: 'hi from alice' } });
  await call(wallPostRoute, { user: alice, body: { creatorId: String(c.creator.id), text: 'alice again' } });
  await call(wallPostRoute, { user: bob, body: { creatorId: String(c.creator.id), text: 'hi from bob' } });
  const { rows } = await query(`select message, meta from notifications where user_id = $1 and type = 'wall_comment' order by id`, [String(c.user.id)]);
  check('one notification per author', rows.length === 2, JSON.stringify(rows.map((r) => r.message)));
  check('...never carrying a raw account id', rows.every((r) => !JSON.stringify(r.meta).includes(String(alice.id)) && !JSON.stringify(r.meta).includes(String(bob.id))));
}

section('accounts#0/#1: cross-tag screening');
// Round 8 (accounts#4): the spaced-handle check across tags reads the STORED
// tags, which carry no "_" -- so ['snapchat', 'jane_doe'] publishes as
// "#snapchat #janedoe" and is judged like ['snapchat', 'janedoe'] (allowed).
// A handle with a digit is still refused.
{
  for (const tags of [['old school', 'girl next door'], ['petite', 'little', 'girl next door'], ['old school', 'girls'], ['tg', 'y2k'], ['tgirl', 'tg', 'y2k'], ['insta', 'y2k'], ['snap', 'r18']]) {
    check(`passes: ${JSON.stringify(tags)}`, listings.findCircumventionInTags(tags) === null, JSON.stringify(listings.findCircumventionInTags(tags)));
  }
  for (const [tags, kind] of [[['school', 'girl'], 'prohibited'], [['barely', 'legal'], 'prohibited'], [['#school.', 'girl'], 'prohibited'], [['cash', 'app jane'], 'payment'], [['text me', '555 123 4567'], 'payment'], [['snapchat', '@jane99'], 'payment'], [['telegram', 'janedoe99'], 'payment'], [['snapchat', 'jane_doe99'], 'payment'], [['insta', 'janedoe_99'], 'payment'], [['#telegram', '#janedoe99'], 'payment'], [['cash', 'app'], 'payment']]) {
    check(`flagged (${kind}): ${JSON.stringify(tags)}`, listings.findCircumventionInTags(tags)?.kind === kind, JSON.stringify(listings.findCircumventionInTags(tags)));
  }
}

section('accounts#4: ages of pets and things');
{
  for (const t of ['me and my 12yo dog', 'my 14 yo cat Luna', 'our 11yo pup', 'proud owner of a 13 yo husky', 'My 15 y/o car still runs', 'my 10yo laptop', 'my 12yo golden retriever', 'my 12yo german shepherd']) {
    check(`passes: ${t}`, screenPublicText(t) === null, JSON.stringify(screenPublicText(t)));
  }
  // The middle slot is a fixed list, and slang-ambiguous animal words are not
  // things: a sexual noun must not ride in front of an innocent one.
  for (const t of ['my 15yo girlfriend', 'petite 16yo', 'a 16yo', 'the 17yo next door', 'cute 12yo pup', 'my 16yo pet', 'a 16yo kitty', 'my 16yo pussy cat', 'my 15yo slut house', 'our 14yo babe account', 'my 15yo home alone', 'a 16yo bunny']) {
    check(`refused: ${t}`, screenPublicText(t)?.kind === 'prohibited');
  }
}

section('accounts#2: an unapproved creator\'s account suspension is pushed with no end');
{
  await reset();
  const c = await mkCreatorUser({ status: 'pending' });
  const until = new Date(Date.now() + 7 * 864e5).toISOString();
  await users.setUserModeration(c.user.id, { status: 'suspended', until, reason: 'x' });
  const { rows } = await query('select status, suspended_until from server_standing_pushes where uid = $1', [String(c.user.id)]);
  check('pushed as suspended with NO end', rows[0]?.status === 'suspended' && rows[0].suspended_until === null, JSON.stringify(rows));
  const u = await users.findUserById(c.user.id);
  const cr = await creators.getCreatorById(c.creator.id);
  check('the shared rule agrees', JSON.stringify(users.combinedCreatorPushStanding(cr, u)) === JSON.stringify({ status: 'suspended', suspendedUntil: null }));
  // Once the account suspension has lapsed, the creator is pending again,
  // and the maintenance cron finds it to re-push.
  await query(`update users set data = data || jsonb_build_object('moderationUntil', $2::text) where id = $1`, [String(c.user.id), new Date(Date.now() - 3600e3).toISOString()]);
  check('the lapsed suspension is listed for a re-push', (await users.lapsedAccountSuspensionCreatorIds()).includes(String(c.creator.id)));
  const u2 = await users.findUserById(c.user.id);
  check('...and would now push pending', users.combinedCreatorPushStanding(cr, u2).status === 'pending');
  // An approved-underneath (suspended) profile keeps its dated suspension.
  const s = await mkCreatorUser({ status: 'suspended', suspendedUntil: new Date(Date.now() + 864e5).toISOString() });
  const combo = users.combinedCreatorPushStanding(await creators.getCreatorById(s.creator.id), s.user);
  check('a suspended profile is pushed with its end', combo.status === 'suspended' && !!combo.suspendedUntil);
}

section('accounts#3: account moderation carries onto a suspended profile');
{
  await reset();
  const profileEnd = new Date(Date.now() + 5 * 864e5).toISOString();
  const c = await mkCreatorUser({ status: 'suspended', suspendedUntil: profileEnd });
  const l = await mkListing(c.creator.id);
  await users.setUserModeration(c.user.id, { status: 'banned', reason: 'x' });
  const after = await creators.getCreatorById(c.creator.id);
  check('an account ban bans the suspended profile', after.status === 'banned', JSON.stringify(after.status));
  check('...so it cannot lapse back to public', !creators.isPubliclyVisible(after));
  const lr = (await query('select data from listings where id = $1', [String(l.id)])).rows[0].data;
  check('...and its listings are off sale', lr.status === 'removed', lr.status);

  const d = await mkCreatorUser({ status: 'suspended', suspendedUntil: profileEnd });
  const longer = new Date(Date.now() + 30 * 864e5).toISOString();
  await users.setUserModeration(d.user.id, { status: 'suspended', until: longer, reason: 'x' });
  const ext = await creators.getCreatorById(d.creator.id);
  check('a longer account suspension extends the profile\'s end', Date.parse(ext.suspendedUntil) === Date.parse(longer), ext.suspendedUntil);

  const p = await mkCreatorUser({ status: 'pending' });
  await users.setUserModeration(p.user.id, { status: 'banned', reason: 'x' });
  check('a pending profile stays pending', (await creators.getCreatorById(p.creator.id)).status === 'pending');
}

section('accounts#5: the outbox never deletes a newer same-status decision');
{
  await reset();
  const fan = await mkFan();
  const day = new Date(Date.now() + 864e5).toISOString();
  const year = new Date(Date.now() + 365 * 864e5).toISOString();
  await outbox.enqueueStandingPushes([{ uid: fan.id, status: 'suspended', role: 'FAN', suspendedUntil: day }]);
  // While the first decision is in flight, a newer one with the same status
  // (a changed end) is queued.
  await outbox.deliverStandingPushes({
    uids: [String(fan.id)],
    fetchImpl: async () => {
      await outbox.enqueueStandingPushes([{ uid: fan.id, status: 'suspended', role: 'FAN', suspendedUntil: year }]);
      return { ok: true, status: 200 };
    },
  });
  const { rows } = await query('select suspended_until from server_standing_pushes where uid = $1', [String(fan.id)]);
  check('the newer decision survives the older one\'s delivery', rows.length === 1 && Number(rows[0].suspended_until) === Date.parse(year), JSON.stringify(rows));
}

section('legal-journeys#0: shipped order addresses can be erased');
{
  await reset();
  const c = await mkCreatorUser();
  const fan = await mkFan();
  const address = { name: 'Real Name', line1: '1 Main St', city: 'Town', state: 'NY', postalCode: '10001', country: 'US' };
  const mk = (status) => query('insert into orders (data) values ($1) returning id', [{
    listingId: '1', creatorId: String(c.creator.id), buyerId: String(fan.id), kind: 'physical', status,
    shippingAddress: 'enc:placeholder', createdAt: new Date().toISOString(),
  }]).then((r) => String(r.rows[0].id));
  void address;
  const pending = await mk('pending_shipment');
  const shipped = await mk('shipped');
  const refused = await call(eraseRoute, { admin: true, body: { orderId: pending } });
  check('an unshipped order is refused 409', refused.statusCode === 409, JSON.stringify(refused.body));
  const noKey = await call(eraseRoute, { body: { orderId: shipped } });
  check('the route needs the admin key', noKey.statusCode === 401 || noKey.statusCode === 403, String(noKey.statusCode));
  const ok = await call(eraseRoute, { admin: true, body: { orderId: shipped } });
  check('a shipped order\'s address is erased', ok.statusCode === 200 && ok.body.erased === true, JSON.stringify(ok.body));
  const row = (await query('select data from orders where id = $1', [shipped])).rows[0].data;
  check('...stored as null with a stamp', row.shippingAddress === null && !!row.addressErasedAt);
  const again = await call(eraseRoute, { admin: true, body: { orderId: shipped } });
  check('erasing again is a harmless success', again.statusCode === 200 && again.body.erased === false);
  check('an unknown order is 404', (await call(eraseRoute, { admin: true, body: { orderId: '999999' } })).statusCode === 404);

  // Account deletion erases the shipped ones (force: the unshipped one stays for the creator).
  const shipped2 = await mk('delivered');
  await users.deleteFanAccount(fan.id, { force: true });
  const r2 = (await query('select data from orders where id = $1', [shipped2])).rows[0].data;
  check('deleting the account erased its shipped order\'s address', r2.shippingAddress === null && !!r2.addressErasedAt);
  const r3 = (await query('select data from orders where id = $1', [pending])).rows[0].data;
  check('...but not an unshipped one the creator still has to send', r3.shippingAddress === 'enc:placeholder');
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
