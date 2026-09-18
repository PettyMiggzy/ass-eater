// Proves that logging out actually retires a session token, and that doing
// so does not sign out everybody who was already logged in.
//
// Run with:
//   DATABASE_URL=postgresql://…/onlyass_site \
//   node --import ./test-register.mjs lib/session.test.mjs
//
// Background: revocation was first built and wired into exactly one endpoint
// that nothing on the site called, so logging out revoked nothing anywhere
// while appearing to work. Test 2 is the regression test for that. Test 4
// matters just as much in the other direction -- an earlier version of this
// check would have invalidated every existing session on deploy.
import { query, closePool } from './db.js';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyass_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database (…/onlyass_site).');
  process.exit(2);
}
await query('delete from users');

process.env.SESSION_SECRET = 'test-secret-for-logout-verification';
const session = await import('./session.js');
const users = await import('./users-store.js');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x)); };
const fakeReq = (token) => ({ headers: { cookie: `oa_session=${token}` } });

console.log('\n1. A live session authorises');
const u = await users.createUser({ email: 'victim@test.com', password: 'pw123456', role: 'fan' });
const token = session.createSessionToken(u.id, 0);
check('verified id matches', (await session.getVerifiedSessionUserId(fakeReq(token))) === u.id);
check('getSessionUser returns the record', (await session.getSessionUser(fakeReq(token)))?.id === u.id);

console.log('\n2. THE FIX: after logout, that same copied token stops working');
await users.bumpSessionVersion(u.id);
const afterLogout = await session.getVerifiedSessionUserId(fakeReq(token));
check('verified id is now null', afterLogout === null, String(afterLogout));
check('getSessionUser is now null', (await session.getSessionUser(fakeReq(token))) === null);

console.log('\n3. A fresh login after logging out works again');
const fresh = await users.findUserById(u.id);
const token2 = session.createSessionToken(u.id, fresh.sessionVersion);
check('new token authorises', (await session.getVerifiedSessionUserId(fakeReq(token2))) === u.id);
check('the OLD token is still dead', (await session.getVerifiedSessionUserId(fakeReq(token))) === null);

console.log('\n4. Existing users are NOT signed out by this deploy (backward compatibility)');
// A record created before session versioning existed: no sessionVersion field.
await query(`insert into users (id, data) values ('legacy-1', '{"email":"old@test.com","role":"fan"}'::jsonb)`);
const legacyToken = session.createSessionToken('legacy-1', 0);
check('a pre-existing session still works', (await session.getVerifiedSessionUserId(fakeReq(legacyToken))) === 'legacy-1');

console.log('\n5. The stateless shortcut is gone for good');
check('getSessionUserId no longer exported', session.getSessionUserId === undefined);

console.log('\n6. Forged / foreign tokens still rejected');
check('garbage rejected', (await session.getVerifiedSessionUserId(fakeReq('not.a.token'))) === null);
const ageMod = await import('./age-verification.js');
const ageTok = await ageMod.createAgeVerificationToken('test-secret-for-logout-verification', {});
check('age-verification token rejected as a session', (await session.getVerifiedSessionUserId(fakeReq(ageTok))) === null);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
