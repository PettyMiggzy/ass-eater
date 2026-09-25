// Regression tests for the round-5 public/dashboard package (R5U1), run
// against a real scratch Postgres (it truncates tables), never mocks:
//  - money#1 / public-pages#0: a checkout idempotency key is scoped to the
//    buyer. A key another account already committed never comes back as this
//    buyer's DUPLICATE_CHECKOUT (their cart used to be cleared and reported
//    "already paid" with nothing bought), and a table created with the old
//    single-column key is migrated in place;
//  - money#0: GET /api/marketplace/orders/checkout-status answers whether
//    THIS buyer committed a key, so a lost-response checkout can be confirmed
//    without pressing Pay (which a spent balance may block);
//  - dashboard#1: a self-deletion's forfeit acknowledgement is bound to the
//    amounts it was shown; a deposit landing in between refuses the deletion
//    (409 BALANCE_FORFEIT changed:true) instead of forfeiting it unseen;
//  - public-pages#2: an admin-marked demo creator (demo, not seed) and a demo
//    listing are labelled AI-generated whatever the stored rows say.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r5u1.test.mjs

import fs from 'fs';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.BRIDGE_SECRET = 'test-bridge-secret-r5u1';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';

const { query, closePool } = await import('./db.js');
const creatorsStore = await import('./creators-store.js');
const users = await import('./users-store.js');
const listingsStore = await import('./listings-store.js');
const orders = await import('./orders-store.js');
const credits = await import('./credits-store.js');
const status = await import('./creator-status.js');
const { createSessionToken } = await import('./session.js');
const { default: checkoutStatusRoute } = await import('../pages/api/marketplace/orders/checkout-status.js');
const { default: deleteAccountRoute } = await import('../pages/api/auth/delete-account.js');

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
    end(b) { this.headersSent = true; if (b) { try { this.body = JSON.parse(b); } catch { this.body = b; } } },
    destroy() {}, on() {}, once() {}, emit() {}, write() { return true; },
  };
}
let ipN = 0;
async function call(route, { method = 'POST', body, query: q = {}, user = null } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = { 'x-forwarded-for': `10.57.${Math.floor(ipN / 250)}.${ipN % 250}` };
  if (user) headers.cookie = `oa_session=${createSessionToken(user.id, user.sessionVersion || 0)}`;
  await quiet(() => route({ method, body, query: q, headers, socket: { remoteAddress: headers['x-forwarded-for'] } }, res));
  return res;
}
async function reset() {
  await query(`truncate creators, users, listings, orders, credit_balances, credit_ledger, payout_requests, checkout_idempotency,
    used_payment_tx, conversations, reports, wall_posts, favorites, notifications restart identity`);
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
async function mkListing(creatorId, fields) {
  const listing = await listingsStore.createListing(creatorId, fields);
  return listingsStore.addListingMedia(listing.id, { type: 'image', src: `/api/media/listings/${creatorId}/${listing.id}/00000000-0000-4000-8000-000000000000.jpg` });
}
let n = 0;
async function mkCreatorUser() {
  n++;
  const creator = await creatorsStore.createCreator({ name: `seller${n}`, handle: `@seller${n}`, status: 'active', locked: false });
  const user = await users.createUser({ email: `seller${n}@r5u1.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r5u1.test`, password: 'password123', role: 'fan' });
}
const buy = (buyerId, item, idempotencyKey) =>
  orders.createOrdersFromCredits({ buyerId, items: [item], ageConfirmed: true, tosAccepted: true, idempotencyKey });

// ---------------------------------------------------------------------------
await reset();

section('money#1 / public-pages#0: the idempotency key is scoped to the buyer');
{
  const { creator, user: seller } = await mkCreatorUser();
  const a = await mkFan();
  const b = await mkFan();
  await credits.creditAccount({ userId: a.id, cents: 5000, type: 'deposit' });
  await credits.creditAccount({ userId: b.id, cents: 5000, type: 'deposit' });
  const l1 = await mkListing(creator.id, { title: 'One', priceCents: 500, unlimited: true });
  const l2 = await mkListing(creator.id, { title: 'Two', priceCents: 700, unlimited: true });
  const item = (l, price) => ({ listingId: l.id, creatorId: creator.id, creatorUserId: seller.id, priceCents: price, kind: 'digital', unlimited: true, title: l.title });

  const key = 'shared-browser-key-1';
  const first = await buy(a.id, item(l1, 500), key);
  check("A's checkout commits", first.length === 1);

  let errB = null;
  let outB = null;
  try { outB = await buy(b.id, item(l2, 700), key); } catch (e) { errB = e; }
  check("B sending A's key is NOT told 'already paid' -- B's own order is placed", !errB && outB?.length === 1, errB?.code);
  check('...and B was charged for it', (await credits.getBalanceCents(b.id)) === 4300);

  let errA = null;
  try { await buy(a.id, item(l2, 700), key); } catch (e) { errA = e; }
  check("A retrying A's own key is still DUPLICATE_CHECKOUT", errA?.code === 'DUPLICATE_CHECKOUT', errA?.code);
  check('...and A was not charged again', (await credits.getBalanceCents(a.id)) === 4500);

  check('isCheckoutKeyClaimed: A yes', await orders.isCheckoutKeyClaimed(key, a.id));
  check('isCheckoutKeyClaimed: B yes (its own claim)', await orders.isCheckoutKeyClaimed(key, b.id));
  check('isCheckoutKeyClaimed: a third account no', !(await orders.isCheckoutKeyClaimed(key, 'nobody')));

  const { rows: pk } = await query(
    `select array_length(conkey, 1) as n from pg_constraint where conrelid = 'checkout_idempotency'::regclass and contype = 'p'`,
  );
  check('the primary key is composite', pk[0]?.n === 2, JSON.stringify(pk));
}

section('the migration from the old single-column key runs in place and is re-runnable');
{
  const src = fs.readFileSync(new URL('./db.js', import.meta.url), 'utf8');
  const m = src.match(/do \$\$\ndeclare\n {2}pk_name text;[\s\S]*?end \$\$;/);
  check('found the migration block in lib/db.js', !!m);
  await query('drop table checkout_idempotency');
  await query(`create table checkout_idempotency (idempotency_key text primary key, buyer_id text not null, created_at timestamptz not null default now())`);
  await query(`insert into checkout_idempotency (idempotency_key, buyer_id) values ('old-k', 'u1')`);
  await query(m[0]);
  await query(m[0]); // no-op the second time
  const { rows: pk } = await query(
    `select array_length(conkey, 1) as n from pg_constraint where conrelid = 'checkout_idempotency'::regclass and contype = 'p'`,
  );
  check('migrated to a composite key', pk[0]?.n === 2);
  check('existing claims survive', await orders.isCheckoutKeyClaimed('old-k', 'u1'));
  await query(`insert into checkout_idempotency (idempotency_key, buyer_id) values ('old-k', 'u2')`);
  let dup = null;
  try { await query(`insert into checkout_idempotency (idempotency_key, buyer_id) values ('old-k', 'u1')`); } catch (e) { dup = e.code; }
  check('the same buyer still cannot claim a key twice', dup === '23505', dup);
}

section('money#0: checkout-status reports only the caller\'s own claims');
{
  await reset();
  const a = await mkFan();
  const b = await mkFan();
  await query(`insert into checkout_idempotency (idempotency_key, buyer_id) values ('k-status', $1)`, [String(a.id)]);
  const anon = await call(checkoutStatusRoute, { method: 'GET', query: { key: 'k-status' } });
  check('signed out -> 401', anon.statusCode === 401);
  const mine = await call(checkoutStatusRoute, { method: 'GET', query: { key: 'k-status' }, user: a });
  check('own committed key -> claimed', mine.statusCode === 200 && mine.body.claimed === true, JSON.stringify(mine.body));
  check('...not cached', mine.headers['cache-control'] === 'no-store');
  const theirs = await call(checkoutStatusRoute, { method: 'GET', query: { key: 'k-status' }, user: b });
  check("another account's key -> not claimed", theirs.statusCode === 200 && theirs.body.claimed === false);
  const bad = await call(checkoutStatusRoute, { method: 'GET', query: { key: ['x', 'y'] }, user: a });
  check('a non-string key -> 400', bad.statusCode === 400);
  const post = await call(checkoutStatusRoute, { method: 'POST', query: { key: 'k-status' }, user: a });
  check('GET only', post.statusCode === 405);
}

section('dashboard#1: the forfeit acknowledgement is bound to the amount shown');
{
  await reset();
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'deposit' });
  const ask = await call(deleteAccountRoute, { user: fan, body: { password: 'password123' } });
  check('asks to confirm 5000', ask.statusCode === 409 && ask.body.code === 'BALANCE_FORFEIT' && ask.body.balanceCents === 5000);

  // A $100 deposit lands in another tab before the confirmation.
  await credits.creditAccount({ userId: fan.id, cents: 10000, type: 'deposit' });
  const stale = await call(deleteAccountRoute, {
    user: fan,
    body: { password: 'password123', acknowledgeForfeit: true, expectedForfeitCents: 5000, expectedDigitalPurchases: 0 },
  });
  check('a confirmation for 5000 does not forfeit 15000', stale.statusCode === 409 && stale.body.code === 'BALANCE_FORFEIT' && stale.body.changed === true && stale.body.balanceCents === 15000, JSON.stringify(stale.body));
  check('...nothing was deleted', !!(await users.findUserById(fan.id)) && (await credits.getBalanceCents(fan.id)) === 15000);

  const bare = await call(deleteAccountRoute, { user: fan, body: { password: 'password123', acknowledgeForfeit: true } });
  check('an acknowledgement with no amount is not accepted', bare.statusCode === 409 && bare.body.code === 'BALANCE_FORFEIT' && !!(await users.findUserById(fan.id)));

  let threw = null;
  try { await users.deleteFanAccount(fan.id, { selfService: true, expectedForfeit: { balanceCents: 5000, digitalPurchases: 0 } }); } catch (e) { threw = e; }
  check('enforced inside the store transaction too', threw?.code === users.BALANCE_FORFEIT && threw.forfeit?.balanceCents === 15000, String(threw?.code));

  const ok = await call(deleteAccountRoute, {
    user: fan,
    body: { password: 'password123', acknowledgeForfeit: true, expectedForfeitCents: 15000, expectedDigitalPurchases: 0 },
  });
  check('confirmed for the current amount, the account is deleted', ok.statusCode === 200 && ok.body.forfeitedCents === 15000 && !(await users.findUserById(fan.id)), JSON.stringify(ok.body));

  // Nothing to forfeit when asked -> deletes straight away; but a deposit
  // racing that request must still not be swallowed.
  const empty = await mkFan();
  let raced = null;
  try { await users.deleteFanAccount(empty.id, { selfService: true, expectedForfeit: { balanceCents: 0, digitalPurchases: 0 } }); } catch (e) { raced = e; }
  check('nothing to lose: deleted', !raced && !(await users.findUserById(empty.id)));
  const late = await mkFan();
  await credits.creditAccount({ userId: late.id, cents: 250, type: 'deposit' });
  let lateErr = null;
  try { await users.deleteFanAccount(late.id, { selfService: true, expectedForfeit: { balanceCents: 0, digitalPurchases: 0 } }); } catch (e) { lateErr = e; }
  check('a balance that appeared after a zero check refuses the deletion', lateErr?.code === users.BALANCE_FORFEIT && !!(await users.findUserById(late.id)));
}

section('public-pages#2: admin-marked demo creators and demo listings are labelled AI');
{
  const demoCreator = { id: '4', name: 'Diesel Cole', demo: true, status: 'active', gallery: [{ type: 'image', src: '/api/media/gallery/4/a.jpg', aiGenerated: false }] };
  const pub = status.toPublicCreator(demoCreator);
  check('demo (not seed) creator gallery forced AI', pub.gallery[0].aiGenerated === true);
  const real = status.toPublicCreator({ ...demoCreator, demo: false });
  check('a real creator keeps the stored flag', real.gallery[0].aiGenerated === false);
  const listing = { id: '9', creatorId: '4', title: 'x', media: [{ type: 'image', src: '/api/media/listings/4/9/a.jpg', aiGenerated: false }] };
  const viaCreator = status.toPublicListing(listing, demoCreator);
  check("a demo creator's listing is labelled AI", viaCreator.aiGenerated === true && viaCreator.media[0].aiGenerated === true);
  const viaFlag = status.toPublicListing({ ...listing, demo: true });
  check('a listing marked demo is labelled AI', viaFlag.aiGenerated === true && viaFlag.media[0].aiGenerated === true);
  const plain = status.toPublicListing(listing, { ...demoCreator, demo: false });
  check('a real listing keeps the stored flag', !plain.aiGenerated && plain.media[0].aiGenerated === false);
}

section('money#0: the cart\'s uncertain-attempt grace window outlasts any checkout request');
{
  // cart.js reports an unclaimed key older than UNCERTAIN_GRACE_MS as "did
  // not go through"; that is only true while no checkout request can still be
  // running by then, i.e. while create.js's maxDuration stays well below it.
  const createSrc = fs.readFileSync(new URL('../pages/api/marketplace/orders/create.js', import.meta.url), 'utf8');
  const cartSrc = fs.readFileSync(new URL('../pages/cart.js', import.meta.url), 'utf8');
  const md = createSrc.match(/export const config = \{\s*maxDuration:\s*(\d+)\s*\}/);
  const grace = cartSrc.match(/const UNCERTAIN_GRACE_MS = ([\d\s*]+);/);
  check('checkout route pins a maxDuration', !!md);
  const graceMs = grace ? grace[1].split('*').reduce((a, b) => a * Number(b.trim()), 1) : 0;
  check('grace window is at least twice the checkout maxDuration', !!md && graceMs >= 2 * Number(md[1]) * 1000);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
