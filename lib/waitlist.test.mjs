// Pre-launch notify-me list, against a real Postgres.
//
// Run with:
//   DATABASE_URL=postgresql://...  node --import ./test-register.mjs lib/waitlist.test.mjs
//
// What actually matters here is not "does it save an email". It is that a
// person who signs up twice is one person, that signing up as a fan and
// later as a creator keeps BOTH signals rather than the newer one winning,
// and that a burst of signups for the same address cannot become several
// rows -- the read-then-check race this codebase has had to fix by hand in
// four other stores. The unique index is what prevents it; these tests are
// what prove the index and normalizeWaitlistEmail() still agree.

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}

const { query, closePool } = await import('./db.js');
const store = await import('./waitlist-store.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);

await query('truncate waitlist restart identity');

section('a signup');

const first = await store.addToWaitlist({
  email: '  Person@Example.COM ', role: 'fan', source: 'landing', state: 'TX', country: 'US',
});
check('email is trimmed and lowercased', first.email === 'person@example.com', first.email);
check('role is recorded', JSON.stringify(first.roles) === '["fan"]', JSON.stringify(first.roles));
check('state is recorded so a blocked state can be told when it opens', first.state === 'TX', first.state);

section('signing up again is not a second person');

const again = await store.addToWaitlist({ email: 'PERSON@example.com', role: 'fan', source: 'blocked-region' });
check('same row, whatever the casing', String(again.id) === String(first.id), `${again.id} vs ${first.id}`);
check('only one row exists', (await store.getWaitlist()).length === 1);
check('the first source wins, matching referral attribution', again.source === 'landing', again.source);

const both = await store.addToWaitlist({ email: 'person@example.com', role: 'creator', source: 'founding-creator' });
check('roles union rather than overwrite -- the creator signal is not lost',
  both.roles.includes('fan') && both.roles.includes('creator'), JSON.stringify(both.roles));

section('what is refused');

let threw = null;
try { await store.addToWaitlist({ email: 'not-an-email', role: 'fan' }); } catch (e) { threw = e.message; }
check('a malformed address is refused', !!threw, String(threw));

threw = null;
try { await store.addToWaitlist({ email: 'ok@example.com', role: 'admin' }); } catch (e) { threw = e.message; }
check('a role that is not fan or creator is refused', !!threw, String(threw));

section('counts');

await store.addToWaitlist({ email: 'creator@example.com', role: 'creator', source: 'founding-creator' });
const counts = await store.getWaitlistCounts();
check('total counts people, not signups', counts.total === 2, JSON.stringify(counts));
check('fans counted by role membership', counts.fans === 1, JSON.stringify(counts));
check('someone who is both counts in both', counts.creators === 2, JSON.stringify(counts));

section('concurrency');

// The shape that produced duplicate rows in every store that used
// "read, check, then insert". A link going round a group chat is exactly
// how twenty of these land at once.
await Promise.all(Array.from({ length: 20 }, (_, i) =>
  store.addToWaitlist({ email: 'race@example.com', role: i % 2 ? 'fan' : 'creator', source: 'landing' })));
const { rows } = await query("select count(*)::int c from waitlist where data->>'email' = 'race@example.com'");
check('20 simultaneous signups for one address make exactly one row', rows[0].c === 1, String(rows[0].c));
const raced = (await store.getWaitlist()).find((e) => e.email === 'race@example.com');
check('and no role is dropped in the race',
  raced.roles.includes('fan') && raced.roles.includes('creator'), JSON.stringify(raced.roles));

section('removal');

// "Take me off this list" has to actually work -- this is a marketing list
// of people with no account, and removal is the only control they have.
await store.removeFromWaitlist(first.id);
check('removal deletes the row',
  !(await store.getWaitlist()).some((e) => String(e.id) === String(first.id)));

console.log(`\n${pass} passed, ${fail} failed`);
await closePool();
process.exit(fail ? 1 : 0);
