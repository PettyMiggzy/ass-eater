// Regression tests for the round-9 backend fixes (package R9B), run against a
// real scratch Postgres (it truncates tables). Only @vercel/blob's head() is
// stubbed; everything else is real:
//  - accounts#0-3: small capitals, dotless i, capital-I-for-l, digit ages after
//    a self lead-in, sexual continuations, age/sex labels, "_"/"." joined and
//    glued forms -- every audited string, in the right direction, both ways;
//  - gates-token#0: login, admin-key and signup brakes also bucket per IPv6 /48;
//  - media#0: an owner removing a listing file takes the file lock BEFORE the
//    listing row;
//  - media#1: lockListingsWithFiles never waits on a late file out of order
//    (restarts instead), and a savepoint rollback really releases the locks;
//  - money#0: checkout takes the account rows before any file lock;
//  - money#1: an admin close refuses an order whose seller can still ship it;
//  - money#2: an already-credited hash is answered as such for every account,
//    and manual-credit says "nothing new was added";
//  - dashboard#0 / public-pages#0 / legal-journeys#0: the close note (and the
//    seller's receipt) never reach the buyer or seller order APIs;
//  - social#0 / dashboard#1: a block-only inbox row names nobody;
//  - admin-ui#0 / #1: admin order summaries, and a creator's listings for a
//    standalone takedown.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r9b.test.mjs

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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r9b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r9b';
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
const { default: adminCreatorsRoute } = await import('../pages/api/admin/creators.js');
const { default: orderCloseRoute } = await import('../pages/api/admin/order-close.js');
const { default: adminOrdersRoute } = await import('../pages/api/admin/orders.js');
const { default: contentLookupRoute } = await import('../pages/api/admin/content-lookup.js');
const { default: buyRoute } = await import('../pages/api/credits/buy.js');
const { default: manualCreditRoute } = await import('../pages/api/admin/manual-credit.js');
const { default: mineRoute } = await import('../pages/api/marketplace/orders/mine.js');
const { default: creatorOrdersRoute } = await import('../pages/api/marketplace/orders/creator.js');
const { default: wallBlockRoute } = await import('../pages/api/wall/block.js');
const { default: conversationsRoute } = await import('../pages/api/messages/conversations.js');
const { default: dmBlockRoute } = await import('../pages/api/messages/block.js');

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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r9bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r9b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan(email = null) {
  n++;
  return users.createUser({ email: email || `f${n}@r9b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileLockFree = async (pathname) => {
  // A separate connection try-locks (and releases) the file's advisory lock.
  return withTransaction(async (c) => {
    const { rows } = await c.query(`select pg_try_advisory_xact_lock(hashtext('media-file:' || $1)) as ok`, [pathname]);
    return rows[0].ok === true;
  });
};
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); })]);

// ---------------------------------------------------------------------------
section('accounts#0: small capitals, dotless i and capital-I-for-l');
{
  const refused = ['ᴛᴇᴇɴ', 'ʟᴏʟɪ', 'sᴄʜᴏᴏʟɢɪʀʟ', 'ʀᴀᴘᴇ', 'jaılbaıt', 'ıncest', 'lolı', 'LoIita'];
  for (const t of refused) check(`prohibited: ${t}`, screenPublicText(t)?.kind === 'prohibited', JSON.stringify(screenPublicText(t)));
  const payment = ['Tip me on ᴠᴇɴᴍᴏ', 'My PaypaI: jane99', 'OnIyFans link in bio', 'ZeIIe', 'ᴄᴀꜱʜ ᴀᴘᴘ $jane'];
  for (const t of payment) check(`payment: ${t}`, !!screenPublicText(t), JSON.stringify(screenPublicText(t)));
  for (const t of ['ᴛᴇᴇɴ', 'ʟᴏʟɪ', 'sᴄʜᴏᴏʟɢɪʀʟ']) {
    check(`tag refused: ${t}`, listings.findCircumventionInTags([t])?.kind === 'prohibited', JSON.stringify(listings.findCircumventionInTags([t])));
  }
  // Honest capital I stays honest.
  for (const t of ['McIntyre says hi', 'Hi I am Iris', 'WiFI is down', 'NEW SET IS LIVE', 'iPhone photos only']) {
    check(`passes: ${t}`, screenPublicText(t) === null, JSON.stringify(screenPublicText(t)));
  }
  check('a small-capital tag is stored as the plain word', JSON.stringify(sanitizeTags('ᴄᴏsᴘʟᴀʏ, Gym')) === '["cosplay","gym"]', JSON.stringify(sanitizeTags('ᴄᴏsᴘʟᴀʏ, Gym')));
  check('payment filter reads the l-reading too', detectPaymentCircumvention('PaypaI me').flagged === true);
}

section('accounts#1: sizes, ratings and times are not ages');
{
  const allowed = ["I'm a size 12", "curvy and proud, I'm a size 14", "she's a size 16!", "I'm a 10", "she's a 10", "I'm a solid 10",
    "I'm free at 10", "I'm live at 10!", "I'm back at 12", "I'm off at 11.", "she's online at 11", "i'm up till 12, dm me",
    "I'm free after 10", "he's home by 11", "i'm in room 12", "i'm on day 12", "i'm level 16", "He's number 12",
    'I started modeling at age 16', 'been drawing since age 15, now 24',
    // Units and counts right after a digit age.
    "i'm 15 minutes away", "I'm 12 inches", "i'm 10/10 would recommend", "i'm 16th in line", "I'm 13 days sober",
    "she's 11 weeks pregnant", 'babes 10 pics', 'Here are 10 sexy photos', 'sizes 10, 12, 14', 'Top 10 horny sets',
    // Earlier rounds' must-pass cases this touches.
    'Toyota 12yo', 'Rolling 10yo', 'Top 10 yo mama jokes', 'My Kia is 11 yo lol', 'aged 12 years old single malt',
    'My blog turned 15 years old today', 'Brand turned 12 yrs old', 'sipping a Macallan 12yo and watching your new set',
    "I'm fifteen minutes away", 'ten minutes of teasing', 'My blog just turned 12 today', '18yo', '19 years old', 'No one under 18',
    'shot at f/16', 'hit 12m views', '$12/m', 'room_12', 'v1.16'];
  for (const t of allowed) check(`passes: ${t}`, screenPublicText(t) === null, JSON.stringify(screenPublicText(t)));
  for (const t of ["I'm 17", "i'm only 16", 'aged 16.', 'age: 16', 'i just turned 16', 'I turned 15.', "I'm 16 years old"]) {
    check(`still refused: ${t}`, screenPublicText(t)?.kind === 'prohibited', JSON.stringify(screenPublicText(t)));
  }
}

section('accounts#2: explicit claims with something after the number');
{
  const refused = ['im 17 and horny', "I'm 16 & horny", "she's 16 and loves older men", "i'm 16 lol", "i'm 16 btw",
    'I just turned 17 today', 'just turned 16 and ready', "i'm only 17 and horny", '17 years old and horny', 'only 17 years old',
    'girl 16yo', 'gf 16yo', 'slut 16', 'slut, 16', 'Emma, 16, horny', '16f', '16F horny', '[16f]', 'f/16', '16/f/usa',
    'hot 16yo', '16yo gf'];
  for (const t of refused) check(`refused: ${t}`, screenPublicText(t)?.kind === 'prohibited', JSON.stringify(screenPublicText(t)));
  // Known, documented miss: a given name before a spaced short form reads the
  // same as "Toyota 12yo", which must pass. Glued or "_"-joined it is caught.
  check('documented: "emma 16yo" is the same shape as "Toyota 12yo"', screenPublicText('emma 16yo') === null);
  check('...but "emma16yo" and "emma_16_yo" are refused',
    screenPublicText('emma16yo')?.kind === 'prohibited' && screenPublicText('emma_16_yo')?.kind === 'prohibited');
}

section('accounts#3: "_" / "." separators and glued forms');
{
  const refused = ['16_yo', 'lily_16_yo', 'hot_16_yo', '16_year_old', 'jess.16.yo', '16.yo', 'im_16', 'aged_16', 'slut_16',
    'girl16yo', 'lily16yo', 'hot16yo', '16yearsold'];
  for (const t of refused) check(`refused: ${t}`, screenPublicText(t)?.kind === 'prohibited', JSON.stringify(screenPublicText(t)));
  for (const tag of ['hot_16_yo', 'girl16yo', '16f']) {
    check(`tag refused: ${tag}`, listings.findCircumventionInTags([tag])?.kind === 'prohibited', JSON.stringify(listings.findCircumventionInTags([tag])));
  }
  for (const t of ['room_12', 'v1.16', 'y2k_aesthetic', 'mia_1999', 'jane2000']) {
    check(`passes: ${t}`, screenPublicText(t) === null, JSON.stringify(screenPublicText(t)));
  }
}

section('fix-up: label and count false positives');
{
  // The trailing-word label rule takes the female form and a sexual word
  // only; apertures, rooms, apartments, scores and horse heights pass.
  for (const t of ['Shot on f/16 girl portraits', 'Apt 14F dm me', 'room 12f girls night', 'Reached 13m dm me for collabs',
    "he's 16 hands tall", "I'm now 12 for 12", "she's 10 out of 10", 'shot at f/16 horny']) {
    check(`passes: ${t}`, screenPublicText(t) === null, JSON.stringify(screenPublicText(t)));
  }
  for (const t of ['16F horny', '16f slut', 'f/16 horny', '16/f/usa horny', "i'm 16 for you", '[16m]']) {
    check(`refused: ${t}`, screenPublicText(t)?.kind === 'prohibited', JSON.stringify(screenPublicText(t)));
  }
}

// ---------------------------------------------------------------------------
section('gates-token#0: IPv6 /48 buckets');
{
  await reset();
  check('a /48 bucket', rateLimit.networkBucketCoarse('2001:470:abcd:1::1') === '2001:470:abcd::/48'
    && rateLimit.networkBucketCoarse('2001:470:abcd:2::1') === '2001:470:abcd::/48');
  check('IPv4 is itself', rateLimit.networkBucketCoarse('1.2.3.4') === '1.2.3.4');
  const email = 'target@r9b.test';
  const statuses = [];
  // Ten wrong guesses at one account from ten different /64s of one /48.
  for (let i = 1; i <= 10; i++) {
    statuses.push((await call(loginRoute, { body: { email, password: `g${i}` }, ip: `2001:db8:77:${i.toString(16)}::1` })).statusCode);
  }
  check('the first ten are answered', statuses.every((s) => s === 401), JSON.stringify(statuses));
  const fresh64 = await call(loginRoute, { body: { email, password: 'x' }, ip: '2001:db8:77:ff::1' });
  check('a FRESH /64 of the same /48 is braked on the saturated account', fresh64.statusCode === 429, String(fresh64.statusCode));
  const other48 = await call(loginRoute, { body: { email, password: 'x' }, ip: '2001:db8:78:1::1' });
  check('a different /48 still gets its answer', other48.statusCode === 401, String(other48.statusCode));

  // One neighbour on a shared /48 failing against an account (after it was
  // saturated from elsewhere) does not lock the whole /48 out of it.
  const victim = 'victim@r9b.test';
  for (let i = 1; i <= 10; i++) await call(loginRoute, { body: { email: victim, password: `v${i}` }, ip: `10.77.0.${i}` });
  const neighbour = await call(loginRoute, { body: { email: victim, password: 'n' }, ip: '2001:db8:99:1::1' });
  check('a neighbour /64 of a clean /48 gets its answer', neighbour.statusCode === 401, String(neighbour.statusCode));
  // Round 11 (gates-token#1): a /64 is braked on a saturated account only
  // after its own third failure against it, so the owner's typo is not a lockout.
  const n2 = await call(loginRoute, { body: { email: victim, password: 'n1b' }, ip: '2001:db8:99:1::3' });
  const n3 = await call(loginRoute, { body: { email: victim, password: 'n1c' }, ip: '2001:db8:99:1::4' });
  check('...and so do its second and third tries', n2.statusCode === 401 && n3.statusCode === 401, `${n2.statusCode} ${n3.statusCode}`);
  const sameHost = await call(loginRoute, { body: { email: victim, password: 'n2' }, ip: '2001:db8:99:1::2' });
  check('...and that /64 itself is now braked', sameHost.statusCode === 429, String(sameHost.statusCode));
  const otherSub = await call(loginRoute, { body: { email: victim, password: 'o' }, ip: '2001:db8:99:2::1' });
  check('...but another subscriber /64 in the same /48 is not', otherSub.statusCode === 401, String(otherSub.statusCode));

  // The admin key: 50 failures per /48, spread across /64s that each stay
  // under their own limit of 10.
  let last = null;
  for (let i = 0; i < 50; i++) {
    last = await call(adminCreatorsRoute, { method: 'GET', adminKey: 'wrong', ip: `2001:db8:55:${(Math.floor(i / 5) + 1).toString(16)}::${(i % 5) + 1}` });
  }
  check('50 wrong admin keys from one /48 are all answered 401', last.statusCode === 401, String(last.statusCode));
  const blocked = await call(adminCreatorsRoute, { method: 'GET', adminKey: 'wrong', ip: '2001:db8:55:ee::1' });
  check('...and the 51st, from a fresh /64 of it, is 429', blocked.statusCode === 429, String(blocked.statusCode));
  const elsewhere = await call(adminCreatorsRoute, { method: 'GET', admin: true, ip: '2001:db8:56:1::1' });
  check('the real key from another /48 works', elsewhere.statusCode === 200, String(elsewhere.statusCode));
}

// ---------------------------------------------------------------------------
section('media#0: an owner removing a listing file locks the file before the row');
{
  await reset();
  const c = await mkCreatorUser();
  const l = await mkListing(c.creator.id);
  const src = l.media[0].src;
  const pathname = src.replace('/api/media/', '');
  // Hold the file lock (as an admin quarantine would, before it touches the
  // listing row), then start the owner's removal.
  let release;
  const gate = new Promise((r) => { release = r; });
  let held;
  const heldP = new Promise((r) => { held = r; });
  const holder = withTransaction(async (cl) => {
    await cl.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [pathname]);
    held();
    await gate;
  });
  await heldP;
  const removal = listings.removeListingMediaForOwner(l.id, c.creator.id, src);
  await sleep(300);
  // While the removal waits on the file, the listing ROW must be free.
  const rowFree = await withTransaction(async (cl) => {
    try {
      await cl.query('select id from listings where id = $1 for update nowait', [String(l.id)]);
      return true;
    } catch (err) {
      return err.code !== '55P03' ? err.code : false;
    }
  });
  check('the listing row is not held while the removal waits for the file', rowFree === true, String(rowFree));
  release();
  await holder;
  const out = await removal;
  check('...and the removal then completes', out && Array.isArray(out.listing.media) && out.listing.media.length === 0);
  const wrongOwner = await errOf(() => listings.removeListingMediaForOwner(l.id, 'not-the-owner', src));
  check('ownership is still enforced on the locked row', wrongOwner && wrongOwner.message === 'Listing not found');
}

// ---------------------------------------------------------------------------
section('media#1: a late file is never waited for out of order');
{
  await reset();
  // Savepoint rollback really releases an advisory xact lock and a row lock.
  const c = await mkCreatorUser();
  const l = await mkListing(c.creator.id);
  const probe = `probe/${crypto.randomUUID()}`;
  const released = await withTransaction(async (cl) => {
    await cl.query('savepoint s1');
    await cl.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [probe]);
    await cl.query('select id from listings where id = $1 for update', [String(l.id)]);
    await cl.query('rollback to savepoint s1');
    const fileFree = await fileLockFree(probe);
    const rowFree = await withTransaction(async (c2) => {
      try { await c2.query('select id from listings where id = $1 for update nowait', [String(l.id)]); return true; } catch { return false; }
    });
    return fileFree && rowFree;
  });
  check('rolling back to a savepoint releases the file and row locks', released === true);

  // Two files on one listing: A (sorts last) and C (sorts first). Our pass
  // peeks a STALE row with only A, so it locks A, row-locks the listing, then
  // finds C. A third transaction holds C and is waiting for A. Blocking on C
  // there was a deadlock; now the pass restarts and both finish.
  const cid = c.creator.id;
  const A = `/api/media/listings/${cid}/${l.id}/ffffffff-0000-4000-8000-000000000000.jpg`;
  const C = `/api/media/listings/${cid}/${l.id}/00000000-0000-4000-8000-000000000000.jpg`;
  await query(`update listings set data = jsonb_set(data, '{media}', $2::jsonb) where id = $1`,
    [String(l.id), JSON.stringify([{ type: 'image', src: A }, { type: 'image', src: C }])]);
  const pA = A.replace('/api/media/', '');
  const pC = C.replace('/api/media/', '');
  let thirdStarted = false;
  let third = null;
  const result = await withTimeout(withTransaction(async (cl) => {
    let peeks = 0;
    const wrapped = {
      query: async (text, params) => {
        if (/^select data from listings where/.test(text) && peeks++ === 0) {
          // Stale peek: the row as it was before C was finalized.
          return { rows: [{ data: { media: [{ type: 'image', src: A }] } }] };
        }
        if (/for update/.test(text) && !thirdStarted) {
          thirdStarted = true;
          third = withTransaction(async (c3) => {
            await c3.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [pC]);
            await c3.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [pA]);
            return 'third-done';
          });
          await sleep(200);
        }
        return cl.query(text, params);
      },
    };
    const { rows, held } = await locks.lockListingsWithFiles(wrapped, { ids: [String(l.id)] });
    return { rows: rows.length, held: [...held].sort() };
  }), 8000).catch((e) => e);
  check('the pass completes without a deadlock', result && !(result instanceof Error), result instanceof Error ? result.code || result.message : '');
  check('...holding both files', result && Array.isArray(result.held) && result.held.includes(pA) && result.held.includes(pC), JSON.stringify(result));
  const thirdOut = await withTimeout(third || Promise.resolve('none'), 8000).catch((e) => e);
  check('...and so does the third transaction', thirdOut === 'third-done', thirdOut instanceof Error ? thirdOut.code || thirdOut.message : String(thirdOut));
  check('tryLockMediaFiles reports a busy file instead of waiting', await withTransaction(async (cl) => {
    let hold;
    const holding = new Promise((r) => { hold = r; });
    let done;
    const finish = new Promise((r) => { done = r; });
    const other = withTransaction(async (c2) => {
      await c2.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [pA]);
      hold();
      await finish;
    });
    await holding;
    const ok = await locks.tryLockMediaFiles(cl, [A], new Set());
    done();
    await other;
    return ok === false;
  }));
}

// ---------------------------------------------------------------------------
section('money#0: checkout takes the account rows before any file lock');
{
  await reset();
  const c = await mkCreatorUser();
  const l = await mkListing(c.creator.id);
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 10_000, type: 'deposit' });
  const pathname = l.media[0].src.replace('/api/media/', '');
  // An admin holds the creator row FOR UPDATE (an attributed NCII resolve).
  let release;
  const gate = new Promise((r) => { release = r; });
  let held;
  const heldP = new Promise((r) => { held = r; });
  const admin = withTransaction(async (cl) => {
    await cl.query('select id from creators where id = $1 for update', [String(c.creator.id)]);
    held();
    await gate;
    // ...and then wants the creator's files, as preserveCreatorMedia does.
    await locks.lockListingsWithFiles(cl, { creatorId: String(c.creator.id) });
    return 'admin-done';
  });
  await heldP;
  const checkout = orders.createOrdersFromCredits({
    buyerId: fan.id,
    items: [{ listingId: String(l.id), creatorId: String(c.creator.id), creatorUserId: c.user.id, priceCents: 500, kind: 'digital', title: 'Set' }],
    ageConfirmed: true,
    tosAccepted: true,
  }).then(() => 'checkout-done', (e) => e);
  await sleep(300);
  check('while checkout waits on the creator row, it holds no file lock', await fileLockFree(pathname));
  release();
  const [a, b] = await withTimeout(Promise.all([admin, checkout]), 8000).catch((e) => [e, e]);
  check('the admin side finishes (it is never the deadlock victim)', a === 'admin-done', a instanceof Error ? a.code || a.message : String(a));
  check('the checkout finishes too', b === 'checkout-done', b instanceof Error ? b.code || b.message : String(b));
}

// ---------------------------------------------------------------------------
section('money#1 + admin-ui#0: closing an order needs a seller who cannot ship it');
{
  await reset();
  const c = await mkCreatorUser();
  const fan = await mkFan();
  const mk = (creatorId) => query('insert into orders (data) values ($1) returning id', [{
    listingId: '1', title: 'Hoodie', creatorId: String(creatorId), buyerId: String(fan.id), kind: 'physical', status: 'pending_shipment',
    priceCents: 6000, shippingCents: 500, feeBps: 1500, creatorNetCents: 5525,
    shippingAddress: 'enc:placeholder', createdAt: new Date().toISOString(),
  }]).then((r) => String(r.rows[0].id));
  const live = await mk(c.creator.id);
  const refused = await call(orderCloseRoute, { admin: true, body: { orderId: live, reason: 'typo' } });
  check('an active seller: 409 ORDER_SELLER_ACTIVE', refused.statusCode === 409 && refused.body.code === 'ORDER_SELLER_ACTIVE'
    && refused.body.seller?.status === 'active', JSON.stringify(refused.body));
  const row = (await query('select data from orders where id = $1', [live])).rows[0].data;
  check('...and the order is untouched', row.status === 'pending_shipment' && !row.closeReason);
  const summary = await call(adminOrdersRoute, { method: 'GET', admin: true, query: { orderId: live } });
  const s0 = summary.body?.orders?.[0];
  check('admin summary shows seller, item and amount', summary.statusCode === 200 && s0?.title === 'Hoodie' && s0.priceCents === 6000
    && s0.seller?.name === c.creator.name && s0.seller?.unableToFulfil === false, JSON.stringify(summary.body));
  check('...and never an address', !JSON.stringify(summary.body).includes('enc:placeholder') && !('shippingAddress' in s0) && s0.hasAddress === true);
  check('the summary route needs the admin key', (await call(adminOrdersRoute, { method: 'GET', query: { orderId: live } })).statusCode === 401);
  check('...and a filter', (await call(adminOrdersRoute, { method: 'GET', admin: true, query: {} })).statusCode === 400);
  const forced = await call(orderCloseRoute, { admin: true, body: { orderId: live, reason: 'seller unreachable for 60 days', force: true } });
  check('force closes it, and says so', forced.statusCode === 200 && forced.body.forced === true, JSON.stringify(forced.body));
  check('...recorded on the order', (await query('select data from orders where id = $1', [live])).rows[0].data.closeForced === true);

  // Banned creator record.
  const banned = await mkCreatorUser();
  const o1 = await mk(banned.creator.id);
  await query(`update creators set data = data || '{"status":"banned"}'::jsonb where id = $1`, [String(banned.creator.id)]);
  const list = await call(adminOrdersRoute, { method: 'GET', admin: true, query: { creatorId: String(banned.creator.id), status: 'pending_shipment' } });
  check('a banned seller\'s unshipped orders are listed', list.statusCode === 200 && list.body.orders.length === 1
    && list.body.orders[0].id === o1 && list.body.orders[0].seller.unableToFulfil === true, JSON.stringify(list.body));
  const r1 = await call(orderCloseRoute, { admin: true, body: { orderId: o1, reason: 'seller banned' } });
  check('a banned seller: closes without force', r1.statusCode === 200 && r1.body.forced === false, JSON.stringify(r1.body));

  // Account-level ban on the login only.
  const acct = await mkCreatorUser();
  const o2 = await mk(acct.creator.id);
  await query(`update users set data = data || '{"moderationStatus":"banned"}'::jsonb where id = $1`, [String(acct.user.id)]);
  check('an account-banned login: closes', (await call(orderCloseRoute, { admin: true, body: { orderId: o2, reason: 'x' } })).statusCode === 200);

  // Deleted creator record.
  const o3 = await mk('999999');
  check('a deleted seller: closes', (await call(orderCloseRoute, { admin: true, body: { orderId: o3, reason: 'x' } })).statusCode === 200);

  // A creator with no login left.
  const orphan = await creators.createCreator({ name: 'Orphan', handle: '@r9borphan', status: 'active' });
  const o4 = await mk(orphan.id);
  check('a seller with no login: closes', (await call(orderCloseRoute, { admin: true, body: { orderId: o4, reason: 'x' } })).statusCode === 200);

  check('a non-boolean force is refused', (await call(orderCloseRoute, { admin: true, body: { orderId: live, reason: 'x', force: 'yes' } })).statusCode === 400);
}

// ---------------------------------------------------------------------------
section('dashboard#0 / public-pages#0 / legal-journeys#0: the close note stays internal');
{
  await reset();
  const c = await mkCreatorUser();
  const fan = await mkFan();
  const { rows } = await query('insert into orders (data) values ($1) returning id', [{
    listingId: '1', title: 'Tee', creatorId: String(c.creator.id), buyerId: String(fan.id), kind: 'physical', status: 'pending_shipment',
    priceCents: 3000, shippingCents: 500, feeBps: 0, creatorNetCents: 3500, shippingAddress: null, createdAt: new Date().toISOString(),
  }]);
  const id = String(rows[0].id);
  await query(`update creators set data = data || '{"status":"banned"}'::jsonb where id = $1`, [String(c.creator.id)]);
  await orders.closeUnfulfilledOrder(id, { reason: 'Seller banned - NCII takedown #14, possible minor' });
  const mine = await call(mineRoute, { method: 'GET', user: fan });
  const bo = mine.body?.orders?.find((o) => String(o.id) === id);
  check('the buyer sees the order as closed', mine.statusCode === 200 && bo?.status === 'closed_unfulfilled' && !!bo.closedAt, JSON.stringify(mine.body));
  const leak = JSON.stringify(mine.body);
  check('...but never the reason or who closed it', !leak.includes('NCII') && !('closeReason' in bo) && !('closedBy' in bo), leak);
  check('...nor the seller\'s receipt or ids', !('feeBps' in bo) && !('creatorNetCents' in bo) && !('creatorId' in bo) && !('buyerId' in bo), JSON.stringify(bo));
  const direct = await orders.getOrdersForCreator(c.creator.id);
  check('the seller\'s order view drops the note too', direct.length === 1 && !('closeReason' in direct[0]) && !('closedBy' in direct[0])
    && direct[0].status === 'closed_unfulfilled', JSON.stringify(direct));
  // The checkout response goes through the same allowlist.
  const placed = orders.toBuyerOrder({ id: '9', listingId: '1', title: 'Tee', creatorId: '5', buyerId: '6', feeBps: 0,
    creatorNetCents: 3500, priceCents: 3000, status: 'fulfilled', shippingAddress: 'enc' }, { withAddress: false });
  check('the checkout projection drops the seller receipt, ids and address', placed.id === '9' && placed.status === 'fulfilled'
    && !('feeBps' in placed) && !('creatorNetCents' in placed) && !('creatorId' in placed) && !('buyerId' in placed)
    && !('shippingAddress' in placed), JSON.stringify(placed));
  const createSrc = (await import('fs')).readFileSync(new URL('../pages/api/marketplace/orders/create.js', import.meta.url), 'utf8');
  check('the checkout route maps its orders through toBuyerOrder', /orders\.map\(\(o\) => toBuyerOrder\(o, \{ withAddress: false \}\)\)/.test(createSrc));
  const adminView = await orders.getOrderSummariesForAdmin({ orderId: id });
  check('the admin still sees it', adminView[0]?.closeReason?.startsWith('Seller banned'));
}

// ---------------------------------------------------------------------------
section('money#2: an already-credited hash is answered as such');
{
  await reset();
  const fan = await mkFan();
  const tx = '0x' + 'c'.repeat(64);
  await deposit.recordDepositCredit({ userId: fan.id, txHash: tx, grossCents: 5000, feeCents: 100, netCents: 4900 });
  // No wallet proof at all (a phone with no wallet), active account.
  const again = await call(buyRoute, { user: fan, body: { txHash: tx } });
  check('an active account retrying a credited hash with no proof: 200 alreadyCredited', again.statusCode === 200
    && again.body.alreadyCredited === true && again.body.creditedCents === 4900 && again.body.frozen === undefined, JSON.stringify(again.body));
  const unknown = await call(buyRoute, { user: fan, body: { txHash: '0x' + 'd'.repeat(64) } });
  check('an unknown hash still needs the wallet proof', unknown.statusCode === 400 && unknown.body.code === 'PROOF_REQUIRED', JSON.stringify(unknown.body));
  const other = await mkFan();
  const notTheirs = await call(buyRoute, { user: other, body: { txHash: tx } });
  check('someone else\'s credited hash is not reported as theirs', notTheirs.statusCode === 400 && notTheirs.body.code === 'PROOF_REQUIRED', JSON.stringify(notTheirs.body));
  const manual = await call(manualCreditRoute, { admin: true, body: {
    userId: fan.id, txHash: tx, fromAddress: '0x' + '1'.repeat(40), expectedLogin: fan.email,
  } });
  check('manual-credit of a credited hash says nothing new was added', manual.statusCode === 200 && manual.body.alreadyCredited === true
    && /nothing new was added/.test(manual.body.message || ''), JSON.stringify(manual.body));
  const bal = (await query('select balance_cents from credit_balances where user_id = $1', [String(fan.id)])).rows[0].balance_cents;
  check('...and the balance did not move', Number(bal) === 4900, String(bal));
}

// ---------------------------------------------------------------------------
section('social#0 / dashboard#1: a block-only inbox row names nobody');
{
  await reset();
  const a = await mkCreatorUser();
  const b = await mkCreatorUser();
  const commenter = await mkFan();
  const pa = await wall.addWallPost({ creatorId: a.creator.id, authorId: commenter.id, authorName: 'Someone', text: 'hi' });
  const pb = await wall.addWallPost({ creatorId: b.creator.id, authorId: commenter.id, authorName: 'Someone', text: 'hey' });
  const noop = await call(wallBlockRoute, { user: a.user, body: { postId: String(pa.id), blocked: false } });
  check('unblocking a commenter never blocked returns no comment ids', noop.statusCode === 200 && Array.isArray(noop.body.postIds)
    && noop.body.postIds.length === 0, JSON.stringify(noop.body));
  const ba = await call(wallBlockRoute, { user: a.user, body: { postId: String(pa.id) } });
  check('a real block returns the author\'s comment ids', ba.statusCode === 200 && ba.body.postIds.includes(String(pa.id)), JSON.stringify(ba.body));
  const again = await call(wallBlockRoute, { user: a.user, body: { postId: String(pa.id) } });
  check('blocking again (no change) returns none', again.body.postIds?.length === 0, JSON.stringify(again.body));
  await call(wallBlockRoute, { user: b.user, body: { postId: String(pb.id) } });
  const ia = await call(conversationsRoute, { method: 'GET', user: a.user });
  const ib = await call(conversationsRoute, { method: 'GET', user: b.user });
  const ra = ia.body?.conversations?.[0];
  const rb = ib.body?.conversations?.[0];
  const text = JSON.stringify([ia.body, ib.body]);
  check('the blocker sees the row', ia.statusCode === 200 && ra?.blockOnly === true && ra.blockedByMe === true, JSON.stringify(ia.body));
  check('...with no account id or "Fan #" label anywhere', !text.includes(String(commenter.id)) && !/Fan #/.test(text)
    && ra.other.userId === null && ra.other.name === 'A blocked account', text);
  check('...and unrelated handles for two creators', ra.blockHandle && rb?.blockHandle && ra.blockHandle !== rb.blockHandle);
  // The pagination cursor used to be plain base64 JSON of [time, pairId],
  // and the pair id is '<uidA>__<uidB>'. Round 10 (social#0) moved wall
  // blocks out of the paged conversation rows (they are appended to the first
  // page only), so the paged row here is a DM block by id.
  const x = await mkFan();
  await messages.setConversationBlocked(a.user.id, x.id, true);
  const page = await call(conversationsRoute, { method: 'GET', user: a.user, query: { limit: '1' } });
  const cur = page.body?.nextBefore;
  const decoded = cur ? Buffer.from(cur, 'base64url').toString('latin1') : '';
  check('the limit=1 cursor exists and does not carry the counterpart\'s id', !!cur && !decoded.includes(String(x.id))
    && !cur.includes(String(x.id)), decoded);
  const next = await call(conversationsRoute, { method: 'GET', user: a.user, query: { limit: '1', before: cur } });
  check('...and still pages (nothing after the only row, no wall rows repeated)', next.statusCode === 200 && next.body.conversations.length === 0, JSON.stringify(next.body));
  const forged = Buffer.from(JSON.stringify(['2999-01-01T00:00:00.000000Z', 'zzz'])).toString('base64url');
  const f = await call(conversationsRoute, { method: 'GET', user: a.user, query: { limit: '1', before: forged } });
  check('an old-style plain cursor reads as the first page', f.statusCode === 200 && f.body.conversations.filter((r) => !r.wallBlock).length === 1, JSON.stringify(f.body));
  await messages.setConversationBlocked(a.user.id, x.id, false);
  const bad = await call(dmBlockRoute, { user: b.user, body: { blockHandle: ra.blockHandle, blocked: false } });
  check('another creator cannot use that handle', bad.statusCode === 404, JSON.stringify(bad.body));
  const un = await call(dmBlockRoute, { user: a.user, body: { blockHandle: ra.blockHandle, blocked: false } });
  check('the blocker unblocks by handle', un.statusCode === 200 && un.body.ok === true, JSON.stringify(un.body));
  check('...and the block is gone', (await messages.isWallBlocked(a.user.id, commenter.id)) === false
    && (await messages.blockBetween(a.user.id, commenter.id)) === null);
  const after = await call(conversationsRoute, { method: 'GET', user: a.user });
  check('...and the row drops out of the inbox', after.body.conversations.length === 0, JSON.stringify(after.body));
  check('a handle cannot re-block', (await call(dmBlockRoute, { user: a.user, body: { blockHandle: ra.blockHandle, blocked: true } })).statusCode === 400);
}

// ---------------------------------------------------------------------------
section('admin-ui#1: a creator\'s listings for a standalone takedown');
{
  await reset();
  const c = await mkCreatorUser();
  const l = await mkListing(c.creator.id, { title: 'Findable' });
  const res = await call(contentLookupRoute, { method: 'GET', admin: true, query: { kind: 'listings', creatorId: String(c.creator.id) } });
  check('lists the creator\'s listings', res.statusCode === 200 && res.body.listings.length === 1 && res.body.listings[0].id === String(l.id)
    && res.body.listings[0].title === 'Findable' && res.body.listings[0].mediaCount === 1, JSON.stringify(res.body));
  check('...never a media src', !JSON.stringify(res.body).includes('/api/media/'));
  check('...admin key required', (await call(contentLookupRoute, { method: 'GET', query: { kind: 'listings', creatorId: String(c.creator.id) } })).statusCode === 401);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
