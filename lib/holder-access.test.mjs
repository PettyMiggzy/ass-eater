// Tests for the real token gate: the oa_holder token, the nonce -> signature
// -> server-read balance flow, and who the media route serves a gated
// creator's gallery to. Run against a real scratch Postgres (truncates tables):
//   DATABASE_URL=postgresql://.../onlyone_..._test node --import ./test-register.mjs lib/holder-access.test.mjs
//
// The on-chain reader is replaced with an in-memory map (the one thing that
// needs a live chain); everything else -- signature recovery, cookies, the
// route's entitlement decision -- is the real code.

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-one';
process.env.NEXT_PUBLIC_ONLYONE_TOKEN_ADDRESS = '0x2c34ED86552076715272056D021cEab6080F1Ab5';
process.env.MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';

const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
const { query, closePool } = await import('./db.js');
const media = await import('./media.js');
const creators = await import('./creators-store.js');
const users = await import('./users-store.js');
const holder = await import('./holder-access.js');
const gate = await import('./token-gate.js');
const age = await import('./age-verification.js');
const { createSessionToken } = await import('./session.js');
const { default: mediaRoute } = await import('../pages/api/media/[...path].js');
const { default: nonceRoute } = await import('../pages/api/token-gate/nonce.js');
const { default: verifyRoute } = await import('../pages/api/token-gate/verify.js');
const { default: statusRoute } = await import('../pages/api/token-gate/status.js');
const { default: clearRoute } = await import('../pages/api/token-gate/clear.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);
const origError = console.error;
const origWarn = console.warn;
const quiet = async (fn) => {
  console.error = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { console.error = origError; console.warn = origWarn; }
};

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; },
  };
}
let ipCounter = 0;
function fakeReq({ method = 'GET', cookie, body, query: q = {} } = {}) {
  return { method, query: q, body, headers: { host: 'www.joinonlyone.com', ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: `10.0.0.${++ipCounter % 250}` } };
}
function cookiesFrom(res) {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = {};
  for (const c of list) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

// In-memory "chain".
const balances = new Map();
let rpcDown = false;
holder.__setHolderBalanceReaderForTests(async (addr) => {
  if (rpcDown) throw new Error('rpc down');
  return balances.get(String(addr).toLowerCase()) ?? 0n;
});

async function fetchMedia(pathname, { cookie } = {}) {
  const req = { method: 'GET', query: { path: pathname.split('/') }, headers: cookie ? { cookie } : {}, socket: {} };
  const res = fakeRes();
  await quiet(() => mediaRoute(req, res));
  return res.statusCode;
}
const served = (code) => code !== 404;

async function proveHolding(account) {
  const nRes = fakeRes();
  await nonceRoute(fakeReq(), nRes);
  const nonceCookie = cookiesFrom(nRes)[gate.HOLDER_NONCE_COOKIE_NAME];
  const signature = await account.signMessage({ message: nRes.body.message });
  const vRes = fakeRes();
  await quiet(() => verifyRoute(fakeReq({ method: 'POST', cookie: `${gate.HOLDER_NONCE_COOKIE_NAME}=${nonceCookie}`, body: { address: account.address, signature } }), vRes));
  return { nRes, vRes, holderCookie: cookiesFrom(vRes)[gate.HOLDER_COOKIE_NAME] };
}

section('pure decision');
{
  const c = { locked: true, gateTokens: 1000 };
  check('no wallet is refused', gate.tokenGateDecision(c, null).reason === 'no_wallet');
  check('exact threshold passes', gate.tokenGateDecision(c, '1000').allowed === true);
  check('one short fails', gate.tokenGateDecision(c, 999n).allowed === false);
  check('huge balances compare exactly', gate.tokenGateDecision(c, '123456789012345678901234567890').allowed === true);
  check('garbage balance is treated as no wallet', gate.tokenGateDecision(c, 'lots').reason === 'no_wallet');
  check('ungated creators need nothing', gate.tokenGateDecision({ locked: true, gateTokens: 0 }, null).allowed === true);
}

section('oa_holder token');
{
  const addr = '0x' + 'ab'.repeat(20);
  const t = holder.createHolderToken({ address: addr, balance: 5000n });
  const read = holder.readHolderToken(t);
  check('fresh token verifies', read && read.address === addr && read.balance === '5000');
  const [p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), bal: '999999999999' })).toString('base64url');
  check('raising the balance in the payload breaks the signature', holder.readHolderToken(`${forged}.${s}`) === null);
  check('expired token fails', holder.readHolderToken(holder.createHolderToken({ address: addr, balance: 5n }, Date.now() - 2 * 3600 * 1000)) === null);
  const ageToken = await age.createAgeVerificationToken(age.ageVerificationSecret());
  check('an age-verification token is not a holder pass', holder.readHolderToken(ageToken) === null);
  check('an admin media token is not a holder pass', holder.readHolderToken(media.createAdminMediaToken()) === null);
  check('a holder pass is not an admin media token', !media.verifyAdminMediaToken(t));
  check('a holder pass is not an age-verification token', !(await age.verifyAgeVerificationToken(age.ageVerificationSecret(), t)));
  check('a session token is not a holder pass', holder.readHolderToken(createSessionToken('1', 0)) === null);
}

section('nonce + verify');
{
  const whale = privateKeyToAccount(generatePrivateKey());
  balances.set(whale.address.toLowerCase(), 3_000_000n);
  const { nRes, vRes, holderCookie } = await proveHolding(whale);
  check('nonce issues a message naming the site and this flow', nRes.statusCode === 200 && /verify your \$ONLYONE holding/.test(nRes.body.message) && /www\.joinonlyone\.com/.test(nRes.body.message));
  check('verify succeeds with the server-read balance', vRes.statusCode === 200 && vRes.body.balance === '3000000', JSON.stringify(vRes.body));
  check('verify sets an oa_holder cookie', !!holderCookie && holder.readHolderToken(decodeURIComponent(holderCookie))?.balance === '3000000');

  // A signature over the message by a DIFFERENT wallet than the claimed address.
  const n2 = fakeRes();
  await nonceRoute(fakeReq(), n2);
  const nc2 = cookiesFrom(n2)[gate.HOLDER_NONCE_COOKIE_NAME];
  const other = privateKeyToAccount(generatePrivateKey());
  const sig2 = await other.signMessage({ message: n2.body.message });
  const v2 = fakeRes();
  await quiet(() => verifyRoute(fakeReq({ method: 'POST', cookie: `${gate.HOLDER_NONCE_COOKIE_NAME}=${nc2}`, body: { address: whale.address, signature: sig2 } }), v2));
  check("someone else's address cannot be claimed", v2.statusCode === 400 && !cookiesFrom(v2)[gate.HOLDER_COOKIE_NAME]);

  const n3 = fakeRes();
  await nonceRoute(fakeReq(), n3);
  const sig3 = await whale.signMessage({ message: n3.body.message });
  const v3 = fakeRes();
  await quiet(() => verifyRoute(fakeReq({ method: 'POST', body: { address: whale.address, signature: sig3 } }), v3));
  check('a signature without the nonce cookie is refused', v3.statusCode === 400);

  const n4 = fakeRes();
  await nonceRoute(fakeReq(), n4);
  const nc4 = cookiesFrom(n4)[gate.HOLDER_NONCE_COOKIE_NAME];
  const sig4 = await whale.signMessage({ message: n4.body.message.replace('verify your $ONLYONE holding', 'sign in as owner') });
  const v4 = fakeRes();
  await quiet(() => verifyRoute(fakeReq({ method: 'POST', cookie: `${gate.HOLDER_NONCE_COOKIE_NAME}=${nc4}`, body: { address: whale.address, signature: sig4 } }), v4));
  check("another flow's message cannot be replayed here", v4.statusCode === 400);

  const v5 = fakeRes();
  await verifyRoute(fakeReq({ method: 'POST', body: { address: { x: 1 }, signature: 1 } }), v5);
  check('non-string fields are rejected cleanly', v5.statusCode === 400);

  rpcDown = true;
  const r = await proveHolding(whale);
  rpcDown = false;
  check('an unreadable chain gives 502 and no pass', r.vRes.statusCode === 502 && !r.holderCookie);

  const saved = process.env.MARKETPLACE_RPC_URL;
  delete process.env.MARKETPLACE_RPC_URL;
  const n6 = fakeRes();
  await nonceRoute(fakeReq(), n6);
  check('without a server RPC the flow is 501, not open', n6.statusCode === 501);
  process.env.MARKETPLACE_RPC_URL = saved;

  const c = fakeRes();
  clearRoute(fakeReq({ method: 'POST' }), c);
  check('clear expires the cookie', /oa_holder=;.*Max-Age=0/.test(String(c.headers['set-cookie'])));
}

section('media route + holderCanView');
{
  await query('truncate creators, users, listings, orders restart identity');
  await query('delete from app_meta');
  const owner = await creators.createCreator({ name: 'Gated', handle: '@gated', status: 'active' });
  const ownerUser = await users.createUser({ email: 'gated@example.com', password: 'pw123456', role: 'creator', creatorId: owner.id });
  const fan = await users.createUser({ email: 'fan@example.com', password: 'pw123456', role: 'fan' });
  const cookieFor = (u) => `oa_session=${encodeURIComponent(createSessionToken(u.id, 0))}`;
  const gPath = media.newMediaPathname({ purpose: 'gallery', creatorId: owner.id, contentType: 'image/jpeg' });
  await creators.addGalleryItem(owner.id, { type: 'image', src: media.mediaSrc(gPath) }, []);
  await creators.updateCreatorProfile(owner.id, { locked: true, gateTokens: 2_500_000 });
  const gated = await creators.getCreatorById(owner.id);

  const rich = privateKeyToAccount(generatePrivateKey());
  const poor = privateKeyToAccount(generatePrivateKey());
  balances.set(rich.address.toLowerCase(), 3_000_000n);
  balances.set(poor.address.toLowerCase(), 2_499_999n);
  const richCookie = `${gate.HOLDER_COOKIE_NAME}=${(await proveHolding(rich)).holderCookie}`;
  const poorCookie = `${gate.HOLDER_COOKIE_NAME}=${(await proveHolding(poor)).holderCookie}`;

  check('anonymous visitor is refused gated media', !served(await fetchMedia(gPath)));
  check('a verified holder with too few tokens is refused', !served(await fetchMedia(gPath, { cookie: poorCookie })));
  check('a verified holder with enough is served', served(await fetchMedia(gPath, { cookie: richCookie })));
  check('the owner is served without a wallet', served(await fetchMedia(gPath, { cookie: cookieFor(ownerUser) })));

  check('holderCanView: anonymous false', !(await holder.holderCanView(fakeReq(), gated)));
  check('holderCanView: holder with enough true', await holder.holderCanView(fakeReq({ cookie: richCookie }), gated));
  check('holderCanView: holder with too few false', !(await holder.holderCanView(fakeReq({ cookie: poorCookie }), gated)));
  check('holderCanView: owner true', await holder.holderCanView(fakeReq({ cookie: cookieFor(ownerUser) }), gated));
  check('holderCanView: another fan false', !(await holder.holderCanView(fakeReq({ cookie: cookieFor(fan) }), gated)));

  const pub = creators.toPublicCreator(gated, { viewerMayUnlock: false });
  check('the public projection carries no src for a gated gallery', pub.gallery.every((g) => !g.src && g.locked));

  // Selling after verifying: once the short cache lapses the re-read wins.
  balances.set(rich.address.toLowerCase(), 10n);
  holder.__setHolderBalanceReaderForTests(async (addr) => balances.get(String(addr).toLowerCase()) ?? 0n); // also clears the cache
  check('a holder who sold is refused on the next fresh read', !served(await fetchMedia(gPath, { cookie: richCookie })));
  balances.set(rich.address.toLowerCase(), 3_000_000n);
  holder.__setHolderBalanceReaderForTests(async () => { throw new Error('rpc down'); });
  check('RPC outage falls back to the server-read balance in the signed pass', served(await fetchMedia(gPath, { cookie: richCookie })));

  // A hanging RPC must not stall the request: the deadline trips, the signed
  // pass is used, and the next request skips the chain entirely.
  let hangingCalls = 0;
  holder.__setHolderBalanceReaderForTests(() => { hangingCalls++; return new Promise(() => {}); });
  holder.__setHolderRpcDeadlineForTests(150);
  let t0 = Date.now();
  const hungFirst = served(await fetchMedia(gPath, { cookie: richCookie }));
  const firstMs = Date.now() - t0;
  check('a hanging RPC falls back within the deadline', hungFirst && firstMs < 1500, `took ${firstMs}ms`);
  t0 = Date.now();
  const hungSecond = served(await fetchMedia(gPath, { cookie: richCookie }));
  const secondMs = Date.now() - t0;
  check('after a failure the chain is skipped during the backoff', hungSecond && hangingCalls === 1 && secondMs < 100, `calls=${hangingCalls} took ${secondMs}ms`);
  check('holderCanView is bounded the same way while the RPC is down', await holder.holderCanView(fakeReq({ cookie: richCookie }), gated));
  holder.__setHolderRpcDeadlineForTests(null);
  holder.__setHolderBalanceReaderForTests(async (addr) => balances.get(String(addr).toLowerCase()) ?? 0n);

  const sRes = fakeRes();
  await statusRoute(fakeReq({ cookie: richCookie, query: { creatorId: String(owner.id) } }), sRes);
  check('status reports the pass and the decision', sRes.statusCode === 200 && sRes.body.verified && sRes.body.creator?.allowed === true && sRes.body.creator.reason === 'holds_enough', JSON.stringify(sRes.body));
  const sRes2 = fakeRes();
  await statusRoute(fakeReq({ query: { creatorId: { $ne: 1 } } }), sRes2);
  check('status tolerates a non-string creatorId', sRes2.statusCode === 200 && sRes2.body.creator === null);

  const saved = process.env.MARKETPLACE_RPC_URL;
  delete process.env.MARKETPLACE_RPC_URL;
  check('without a verifier nobody but the owner gets in', !served(await fetchMedia(gPath, { cookie: richCookie })) && served(await fetchMedia(gPath, { cookie: cookieFor(ownerUser) })));
  process.env.MARKETPLACE_RPC_URL = saved;
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
