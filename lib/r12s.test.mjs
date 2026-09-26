// Regression tests for the round-12 site side of srv-auth-core#2 (package
// R12S), run against a real scratch Postgres, never mocks: a reinstatement
// server/ refuses because a server/ ADMIN applied the ban (409
// ban_needs_server_admin) is kept in the standing outbox, flagged, instead of
// being deleted as delivered; a plain 2xx is still delivered; any other
// failure keeps its ordinary backoff.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r12s.test.mjs

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.BRIDGE_SECRET = 'test-bridge-secret-r12s';

const { query, closePool } = await import('./db.js');
const outbox = await import('./standing-outbox.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
const orig = console.error;
const quiet = async (fn) => { console.error = () => {}; try { return await fn(); } finally { console.error = orig; } };
const row = async (uid) => (await query('select * from server_standing_pushes where uid = $1', [uid])).rows[0];
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

console.log('\nsrv-auth-core#2: a reinstatement blocked by a server/ admin ban stays queued, flagged');
{
  await query('delete from server_standing_pushes');
  const uid = `r12s-${Date.now()}`;
  await outbox.enqueueStandingPushes([{ uid, status: 'active', role: 'CREATOR' }]);
  const out = await quiet(() => outbox.deliverStandingPushes({
    uids: [uid],
    fetchImpl: async () => json(409, { ok: false, known: true, applied: 'ban_needs_server_admin', error: 'ban_needs_server_admin' }),
  }));
  const r = await row(uid);
  check('the row is kept (not reported delivered)', !!r && out.sent === 0, JSON.stringify(out));
  check('...flagged with the distinct reason', r && r.last_error === outbox.BAN_NEEDS_SERVER_ADMIN, r && r.last_error);
  check('...and counted in the summary', out.needsServerAdmin === 1, JSON.stringify(out));
  const waitMs = r ? new Date(r.next_at).getTime() - Date.now() : 0;
  check('...retried at the slowest cadence (about 6h), not in a minute', waitMs > 5 * 60 * 60 * 1000, String(waitMs));
  const listed = (await outbox.listPendingStandingPushes()).find((p) => p.uid === uid);
  check('the admin list marks it needsServerAdmin', listed && listed.needsServerAdmin === true, JSON.stringify(listed));

  // Once a server/ admin lifts the ban the next retry lands (2xx) and clears it.
  const done = await quiet(() => outbox.deliverStandingPushes({ uids: [uid], fetchImpl: async () => json(200, { ok: true, known: true, applied: 'unchanged' }) }));
  check('a later 2xx delivers and deletes it', done.sent === 1 && !(await row(uid)), JSON.stringify(done));

  // A 409 for any other reason, and a 5xx, stay ordinary failures.
  const other = `${uid}-b`;
  await outbox.enqueueStandingPushes([{ uid: other, status: 'banned', role: 'CREATOR' }]);
  const o = await quiet(() => outbox.deliverStandingPushes({ uids: [other], fetchImpl: async () => json(409, { error: 'something_else' }) }));
  const ro = await row(other);
  check('an unrelated 409 is a plain http_409 failure', ro && ro.last_error === 'http_409' && !o.needsServerAdmin, JSON.stringify(ro));
  const listedO = (await outbox.listPendingStandingPushes()).find((p) => p.uid === other);
  check('...not marked needsServerAdmin', listedO && listedO.needsServerAdmin === false);
  const w = ro ? new Date(ro.next_at).getTime() - Date.now() : 0;
  check('...with the short first backoff', w > 0 && w < 5 * 60 * 1000, String(w));
  await query('delete from server_standing_pushes');
}

console.log('\nreview: a reinstatement blocked by a server/ admin SUSPENSION is flagged the same way');
{
  await query('delete from server_standing_pushes');
  const uid = `r12s-susp-${Date.now()}`;
  await outbox.enqueueStandingPushes([{ uid, status: 'active', role: 'CREATOR' }]);
  const out = await quiet(() => outbox.deliverStandingPushes({
    uids: [uid],
    fetchImpl: async () => json(409, { ok: false, known: true, applied: 'suspension_needs_server_admin', error: 'suspension_needs_server_admin' }),
  }));
  const r = await row(uid);
  check('the row is kept', !!r && out.sent === 0 && out.needsServerAdmin === 1, JSON.stringify(out));
  check('...flagged with the suspension reason', r && r.last_error === outbox.SUSPENSION_NEEDS_SERVER_ADMIN, r && r.last_error);
  const listed = (await outbox.listPendingStandingPushes()).find((p) => p.uid === uid);
  check('...and listed needsServerAdmin', listed && listed.needsServerAdmin === true, JSON.stringify(listed));
  await query('delete from server_standing_pushes');
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
