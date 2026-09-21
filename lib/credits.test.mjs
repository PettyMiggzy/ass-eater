// End-to-end tests for the credits ledger, one-of-a-kind listing claiming,
// and checkout idempotency -- run against a real Postgres, not mocks.
//
// Run with:
//   DATABASE_URL=postgresql://... \
//   node --import ./test-register.mjs lib/credits.test.mjs
//
// Every test starts from a truncated database, so this must only ever be
// pointed at a scratch database. It refuses to run otherwise.

import { query, closePool, withTransaction } from './db.js';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database (…/onlyone_site).');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  PASS', name);
  } else {
    fail++;
    console.log('  FAIL', name, extra);
  }
};
const section = (s) => console.log('\n' + s);

async function reset() {
  await query(
    'truncate creators, users, listings, orders, credit_balances, credit_ledger, payout_requests, checkout_idempotency, used_payment_tx restart identity',
  );
}

const credits = await import('./credits-store.js');
const listingsStore = await import('./listings-store.js');
const ordersStore = await import('./orders-store.js');
const usersStore = await import('./users-store.js');
const creatorsStore = await import('./creators-store.js');

await reset();
await query('delete from app_meta');

section('used_payment_tx: same real hash cannot be claimed twice under different casing');
{
  // Regression test for a found-and-fixed bug: Ethereum tx hashes are
  // case-insensitive at the RPC/node level, but a plain Postgres `text`
  // primary key is not -- the same real deposit resubmitted with different
  // letter-casing of its own hash used to be treated as a brand new hash
  // and credited a second time. lib/deposit.js now lowercases every hash
  // before it reaches this table; this test exercises the belt-and-suspenders
  // DB-level index directly (used_payment_tx_lower_idx), independent of the
  // on-chain verification code (which needs a real RPC and is covered by
  // manual/integration testing, not this suite).
  const hashLower = '0x' + 'a1b2c3d4e5f60718293a4b5c6d7e8f90'.repeat(2);
  const hashUpper = '0x' + hashLower.slice(2).toUpperCase();

  await query('insert into used_payment_tx (tx_hash) values ($1)', [hashLower]);

  let rejected = false;
  try {
    await query('insert into used_payment_tx (tx_hash) values ($1)', [hashUpper]);
  } catch (err) {
    rejected = err.code === '23505';
  }
  check('re-inserting the same hash under different casing is rejected', rejected);
}

async function makeCreatorUser(name) {
  const creator = await creatorsStore.createCreator({ name, handle: `@${name}`, status: 'active', locked: false });
  const user = await usersStore.createUser({ email: `${name}@test.local`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}

section('credit_balances / credit_ledger');
{
  const { user: fan } = await makeCreatorUser('fan1'); // reuse helper, role irrelevant for balance ops
  check('starts at zero', (await credits.getBalanceCents(fan.id)) === 0);

  await credits.creditAccount({ userId: fan.id, cents: 1000, type: 'deposit', meta: { test: true } });
  check('credit applied', (await credits.getBalanceCents(fan.id)) === 1000);

  await credits.debitAccount({ userId: fan.id, cents: 300, type: 'test_charge' });
  check('debit applied', (await credits.getBalanceCents(fan.id)) === 700);

  let threw = false;
  try {
    await credits.debitAccount({ userId: fan.id, cents: 100000, type: 'test_charge' });
  } catch (err) {
    threw = err.code === credits.INSUFFICIENT_BALANCE;
  }
  check('overdraft refused', threw);
  check('balance unchanged after refused overdraft', (await credits.getBalanceCents(fan.id)) === 700);

  const ledger = await credits.getLedgerForUser(fan.id, 10);
  check('ledger recorded both entries', ledger.length === 2);
  check('ledger newest first', ledger[0].type === 'test_charge');

  // Concurrent overspend: two debits that individually fit the balance but
  // not both together must never both succeed.
  await credits.creditAccount({ userId: fan.id, cents: 300, type: 'deposit' }); // balance now 1000
  const results = await Promise.allSettled([
    credits.debitAccount({ userId: fan.id, cents: 600, type: 'race' }),
    credits.debitAccount({ userId: fan.id, cents: 600, type: 'race' }),
  ]);
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  check('only one of two racing overdrafts succeeds', succeeded === 1, `succeeded=${succeeded}`);
  check('balance never went negative', (await credits.getBalanceCents(fan.id)) >= 0);
}

section('transferWithFee');
{
  const { user: buyer } = await makeCreatorUser('buyer1');
  const { user: seller } = await makeCreatorUser('seller1');
  await credits.creditAccount({ userId: buyer.id, cents: 10000, type: 'deposit' });

  const { feeCents, netCents } = await credits.transferWithFee({
    fromUserId: buyer.id,
    toUserId: seller.id,
    cents: 1000,
    feeBps: 1500,
    type: 'marketplace',
  });
  check('fee computed correctly (15% of 1000)', feeCents === 150, feeCents);
  check('net computed correctly', netCents === 850, netCents);
  check('buyer debited full amount', (await credits.getBalanceCents(buyer.id)) === 9000);
  check('seller credited net only', (await credits.getBalanceCents(seller.id)) === 850);
}

section('claimUniqueListing');
{
  const { creator } = await makeCreatorUser('uniqueseller');
  const listing = await listingsStore.createListing(creator.id, { title: 'One of one', priceCents: 500, unlimited: false });

  const firstClaim = await withTransaction((client) => listingsStore.claimUniqueListing(listing.id, client));
  check('first claim succeeds', firstClaim === true);

  const secondClaim = await withTransaction((client) => listingsStore.claimUniqueListing(listing.id, client));
  check('second claim on the same listing fails', secondClaim === false);

  const rows = await query('select data->>\'status\' as status from listings where id = $1', [listing.id]);
  check('listing marked sold', rows.rows[0].status === 'sold');
}

section('createOrdersFromCredits: one-of-a-kind double-sale is blocked');
{
  const { creator: sellerCreator, user: seller } = await makeCreatorUser('uniqueseller2');
  const { user: buyerA } = await makeCreatorUser('uniquebuyerA');
  const { user: buyerB } = await makeCreatorUser('uniquebuyerB');
  const listing = await listingsStore.createListing(sellerCreator.id, { title: 'Rare item', priceCents: 1000, unlimited: false });

  await credits.creditAccount({ userId: buyerA.id, cents: 5000, type: 'deposit' });
  await credits.creditAccount({ userId: buyerB.id, cents: 5000, type: 'deposit' });

  const item = { listingId: listing.id, creatorId: sellerCreator.id, creatorUserId: seller.id, priceCents: 1000, kind: 'digital', unlimited: false, title: listing.title };

  const orderA = await ordersStore.createOrdersFromCredits({ buyerId: buyerA.id, items: [item], ageConfirmed: true, tosAccepted: true });
  check('first buyer succeeds', orderA.length === 1);

  let secondFailed = false;
  let secondCode = null;
  try {
    await ordersStore.createOrdersFromCredits({ buyerId: buyerB.id, items: [item], ageConfirmed: true, tosAccepted: true });
  } catch (err) {
    secondFailed = true;
    secondCode = err.code;
  }
  check('second buyer is rejected', secondFailed && secondCode === 'LISTING_UNAVAILABLE', secondCode);
  check('second buyer was never charged', (await credits.getBalanceCents(buyerB.id)) === 5000);
  check('first buyer really was charged (transaction not rolled back for the winner)', (await credits.getBalanceCents(buyerA.id)) === 4000);
}

section('createOrdersFromCredits: duplicate listing in one cart cannot double-claim itself');
{
  const { creator: sellerCreator, user: seller } = await makeCreatorUser('uniqueseller3');
  const { user: buyer } = await makeCreatorUser('selfduplicatebuyer');
  const listing = await listingsStore.createListing(sellerCreator.id, { title: 'Only one copy', priceCents: 500, unlimited: false });
  await credits.creditAccount({ userId: buyer.id, cents: 5000, type: 'deposit' });

  const item = { listingId: listing.id, creatorId: sellerCreator.id, creatorUserId: seller.id, priceCents: 500, kind: 'digital', unlimited: false, title: listing.title };

  let failed = false;
  try {
    await ordersStore.createOrdersFromCredits({ buyerId: buyer.id, items: [item, item], ageConfirmed: true, tosAccepted: true });
  } catch (err) {
    failed = true;
  }
  check('cart with the same unique listing twice is rejected', failed);
  check('nothing charged -- whole cart rolled back', (await credits.getBalanceCents(buyer.id)) === 5000);
}

section('createOrdersFromCredits: unlimited listings are never claimed/blocked');
{
  const { creator: sellerCreator, user: seller } = await makeCreatorUser('unlimitedseller');
  const { user: buyerA } = await makeCreatorUser('unlimitedbuyerA');
  const { user: buyerB } = await makeCreatorUser('unlimitedbuyerB');
  const listing = await listingsStore.createListing(sellerCreator.id, { title: 'Print', priceCents: 200, unlimited: true });
  await credits.creditAccount({ userId: buyerA.id, cents: 5000, type: 'deposit' });
  await credits.creditAccount({ userId: buyerB.id, cents: 5000, type: 'deposit' });

  const item = { listingId: listing.id, creatorId: sellerCreator.id, creatorUserId: seller.id, priceCents: 200, kind: 'digital', unlimited: true, title: listing.title };
  const a = await ordersStore.createOrdersFromCredits({ buyerId: buyerA.id, items: [item], ageConfirmed: true, tosAccepted: true });
  const b = await ordersStore.createOrdersFromCredits({ buyerId: buyerB.id, items: [item], ageConfirmed: true, tosAccepted: true });
  check('both buyers can buy the same unlimited listing', a.length === 1 && b.length === 1);
}

section('createOrdersFromCredits: checkout idempotency blocks a retried submission');
{
  const { creator: sellerCreator, user: seller } = await makeCreatorUser('idemseller');
  const { user: buyer } = await makeCreatorUser('idembuyer');
  const listing = await listingsStore.createListing(sellerCreator.id, { title: 'Repeatable item', priceCents: 500, unlimited: true });
  await credits.creditAccount({ userId: buyer.id, cents: 5000, type: 'deposit' });

  const item = { listingId: listing.id, creatorId: sellerCreator.id, creatorUserId: seller.id, priceCents: 500, kind: 'digital', unlimited: true, title: listing.title };
  const key = 'idem-key-fixed-1';

  const first = await ordersStore.createOrdersFromCredits({ buyerId: buyer.id, items: [item], ageConfirmed: true, tosAccepted: true, idempotencyKey: key });
  check('first submission succeeds', first.length === 1);
  check('charged once', (await credits.getBalanceCents(buyer.id)) === 4500);

  let retryFailed = false;
  let retryCode = null;
  try {
    await ordersStore.createOrdersFromCredits({ buyerId: buyer.id, items: [item], ageConfirmed: true, tosAccepted: true, idempotencyKey: key });
  } catch (err) {
    retryFailed = true;
    retryCode = err.code;
  }
  check('retry with the same key is rejected', retryFailed && retryCode === 'DUPLICATE_CHECKOUT', retryCode);
  check('retry did not charge again', (await credits.getBalanceCents(buyer.id)) === 4500);

  // A genuinely new checkout (fresh key) must still work.
  const second = await ordersStore.createOrdersFromCredits({ buyerId: buyer.id, items: [item], ageConfirmed: true, tosAccepted: true, idempotencyKey: 'idem-key-fixed-2' });
  check('a fresh key is not blocked by an earlier one', second.length === 1);
  check('second real purchase charged', (await credits.getBalanceCents(buyer.id)) === 4000);
}

section('requestPayout / markPayoutPaid');
{
  const { user: creatorUser } = await makeCreatorUser('payoutcreator');
  await credits.creditAccount({ userId: creatorUser.id, cents: 2000, type: 'deposit' });

  const req = await credits.requestPayout({ userId: creatorUser.id, cents: 1500, payoutWallet: '0x' + '1'.repeat(40) });
  check('balance debited immediately on request', (await credits.getBalanceCents(creatorUser.id)) === 500);
  check('request starts pending', req.status === 'pending');

  let doublePayoutFailed = false;
  try {
    await credits.requestPayout({ userId: creatorUser.id, cents: 1000, payoutWallet: '0x' + '1'.repeat(40) });
  } catch (err) {
    doublePayoutFailed = err.code === credits.INSUFFICIENT_BALANCE;
  }
  check('cannot request more than the (already-reduced) balance', doublePayoutFailed);

  const fakeHash = '0x' + 'a'.repeat(64);
  const paid = await credits.markPayoutPaid(req.id, fakeHash);
  check('marked paid', paid.status === 'paid' && paid.tx_hash === fakeHash);

  let doubleMarkFailed = false;
  try {
    await credits.markPayoutPaid(req.id, fakeHash);
  } catch {
    doubleMarkFailed = true;
  }
  check('cannot mark the same request paid twice', doubleMarkFailed);

  const pending = await credits.getPendingPayoutRequests();
  check('paid request no longer in the pending queue', !pending.some((r) => r.id === req.id));
  const paidHistory = await credits.getRecentPaidPayoutRequests(10);
  check('paid request appears in paid history', paidHistory.some((r) => r.id === req.id));
  const own = await credits.getPayoutRequestsForUser(creatorUser.id, 10);
  check('creator sees their own request in either state', own.some((r) => r.id === req.id));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
