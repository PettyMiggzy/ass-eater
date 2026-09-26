// Regression tests for the round-22 backend fixes (package R22B), run against a
// real scratch Postgres (it truncates tables). The text-screen findings
// (accounts#0-#9) have their own pure suites: lib/screen-benign.test.mjs,
// lib/screen-generated.test.mjs and lib/screen-corpus.test.mjs.
//  - gates-token#0: /api/age-verify/confirm refuses a cross-site request
//    before the uuid parse, the limiter and the outbound AgeChecker call;
//  - legal-journeys#0: confirm answers a stable `code` -- 'denied' for a real
//    denial, 'pending' for anything AgeChecker is still working on (and the
//    uuid is NOT claimed, so the same verification can be confirmed later);
//  - media#0 / social#0: POST /api/favorites/toggle validates the id, adds
//    only a real public creator (404 otherwise), always removes, and is
//    rate-limited per user;
//  - money#0: the deposit-wallet challenge is bound to the account that asked
//    for it -- a nonce cookie minted by one session and a signature over its
//    message cannot bind a wallet to another session's account -- and the
//    signed text names the account.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r22b.test.mjs

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
process.env.BRIDGE_SECRET = 'test-bridge-secret-r22b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r22b';
process.env.SIGNUPS_OPEN = 'true';
process.env.AGECHECKER_SECRET_KEY = 'test-agechecker-secret';
process.env.NEXT_PUBLIC_AGECHECKER_KEY = 'test-domain-key';
process.env.NEXT_PUBLIC_MARKETPLACE_PAYOUT_ADDRESS = '0x000000000000000000000000000000000000dEaD';
process.env.NEXT_PUBLIC_MARKETPLACE_USDC_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_ID = '4663';
process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_NAME = 'Test Chain';
process.env.NEXT_PUBLIC_MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
process.env.MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { query, closePool } = await import('./db.js');
const users = await import('./users-store.js');
const creators = await import('./creators-store.js');
const walletAuth = await import('./wallet-auth.js');
const { ageVerificationSecret } = await import('./age-verification.js');
const { createSessionToken } = await import('./session.js');
const { privateKeyToAccount } = await import('viem/accounts');
const { default: confirmRoute } = await import('../pages/api/age-verify/confirm.js');
const { default: favoritesRoute } = await import('../pages/api/favorites/toggle.js');
const { default: walletNonceRoute } = await import('../pages/api/credits/wallet-nonce.js');
const { default: verifyWalletRoute } = await import('../pages/api/credits/verify-wallet.js');

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
async function call(route, { method = 'POST', body, headers: extra = {}, user = null, cookies = {}, ip = null } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = { host: 'joinonlyone.com', 'content-type': 'application/json', ...extra };
  const cookieJar = { ...cookies };
  if (user) cookieJar.oa_session = createSessionToken(user.id, user.sessionVersion || 0);
  if (Object.keys(cookieJar).length) headers.cookie = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  const req = { method, body, query: {}, headers, cookies: cookieJar, socket: { remoteAddress: ip || `10.22.${Math.floor(ipN / 250)}.${ipN % 250}` } };
  await quiet(() => route(req, res));
  return res;
}
const setCookies = (res) => [].concat(res.headers['set-cookie'] || []);
const cookieValue = (res, name) => {
  for (const c of setCookies(res)) {
    const m = c.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return m[1];
  }
  return null;
};

await query(`truncate creators, users, favorites, age_verification_uses restart identity`);
await query('delete from app_meta');
await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);

// ---------------------------------------------------------------------------
section('gates-token#0 / legal-journeys#0: /api/age-verify/confirm');
{
  let fetchCalls = 0;
  let nextStatus = 'accepted';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls++;
    return { ok: true, json: async () => ({ key: 'test-domain-key', status: nextStatus }) };
  };
  try {
    // Cross-site: refused before anything else, no outbound call.
    let res = await call(confirmRoute, { body: { uuid: 'u-cross' }, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    check('a cross-site form POST is 403', res.statusCode === 403, String(res.statusCode));
    check('...sets no cookie', !cookieValue(res, 'oa_age_verified'));
    res = await call(confirmRoute, { body: { uuid: 'u-cross2' }, headers: { 'sec-fetch-site': 'cross-site' } });
    check('Sec-Fetch-Site cross-site is 403', res.statusCode === 403);
    res = await call(confirmRoute, { body: { uuid: 'u-cross3' }, headers: { origin: 'https://evil.example' } });
    check('a foreign Origin is 403', res.statusCode === 403);
    check('...and none of them reached AgeChecker', fetchCalls === 0, String(fetchCalls));

    // Pending: a stable code, the uuid is not claimed.
    nextStatus = 'photo_id';
    res = await call(confirmRoute, { body: { uuid: 'u-pending' }, headers: { origin: 'https://joinonlyone.com', 'sec-fetch-site': 'same-origin' } });
    check('a verification still under review answers code "pending"', res.statusCode === 409 && res.body?.code === 'pending', JSON.stringify(res.body));
    check('...with no cookie', !cookieValue(res, 'oa_age_verified'));
    check('...and the uuid is NOT claimed', (await query(`select 1 from age_verification_uses where uuid = 'u-pending'`)).rowCount === 0);
    nextStatus = 'accepted';
    res = await call(confirmRoute, { body: { uuid: 'u-pending' } });
    check('the SAME uuid confirms once AgeChecker accepts it', res.statusCode === 200 && !!cookieValue(res, 'oa_age_verified'), JSON.stringify(res.body));

    // Denied: its own code.
    nextStatus = 'denied';
    res = await call(confirmRoute, { body: { uuid: 'u-denied' } });
    check('a denial answers code "denied"', res.statusCode === 400 && res.body?.code === 'denied', JSON.stringify(res.body));
    check('...never AgeChecker\'s own reason text', !/reason/i.test(JSON.stringify(res.body)));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
section('media#0 / social#0: POST /api/favorites/toggle');
{
  const fan = await users.createUser({ email: 'fan@r22b.test', password: 'password123', role: 'fan' });
  const live = await creators.createCreator({ name: 'Live', handle: '@r22blive', status: 'active' });
  const hidden = await creators.createCreator({ name: 'Hidden', handle: '@r22bhidden', status: 'pending' });
  for (const bad of [{}, [1, 2], 'x'.repeat(3000), 'abc', '0', -1, 1.5, true]) {
    const res = await call(favoritesRoute, { user: fan, body: { creatorId: bad } });
    check(`creatorId ${JSON.stringify(bad).slice(0, 16)} is 400`, res.statusCode === 400, String(res.statusCode));
  }
  let res = await call(favoritesRoute, { user: fan, body: { creatorId: '999999' } });
  check('a creator that does not exist is 404', res.statusCode === 404, String(res.statusCode));
  res = await call(favoritesRoute, { user: fan, body: { creatorId: String(hidden.id) } });
  check('a creator that is not public is 404', res.statusCode === 404, String(res.statusCode));
  res = await call(favoritesRoute, { user: fan, body: { creatorId: Number(live.id) } });
  check('a real public creator is added (numeric id)', res.statusCode === 200 && res.body.favorited === true, JSON.stringify(res.body));
  await query(`update creators set data = data || '{"status":"banned"}'::jsonb where id = $1`, [String(live.id)]);
  res = await call(favoritesRoute, { user: fan, body: { creatorId: String(live.id) } });
  check('...and can still be removed after the creator is hidden', res.statusCode === 200 && res.body.favorited === false, JSON.stringify(res.body));
  check('no junk row was ever stored', (await query('select creator_id from favorites')).rows.every((r) => /^[1-9][0-9]*$/.test(r.creator_id)));
  // Rate limit: 60 per minute per user.
  const fan2 = await users.createUser({ email: 'fan2@r22b.test', password: 'password123', role: 'fan' });
  const other = await creators.createCreator({ name: 'Other', handle: '@r22bother', status: 'active' });
  let limited = 0;
  for (let i = 0; i < 65; i++) {
    const r = await call(favoritesRoute, { user: fan2, body: { creatorId: String(other.id) } });
    if (r.statusCode === 429) limited++;
  }
  check('the 61st toggle in a minute is 429', limited === 5, String(limited));
}

// ---------------------------------------------------------------------------
section('money#0: the deposit-wallet proof is bound to the account');
{
  const secret = ageVerificationSecret();
  // Library level.
  const a = await walletAuth.createWalletNonce(secret, { uid: 'acct-a' });
  check('a bound nonce reads back for its own account', (await walletAuth.readWalletNonce(secret, a.token, { uid: 'acct-a' })) === a.nonce);
  check('...and NOT for another account', (await walletAuth.readWalletNonce(secret, a.token, { uid: 'acct-b' })) === null);
  const unbound = await walletAuth.createWalletNonce(secret);
  check('an unbound nonce is refused where an account is required', (await walletAuth.readWalletNonce(secret, unbound.token, { uid: 'acct-a' })) === null);
  check('...but still reads for the account-less flows', (await walletAuth.readWalletNonce(secret, unbound.token)) === unbound.nonce);
  check('the message names the account', /Account: j\*\*e@example\.com/.test(walletAuth.depositProofMessage({ host: 'h', nonce: 'n', account: walletAuth.depositAccountLabel({ email: 'jane@example.com' }) })));
  check('a short and a long local part do not render the same label', walletAuth.depositAccountLabel({ email: 'jx@gmail.com' }) !== walletAuth.depositAccountLabel({ email: 'jane@gmail.com' }));
  check('the label carries the start of the account id', walletAuth.depositAccountLabel({ id: 'abcdef123456', email: 'jane@gmail.com' }) === 'j**e@gmail.com (id abcdef12)');
  check('a username is shown as-is', walletAuth.depositAccountLabel({ email: 'janedoe' }) === 'janedoe');
  check('the full email address is never in the message', !/jane@/.test(walletAuth.depositProofMessage({ host: 'h', nonce: 'n', account: walletAuth.depositAccountLabel({ email: 'jane@example.com' }) })));

  // Route level: attacker mints the nonce, victim signs its message, attacker
  // cannot redeem it for... a DIFFERENT session; and the victim's signature
  // over the attacker's message cannot bind to the victim's own account.
  const attacker = await users.createUser({ email: 'attacker@r22b.test', password: 'password123', role: 'fan' });
  const victim = await users.createUser({ email: 'victim@r22b.test', password: 'password123', role: 'fan' });
  const wallet = privateKeyToAccount(`0x${crypto.randomBytes(32).toString('hex')}`);

  const nonceRes = await call(walletNonceRoute, { method: 'GET', user: attacker });
  check('wallet-nonce issues a message', nonceRes.statusCode === 200 && typeof nonceRes.body?.message === 'string', JSON.stringify(nonceRes.body));
  check('...naming the requesting account', /Account: a\*{6}r@r22b\.test \(id [^)]+\)/.test(nonceRes.body?.message || ''), nonceRes.body?.message);
  const nonceCookie = cookieValue(nonceRes, walletAuth.DEPOSIT_NONCE_COOKIE_NAME);
  const signature = await wallet.signMessage({ message: nonceRes.body.message });

  // The same (cookie, signature) pair presented by ANOTHER session.
  let res = await call(verifyWalletRoute, { user: victim, cookies: { [walletAuth.DEPOSIT_NONCE_COOKIE_NAME]: nonceCookie }, body: { address: wallet.address, signature } });
  check('a nonce minted for one account is refused for another', res.statusCode === 400, `${res.statusCode} ${JSON.stringify(res.body)}`);
  check('...and no deposit-wallet cookie is minted', !cookieValue(res, 'oa_deposit_wallet'));

  // The rightful session still works end to end.
  res = await call(verifyWalletRoute, { user: attacker, cookies: { [walletAuth.DEPOSIT_NONCE_COOKIE_NAME]: nonceCookie }, body: { address: wallet.address, signature } });
  check('the account the nonce was minted for can verify', res.statusCode === 200 && !!cookieValue(res, 'oa_deposit_wallet'), `${res.statusCode} ${JSON.stringify(res.body)}`);

  // A signature over a message naming a DIFFERENT account does not verify.
  const victimNonce = await call(walletNonceRoute, { method: 'GET', user: victim });
  const wrongText = victimNonce.body.message.replace(/Account: .*/, 'Account: someone-else');
  const wrongSig = await wallet.signMessage({ message: wrongText });
  res = await call(verifyWalletRoute, { user: victim, cookies: { [walletAuth.DEPOSIT_NONCE_COOKIE_NAME]: cookieValue(victimNonce, walletAuth.DEPOSIT_NONCE_COOKIE_NAME) }, body: { address: wallet.address, signature: wrongSig } });
  check('a signature over text naming another account is refused', res.statusCode === 400, `${res.statusCode}`);
}

await closePool();
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
