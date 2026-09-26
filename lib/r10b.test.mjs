// Regression tests for the round-10 backend fixes (package R10B), run against a
// real scratch Postgres (it truncates tables). Only @vercel/blob's head() is
// stubbed:
//  - gates-token#0/#1: login brakes are shared Postgres counters; the /48
//    budget only brakes a dirty caller; flooding the in-memory limiter cannot
//    evict a saturated brake; the public per-/64 endpoints have a /48 cap;
//  - money#0: a seller who becomes unpayable is refused with the listing id;
//  - social#0: wall blocks are their own record and never name the commenter
//    (inbox thread, with/<id>, DM-block oracle on the wall flags);
//  - accounts#0: truncation never leaves half a character (jsonb writes);
//  - accounts#1-5: the audited filter strings, both directions.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r10b.test.mjs

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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r10b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r10b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
process.env.NEXT_PUBLIC_MARKETPLACE_PAYOUT_ADDRESS = '0x000000000000000000000000000000000000dEaD';
process.env.NEXT_PUBLIC_MARKETPLACE_USDC_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_ID = '4663';
process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_NAME = 'Test Chain';
process.env.NEXT_PUBLIC_MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
process.env.MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const realBlob = await import('@vercel/blob');
mock.module('@vercel/blob', {
  namedExports: { ...realBlob, head: async () => ({ contentType: 'image/jpeg', size: 1024 }) },
});

const { query, withTransaction, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const locks = await import('./media-locks.js');
const credits = await import('./credits-store.js');
const orders = await import('./orders-store.js');
const deposit = await import('./deposit.js');
const wall = await import('./wall-store.js');
const messages = await import('./messages-store.js');
const { screenPublicText } = await import('./prohibited-terms.js');
const { detectPaymentCircumvention } = await import('./payment-circumvention-filter.js');
const { sanitizeTags } = await import('./creator-status.js');
const rateLimit = await import('./rate-limit.js');
const { createSessionToken } = await import('./session.js');
const { default: loginRoute } = await import('../pages/api/auth/login.js');
const { default: wallBlockRoute } = await import('../pages/api/wall/block.js');
const { default: wallListRoute } = await import('../pages/api/wall/list.js');
const { default: wallPostRoute } = await import('../pages/api/wall/post.js');
const { default: conversationsRoute } = await import('../pages/api/messages/conversations.js');
const { default: dmBlockRoute } = await import('../pages/api/messages/block.js');
const { default: sendRoute } = await import('../pages/api/messages/send.js');
const { default: withRoute } = await import('../pages/api/messages/with/[userId].js');
const { default: checkoutRoute } = await import('../pages/api/marketplace/orders/create.js');
const { default: profileRoute } = await import('../pages/api/me/profile.js');
const { default: waitlistRoute } = await import('../pages/api/waitlist.js');
const loginGuard = await import('./login-guard.js');
const { sliceText } = await import('./unicode-text.js');
const { sanitizeLocation, sanitizeSocials } = await import('./creator-status.js');

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
async function call(route, { method = 'POST', body, query: q = {}, admin = false, adminKey = null, user = null, ip = null, cookies = {} } = {}) {
  ipN++;
  const res = fakeRes();
  const addr = ip || `10.99.${Math.floor(ipN / 250)}.${ipN % 250}`;
  const headers = {};
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  if (adminKey) headers['x-admin-key'] = adminKey;
  const cookieJar = { ...cookies };
  if (user) cookieJar.oa_session = createSessionToken(user.id, user.sessionVersion || 0);
  if (Object.keys(cookieJar).length) headers.cookie = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  const req = { method, body, query: q, headers, cookies: cookieJar, socket: { remoteAddress: addr } };
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r10bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r10b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan(email = null) {
  n++;
  return users.createUser({ email: email || `f${n}@r10b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---------------------------------------------------------------------------
section('gates-token#0: the /48 budget (round 11: a saturated /48 refuses every caller in it)');
{
  await reset();
  const owner = await mkFan('owner48@r10b.test');
  // A /48 whose failure budget someone has spent. Round 10 let a clean /64
  // through here; round 11 (gates-token#0) refuses it, because a routed /48 is
  // 65,536 clean /64s. The carrier-lockout trade-off is documented in login.js.
  for (let i = 0; i < 100; i++) await loginGuard.consumeLoginAttempts([{ key: 'login:net:2001:db8:aa::/48', limit: 100 }]);
  const good = await call(loginRoute, { body: { email: owner.email, password: 'password123' }, ip: '2001:db8:aa:1::1' });
  check('a clean /64 of a saturated /48 is refused before the compare (round-11 design)', good.statusCode === 429, `${good.statusCode} ${JSON.stringify(good.body)}`);
  const wrong = await call(loginRoute, { body: { email: 'someone@r10b.test', password: 'nope' }, ip: '2001:db8:aa:2::1' });
  check('...and so is a clean /64 with a wrong password', wrong.statusCode === 429, String(wrong.statusCode));
  const again = await call(loginRoute, { body: { email: 'else@r10b.test', password: 'nope' }, ip: '2001:db8:aa:2::9' });
  check('...and any other /64 of it', again.statusCode === 429, String(again.statusCode));
  const other48 = await call(loginRoute, { body: { email: 'else@r10b.test', password: 'nope' }, ip: '2001:db8:ab:2::1' });
  check('another /48 is unaffected', other48.statusCode === 401, String(other48.statusCode));

  // Only FAILED logins count against the /48: successes give their slot back.
  await reset();
  const u = await mkFan('often@r10b.test');
  for (let i = 1; i <= 12; i++) {
    const r = await call(loginRoute, { body: { email: u.email, password: 'password123' }, ip: `2001:db8:cc:${i.toString(16)}::1` });
    if (r.statusCode !== 200) { check('successful logins', false, String(r.statusCode)); break; }
  }
  const counters = await loginGuard.readLoginCounters(['login:net:2001:db8:cc::/48']);
  check('twelve successful logins leave the /48 counter at zero', counters['login:net:2001:db8:cc::/48'] === 0, JSON.stringify(counters));
}

section('gates-token#1: login brakes live in Postgres, and the in-memory limiter keeps saturated keys');
{
  await reset();
  const email = 'grind@r10b.test';
  // Round 11 (gates-token#1): a host is "dirty" for an account only after its
  // own third failure against it, so 10.10.0.1 fails three times here.
  for (let i = 1; i <= 10; i++) await call(loginRoute, { body: { email, password: `g${i}` }, ip: `10.10.0.${i}` });
  await call(loginRoute, { body: { email, password: 'g1b' }, ip: '10.10.0.1' });
  await call(loginRoute, { body: { email, password: 'g1c' }, ip: '10.10.0.1' });
  const dirty1 = await call(loginRoute, { body: { email, password: 'g11' }, ip: '10.10.0.1' });
  check('a host that failed against a saturated account is braked', dirty1.statusCode === 429, String(dirty1.statusCode));
  // Flood the in-memory limiter with fresh keys (the eviction attack).
  for (let i = 0; i < 25_000; i++) rateLimit.consumeAttempt(`flood:ip:${i}`, { limit: 5, windowMs: 60_000 });
  const dirty2 = await call(loginRoute, { body: { email, password: 'g12' }, ip: '10.10.0.1' });
  check('...and still is after 25,000 fresh limiter keys', dirty2.statusCode === 429, String(dirty2.statusCode));
  const { rows } = await query('select key from login_attempts');
  check('the counters are rows in login_attempts', rows.length >= 3, String(rows.length));
  check('...keyed by digest, never the typed identifier', rows.every((r) => /^[0-9a-f]{64}$/.test(r.key)) && !JSON.stringify(rows).includes('grind'));

  // A saturated in-memory key survives a flood of other keys.
  for (let i = 0; i < 3; i++) rateLimit.consumeAttempt('keep:me', { limit: 3, windowMs: 60_000 });
  for (let i = 0; i < 25_000; i++) rateLimit.consumeAttempt(`flood2:ip:${i}`, { limit: 5, windowMs: 60_000 });
  check('a saturated limiter key is not evicted by a flood', rateLimit.consumeAttempt('keep:me', { limit: 3, windowMs: 60_000 }).limited === true);
  rateLimit.recordFailure('mark:me', { limit: 1, windowMs: 60_000 });
  for (let i = 0; i < 25_000; i++) rateLimit.consumeAttempt(`flood3:ip:${i}`, { limit: 5, windowMs: 60_000 });
  check('a failure marker is not evicted by a flood of counters', rateLimit.checkRateLimit('mark:me', { limit: 1, windowMs: 60_000 }).limited === true);

  // The public per-/64 endpoints now have a /48 cap.
  let lastLimited = false;
  for (let i = 0; i < 101; i++) {
    const r = rateLimit.consumeNetworkAttempt({ headers: {}, socket: { remoteAddress: `2001:db8:ee:${(i + 1).toString(16)}::1` } }, 'r10b-probe', { limit: 10, networkLimit: 100, windowMs: 60_000 });
    lastLimited = r.limited;
  }
  check('the 101st fresh /64 of one /48 is refused', lastLimited === true);
  const w = await call(waitlistRoute, { body: { email: 'a@b.test', role: 'fan' }, ip: '2001:db8:ef:1::1' });
  check('the waitlist still answers a clean caller', w.statusCode === 200 || w.statusCode === 201, `${w.statusCode} ${JSON.stringify(w.body)}`);

  // The guard's counters themselves.
  const k = [{ key: 'unit:a', limit: 2 }, { key: 'unit:b', limit: 5 }];
  await loginGuard.consumeLoginAttempts(k);
  await loginGuard.consumeLoginAttempts(k);
  const third = await loginGuard.consumeLoginAttempts(k);
  check('consume reports prior counts and the limit', third['unit:a'].prior === 2 && third['unit:a'].limited === true && third['unit:b'].limited === false, JSON.stringify(third));
  const fourth = await loginGuard.consumeLoginAttempts([{ key: 'unit:a', limit: 2 }]);
  // Every consume is counted (no cap), so every release undoes a real one.
  check('...a knock on a saturated counter is counted too', fourth['unit:a'].limited
    && (await loginGuard.readLoginCounters(['unit:a']))['unit:a'] === 4, JSON.stringify(fourth));
  await loginGuard.releaseLoginAttempts(['unit:a', 'unit:a'.replace('a', 'zz')]);
  check('release takes one back', (await loginGuard.readLoginCounters(['unit:a']))['unit:a'] === 3);
  check('markLoginFailure reports first vs repeat', (await loginGuard.markLoginFailure('unit:m')) === 1
    && (await loginGuard.markLoginFailure('unit:m')) === 2);
  await query(`update login_attempts set window_start = now() - interval '16 minutes'`);
  const fresh = await loginGuard.consumeLoginAttempts([{ key: 'unit:a', limit: 2 }]);
  check('an expired window starts over', fresh['unit:a'].prior === 0 && !fresh['unit:a'].limited, JSON.stringify(fresh));
  check('duplicate keys are refused', !!(await errOf(() => loginGuard.consumeLoginAttempts([{ key: 'x', limit: 1 }, { key: 'x', limit: 1 }]))));
}

section('R10B fix-up: parallel bursts cannot under-count the login brakes');
{
  await reset();
  const target = await mkFan('burst@r10b.test');
  let compares = 0;
  // Count bcrypt compares by counting 401s (wrong password) -- a refused
  // request never reaches the compare.
  for (let burst = 0; burst < 5; burst++) {
    const rs = await Promise.all(Array.from({ length: 60 }, (_, i) =>
      call(loginRoute, { body: { email: target.email, password: `w${burst}-${i}` }, ip: '10.77.0.1' })));
    compares += rs.filter((r) => r.statusCode === 401).length;
  }
  check('five parallel bursts of 60 from one host get at most MAX_ATTEMPTS_PER_IP compares', compares <= 10, String(compares));
  const c = await loginGuard.readLoginCounters(['login:ip:10.77.0.1']);
  check('...and the per-IP counter equals the compares let through', c['login:ip:10.77.0.1'] === compares, `${JSON.stringify(c)} vs ${compares}`);

  // One /64 failing in parallel counts once towards its /48's dirty marker.
  await reset();
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    call(loginRoute, { body: { email: 'mark48@r10b.test', password: `p${i}` }, ip: `2001:db8:dd:1::${i + 1}` })));
  const fromnet = await loginGuard.readLoginCounters(['login:account:mark48@r10b.test:fromnet:2001:db8:dd::/48']);
  check('a parallel burst from one /64 adds 1 (not 3) to the /48 dirty count',
    fromnet['login:account:mark48@r10b.test:fromnet:2001:db8:dd::/48'] === 1, JSON.stringify(fromnet));
}

section('R10B fix-up: a bare "?" or a far "leave" is not an underage disclaimer');
{
  const { detectProhibitedTerms } = await import('./prohibited-terms.js');
  for (const t of ['new underage? set 😈', 'underage?? you know what I sell', 'under aged? new pics', 'underage leave you wanting more']) {
    check(`refused: ${t}`, detectProhibitedTerms(t).flagged === true);
  }
  for (const t of ['Underage? leave now.', 'underage?? DNI', 'underage, leave', 'underage content not allowed']) {
    check(`passes: ${t}`, detectProhibitedTerms(t).flagged === false);
  }
}

// ---------------------------------------------------------------------------
section('money#0: an unpayable seller is refused with the listing id');
{
  await reset();
  const good = await mkCreatorUser();
  const bad = await mkCreatorUser();
  const lg = await mkListing(good.creator.id);
  const lb = await mkListing(bad.creator.id);
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 10_000, type: 'deposit' });
  // The store: RECIPIENT_UNAVAILABLE carries the item's listing id.
  // Suspended after the cart was built (an admin action mid-checkout).
  await query(`update creators set data = data || '{"status":"suspended"}'::jsonb where id = $1`, [String(bad.creator.id)]);
  const err = await errOf(() => orders.createOrdersFromCredits({
    buyerId: fan.id,
    items: [
      { listingId: String(lg.id), creatorId: String(good.creator.id), creatorUserId: good.user.id, priceCents: 500, kind: 'digital', title: 'Set' },
      { listingId: String(lb.id), creatorId: String(bad.creator.id), creatorUserId: bad.user.id, priceCents: 500, kind: 'digital', title: 'Set' },
    ],
    ageConfirmed: true,
    tosAccepted: true,
  }));
  check('the store tags the refusal with the listing id', err?.code === credits.RECIPIENT_UNAVAILABLE && String(err.listingId) === String(lb.id), JSON.stringify({ code: err?.code, listingId: err?.listingId }));
  const bal = (await query('select balance_cents from credit_balances where user_id = $1', [String(fan.id)])).rows[0].balance_cents;
  check('...and nothing was charged', Number(bal) === 10_000, String(bal));
  // The route: the unpayable seller is caught up front, with the listing id
  // the cart drops.
  const item = (l) => ({ listingId: String(l.id), expectedPriceCents: 500, expectedShippingCents: 0, expectedKind: 'digital' });
  const r = await call(checkoutRoute, { user: fan, body: { items: [item(lg), item(lb)], ageConfirmed: true, tosAccepted: true, idempotencyKey: crypto.randomUUID(), expectedBuyerId: String(fan.id) } });
  check('checkout answers with the unpayable seller\'s listing id', (r.statusCode === 404 || r.statusCode === 409) && r.body.listingId === String(lb.id), `${r.statusCode} ${JSON.stringify(r.body)}`);
  const src = (await import('fs')).readFileSync(new URL('../pages/api/marketplace/orders/create.js', import.meta.url), 'utf8');
  check('the route maps a tagged RECIPIENT_UNAVAILABLE to { code, listingId }', /code: RECIPIENT_UNAVAILABLE,[\s\S]{0,120}listingId: String\(err\.listingId\)/.test(src));
}

// ---------------------------------------------------------------------------
section('social#0: a wall block never names the anonymous commenter');
{
  await reset();
  const c = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 10_000, type: 'deposit' });
  const sent = await call(sendRoute, { user: fan, body: { toUserId: String(c.user.id), text: 'hi there', expectedPriceCents: 99 } });
  check('the fan paid to DM the creator', sent.statusCode === 200, `${sent.statusCode} ${JSON.stringify(sent.body)}`);
  const post = await wall.addWallPost({ creatorId: c.creator.id, authorId: fan.id, authorName: 'Someone', text: 'mean comment' });
  const blk = await call(wallBlockRoute, { user: c.user, body: { postId: String(post.id) } });
  check('the creator blocks the comment\'s author', blk.statusCode === 200 && blk.body.postIds.includes(String(post.id)), JSON.stringify(blk.body));

  // (1) the named thread does not show the block.
  const inbox = await call(conversationsRoute, { method: 'GET', user: c.user });
  const named = inbox.body.conversations.find((r) => r.other?.userId === String(fan.id));
  check('the named DM thread is not marked blocked', named && named.blockedByMe === false, JSON.stringify(named));
  const opaque = inbox.body.conversations.filter((r) => r.wallBlock);
  check('the wall block is listed as one opaque row', opaque.length === 1 && opaque[0].other.userId === null
    && !JSON.stringify(opaque).includes(String(fan.id)), JSON.stringify(opaque));
  // (2) probing the id.
  const probe = await call(withRoute, { method: 'GET', user: c.user, query: { userId: String(fan.id) } });
  check('with/<id> reports no block', probe.statusCode === 200 && probe.body.conversation.blockedByMe === false
    && !/blocked/i.test(probe.body.cannotSendReason || ''), JSON.stringify({ c: probe.body.conversation?.blockedByMe, r: probe.body.cannotSendReason }));
  const stranger = await mkFan();
  const probe2 = await call(withRoute, { method: 'GET', user: c.user, query: { userId: String(stranger.id) } });
  check('...and looks the same as for anyone else', JSON.stringify([probe.body.conversation.blockedByMe, probe.body.canSend])
    === JSON.stringify([probe2.body.conversation.blockedByMe, probe2.body.canSend]), JSON.stringify([probe.body.canSend, probe2.body.canSend]));

  // Enforcement: the author can't comment or DM; the creator can still reply.
  const again = await call(wallPostRoute, { user: fan, body: { creatorId: String(c.creator.id), text: 'another one' } });
  check('the wall-blocked author cannot comment', again.statusCode === 403, `${again.statusCode} ${JSON.stringify(again.body)}`);
  const dm = await call(sendRoute, { user: fan, body: { toUserId: String(c.user.id), text: 'let me in', expectedPriceCents: 99 } });
  check('...or DM the creator (refused, generically, before any charge)', dm.statusCode === 403 && !/wall/i.test(dm.body.error || ''), `${dm.statusCode} ${JSON.stringify(dm.body)}`);
  const balF = (await query('select balance_cents from credit_balances where user_id = $1', [String(fan.id)])).rows[0].balance_cents;
  check('...and was not charged for it', Number(balF) === 10_000 - 99, String(balF));
  const reply = await call(sendRoute, { user: c.user, body: { toUserId: String(fan.id), text: 'noted' } });
  check('the creator can still reply to the thread', reply.statusCode === 200, `${reply.statusCode} ${JSON.stringify(reply.body)}`);

  // (3) a DM block by id never flips the wall flags.
  const fan2 = await mkFan();
  const p2 = await wall.addWallPost({ creatorId: c.creator.id, authorId: fan2.id, authorName: 'Someone', text: 'anon' });
  await call(dmBlockRoute, { user: c.user, body: { userId: String(fan2.id), blocked: true } });
  const list = await call(wallListRoute, { method: 'GET', user: c.user, query: { creatorId: String(c.creator.id) } });
  const flag = list.body.posts.find((p) => String(p.id) === String(p2.id));
  check('a DM block by id does not flag that account\'s anonymous comments', flag && flag.authorBlocked === false, JSON.stringify(flag));
  const oracle = await call(wallBlockRoute, { user: c.user, body: { postId: String(p2.id), blocked: false } });
  check('...and "unblock" on the comment reports nothing to flip', oracle.statusCode === 200 && oracle.body.postIds.length === 0, JSON.stringify(oracle.body));
  const dmStill = await messages.blockBetween(c.user.id, fan2.id);
  check('...the DM block itself is untouched', dmStill === 'me', String(dmStill));

  // Unblock by handle lifts the wall block.
  const un = await call(dmBlockRoute, { user: c.user, body: { blockHandle: opaque[0].blockHandle, blocked: false } });
  check('the opaque row unblocks by handle', un.statusCode === 200 && (await messages.isWallBlocked(c.user.id, fan.id)) === false, JSON.stringify(un.body));

  // Deleting the author's account removes the wall block record too.
  await messages.setWallBlocked(c.user.id, fan2.id, true);
  await withTransaction((cl) => users.purgeUserContent(cl, fan2.id));
  check('purging an account removes its wall blocks', (await query('select 1 from wall_blocks where author_id = $1', [String(fan2.id)])).rows.length === 0);

  // Legacy block-only rows move into wall_blocks (lib/db.js).
  const legacyOwner = await mkCreatorUser();
  const legacyAuthor = await mkFan();
  const pid = [String(legacyOwner.user.id), String(legacyAuthor.id)].sort().join('__');
  await query('insert into conversations (id, data) values ($1, $2)', [pid, { id: pid, participantIds: [String(legacyOwner.user.id), String(legacyAuthor.id)], messages: [], senders: [], createdByBlock: true, blockedBy: [String(legacyOwner.user.id)] }]);
  const dbSrc = (await import('fs')).readFileSync(new URL('./db.js', import.meta.url), 'utf8');
  const migration = dbSrc.slice(dbSrc.indexOf('with legacy as ('), dbSrc.indexOf("= 0;\n`;") + 4);
  await query(migration);
  check('a legacy block-only row becomes a wall block', await messages.isWallBlocked(legacyOwner.user.id, legacyAuthor.id)
    && (await query('select 1 from conversations where id = $1', [pid])).rows.length === 0);
  const dmKind = await messages.setConversationBlocked(legacyOwner.user.id, legacyAuthor.id, true);
  await query(migration);
  check('...while a DM block by id (blockKind dm) is left alone', dmKind.blockedByMe === true
    && (await messages.blockBetween(legacyOwner.user.id, legacyAuthor.id)) === 'me');
}

// ---------------------------------------------------------------------------
section('accounts#0: truncation never cuts a character in half');
{
  await reset();
  const loc = 'Based in Miami but I travel a lot so ask me where I am 🌴✈️🌍';
  const out = sanitizeLocation(loc);
  check('sanitizeLocation keeps whole characters', out.length <= 60 && !/[\uD800-\uDBFF]$/.test(out) && JSON.stringify(out).indexOf('\\ud') === -1, JSON.stringify(out));
  const tag = sanitizeTags(['aaaaaaaaaaaaaaaaaaaaaaa𝐭'])[0];
  check('sanitizeTags keeps whole characters', typeof tag === 'string' && JSON.stringify(tag).indexOf('\\ud') === -1, JSON.stringify(tag));
  const soc = sanitizeSocials({ instagram: 'a'.repeat(49) + '🌍', website: 'https://x.test/' + 'a'.repeat(184) + '🌍' });
  check('sanitizeSocials keeps whole characters', JSON.stringify(soc).indexOf('\\ud') === -1, JSON.stringify(soc));
  check('sliceText drops a lone surrogate anywhere', sliceText('ab\uD83Ccd', 10) === 'abcd' && sliceText('🌍🌍', 3) === '🌍');

  const c = await mkCreatorUser();
  const saved = await call(profileRoute, { user: c.user, body: { fields: { location: 'Miami 🌴 ' + 'x'.repeat(48) + '🌍', tags: 'ᴄᴏsᴘʟᴀʏ 𝐠𝐢𝐫𝐥𝐬 𝐧𝐞𝐱𝐭 𝐝𝐨𝐨𝐫, gym' } } });
  check('a profile save with emoji on the boundaries succeeds', saved.statusCode === 200, `${saved.statusCode} ${JSON.stringify(saved.body)}`);
  const long = await call(profileRoute, { user: c.user, body: { fields: { location: loc } } });
  check('an over-long location is refused clearly, not a 500', long.statusCode === 400 && /location/i.test(long.body.error), `${long.statusCode} ${JSON.stringify(long.body)}`);
  const lone = await call(profileRoute, { user: c.user, body: { fields: { bio: 'hello \uD83C there' } } });
  check('a bio with an unpaired surrogate is refused (400), not a 500', lone.statusCode === 400, `${lone.statusCode} ${JSON.stringify(lone.body)}`);
  const l = await listings.createListing(c.creator.id, { title: 'Tagged', priceCents: 500, kind: 'digital', unlimited: true, tags: 'ᴄᴏsᴘʟᴀʏ 𝐠𝐢𝐫𝐥𝐬 𝐧𝐞𝐱𝐭 𝐝𝐨𝐨𝐫' });
  check('a listing whose tag is cut on a fancy-font letter is stored', !!l?.id, JSON.stringify(l?.tags));
  const v = await errOf(() => (import('./violations-store.js')).then((m) => m.addViolation({ userId: 'x', context: 'bio', reasons: ['r'], snippet: 'y'.repeat(199) + '🌍' })));
  check('a violation snippet cut on an emoji is stored', v === null, v?.message);
}

// ---------------------------------------------------------------------------
section('accounts#1: negative circled/squared and regional-indicator letters');
{
  for (const t of ['🅣🅔🅔🅝', '🆃🅴🅴🅽', '🇹 🇪 🇪 🇳', '🇹🇪🇪🇳', '🆃🅴🅴🅽 set 🔥']) {
    check(`refused: ${t}`, screenPublicText(t)?.kind === 'prohibited', JSON.stringify(screenPublicText(t)));
  }
  for (const t of ['🆅🅴🅽🅼🅾 me', '🅥🅔🅝🅜🅞', 'tip me on 🆅🅴🅽🅼🅾']) {
    check(`payment: ${t}`, screenPublicText(t)?.kind === 'payment', JSON.stringify(screenPublicText(t)));
  }
  for (const t of ['proud 🇺🇸 creator', '🇮🇹aly trip', 'love from 🇵🇭 and 🇹🇬', '🅰️ grade', '🅱️ideo']) {
    check(`passes: ${t}`, screenPublicText(t) === null, JSON.stringify(screenPublicText(t)));
  }
}

section('accounts#2: yrs, years young, spelled ages with "and", under-aged');
{
  for (const t of ['new 17yrs girl', 'hot 16yrs', '#16yrs', 'tiny 15yrs', '16 years young', "i'm sixteen and horny",
    "she's sixteen and loves older men", 'under-aged', 'under aged', 'underaged', "i'm 16 yrs", '17 yrs girl']) {
    check(`refused: ${t}`, screenPublicText(t)?.kind === 'prohibited', JSON.stringify(screenPublicText(t)));
  }
  for (const t of ['I ran 16 yrs', '15 yrs experience modeling', 'my 16 yrs of modeling', "i'm fifteen minutes away",
    "he's 12 yrs into his career", 'aged twelve and eighteen months cheddar', 'Brand turned 12 yrs old', '10 yrs in the game']) {
    check(`passes: ${t}`, screenPublicText(t) === null, JSON.stringify(screenPublicText(t)));
  }
}

section('accounts#3: "underage" disclaimers and "tweening" pass');
{
  for (const t of ['18+ only, no underage', 'No one underage allowed', 'Underage? leave now.', 'are you underage? just checking lol',
    "no I'm not underage, I'm 24", '2D animator, frame by frame tweening', 'tweened walk cycle', 'minors/underage DNI',
    "if you're underage please leave", 'underage users will be banned']) {
    check(`passes: ${t}`, screenPublicText(t) === null, JSON.stringify(screenPublicText(t)));
  }
  for (const t of ['underage girl', 'new underage set', 'underage allowed', 'hot underagegirl', 'tweens', 'new tween set']) {
    check(`refused: ${t}`, screenPublicText(t)?.kind === 'prohibited', JSON.stringify(screenPublicText(t)));
  }
}

section('accounts#4: SC / LINE / WeChat / Viber handovers and wa.link');
{
  for (const t of ['SC @janedoe', 'add me on sc janedoe99', 'sc: jane_doe99', 'my sc is jane_doe99', 'wechat: janedoe99',
    'line: janedoe99', 'viber: janedoe99', 'https://wa.link/x7k2p9', 'my line is jane_doe99']) {
    check(`flagged: ${t}`, detectPaymentCircumvention(t).flagged === true, JSON.stringify(detectPaymentCircumvention(t)));
  }
  for (const t of ['SC state', 'shipping to SC, NC and GA', 'drop me a line', 'bottom line: I only sell here', 'new line of sets',
    'line up for the drop']) {
    check(`passes: ${t}`, screenPublicText(t) === null, JSON.stringify(screenPublicText(t)));
  }
  check('"sc premium" is still flagged as paid snapchat', detectPaymentCircumvention('sc premium').flagged === true);
}

section('accounts#5: non-US phone groupings next to a cue');
{
  for (const t of ['text me 07700 900123', 'text me 07700 900 123', 'whatsapp 0412 345 678', 'text me 06 12 34 56 78',
    'text me 0151 2345 6789', "text me 07700 900123 and I'll send you my deal"]) {
    check(`flagged: ${t}`, detectPaymentCircumvention(t).flagged === true, JSON.stringify(detectPaymentCircumvention(t)));
  }
  for (const t of ['text me for prices: 10 20 30 50', 'text me for prices: 10 20 30 50 100 250', 'pack sizes 0412 345',
    'sets are 0.99 1.99 2.99, text me', 'call me at 0 5 10', '06 12 34 56 78 photo ids']) {
    check(`passes: ${t}`, detectPaymentCircumvention(t).flagged === false, JSON.stringify(detectPaymentCircumvention(t)));
  }
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
