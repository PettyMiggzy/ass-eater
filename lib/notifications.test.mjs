// In-app notifications (sale / payout-paid), against a real Postgres.
//
// Run with:
//   DATABASE_URL=postgresql://...  node --import ./test-register.mjs lib/notifications.test.mjs
//
// createNotification() is deliberately best-effort -- a broken insert must
// never break the money-moving call site it's wired into (a sale, a paid
// payout). The main thing worth proving here isn't "does it save a row",
// it's that a failure inside it is swallowed rather than thrown, that
// notifications are scoped per user (no cross-user leak), and that
// markAllRead / getUnreadCount actually agree with each other.

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}

const { query, closePool, withTransaction } = await import('./db.js');
const store = await import('./notifications-store.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);

await query('truncate notifications restart identity');
// A notification is only recorded for an account that exists (round-15
// legal-journeys#2), so the fake recipients below get real users rows.
async function seedUsers(ids) {
  for (const id of ids) {
    await query(`insert into users (id, data) values ($1, $2) on conflict (id) do nothing`,
      [id, JSON.stringify({ email: `${id}@notifications.test`, role: 'fan' })]);
  }
}
await seedUsers(['user-a', 'user-b', 'user-c', 'user-d', 'user-e']);

section('recording a notification');

await store.createNotification({ userId: 'user-a', type: 'sale', message: 'You made a sale', meta: { listingId: '1' } });
const listA = await store.getNotificationsForUser('user-a');
check('the row is recorded', listA.length === 1, listA.length);
check('type is kept', listA[0].type === 'sale', listA[0].type);
check('message is kept', listA[0].message === 'You made a sale', listA[0].message);
check('meta is kept as an object', listA[0].meta.listingId === '1', JSON.stringify(listA[0].meta));
check('unread by default', listA[0].read_at === null);

section('per-user scoping -- one user never sees another\'s notifications');

await store.createNotification({ userId: 'user-b', type: 'payout_paid', message: 'Your cash-out was paid' });
const stillA = await store.getNotificationsForUser('user-a');
const listB = await store.getNotificationsForUser('user-b');
check('user-a still sees only their own row', stillA.length === 1, stillA.length);
check('user-b sees only their own row', listB.length === 1 && listB[0].type === 'payout_paid', listB.length);

section('unread count');

check('user-a has 1 unread', (await store.getUnreadCount('user-a')) === 1);
await store.createNotification({ userId: 'user-a', type: 'sale', message: 'Second sale' });
check('user-a now has 2 unread', (await store.getUnreadCount('user-a')) === 2);
check('user-b is unaffected by user-a\'s activity', (await store.getUnreadCount('user-b')) === 1);

section('markAllRead');

await store.markAllRead('user-a');
check('user-a\'s unread count drops to zero', (await store.getUnreadCount('user-a')) === 0);
const afterRead = await store.getNotificationsForUser('user-a');
check('every one of user-a\'s rows is now marked read', afterRead.every((n) => n.read_at !== null));
check('user-b\'s unread count is untouched by user-a\'s markAllRead', (await store.getUnreadCount('user-b')) === 1);

section('ordering and limit');

for (let i = 0; i < 5; i++) {
  await store.createNotification({ userId: 'user-c', type: 'sale', message: `sale ${i}` });
}
const ordered = await store.getNotificationsForUser('user-c');
check('newest first', ordered[0].message === 'sale 4' && ordered[4].message === 'sale 0', ordered.map((n) => n.message));
const limited = await store.getNotificationsForUser('user-c', 2);
check('limit is respected', limited.length === 2, limited.length);
check('limit still returns the newest ones', limited[0].message === 'sale 4' && limited[1].message === 'sale 3');

section('createNotification is best-effort -- a failure must never throw');

// An invalid type for a jsonb column (a circular structure can't be
// JSON.stringify'd) is exactly the kind of caller mistake this function has
// to survive without taking down whatever it's wired into (a sale, a paid
// payout). It must swallow the error, not propagate it.
const circular = {};
circular.self = circular;
let threw = false;
try {
  await store.createNotification({ userId: 'user-a', type: 'sale', message: 'boom', meta: circular });
} catch {
  threw = true;
}
check('a broken insert does not throw', !threw);

section('createNotification participates in a caller-supplied transaction');

// This mirrors how orders-store.js wires it into createOrdersFromCredits --
// inside the SAME transaction as the charge, so a rollback also removes
// the notification rather than leaving an orphaned "you made a sale" row
// for a sale that never actually happened.
let rolledBackBefore = await store.getUnreadCount('user-d');
try {
  await withTransaction(async (client) => {
    await store.createNotification({ userId: 'user-d', type: 'sale', message: 'about to roll back' }, client);
    throw new Error('simulated failure after the insert');
  });
} catch {
  // expected
}
check('a notification written inside a rolled-back transaction does not survive',
  (await store.getUnreadCount('user-d')) === rolledBackBefore, await store.getUnreadCount('user-d'));

await withTransaction(async (client) => {
  await store.createNotification({ userId: 'user-d', type: 'sale', message: 'committed' }, client);
});
check('a notification written inside a committed transaction does survive',
  (await store.getUnreadCount('user-d')) === 1);

section('a real Postgres-level failure inside the insert does not poison the shared transaction');

// A circular meta throws in JS, before any SQL is sent -- it never reaches
// Postgres. A NOT NULL violation on `message` is a genuine DB-level error,
// which is what actually poisons a transaction (every later statement on
// that connection fails with "current transaction is aborted") unless the
// insert runs inside its own SAVEPOINT. Without that savepoint, the second
// createNotification call below would itself throw the poisoned-transaction
// error, get silently swallowed by its own catch, and never insert its row --
// so this test fails against a version without the fix.
await withTransaction(async (client) => {
  await store.createNotification({ userId: 'user-e', type: 'sale', message: null }, client);
  await store.createNotification({ userId: 'user-e', type: 'sale', message: 'still works after the failure' }, client);
});
check('a later statement in the same transaction still succeeds after a bad insert',
  (await store.getUnreadCount('user-e')) === 1, await store.getUnreadCount('user-e'));
const survivor = (await store.getNotificationsForUser('user-e'))[0];
check('the surviving row is the second, valid one, not the failed one',
  survivor.message === 'still works after the failure', survivor?.message);

console.log(`\n${pass} passed, ${fail} failed`);
await closePool();
process.exit(fail ? 1 : 0);
