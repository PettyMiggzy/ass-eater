// Regression tests for the age-verification gate:
//   1. an accepted AgeChecker uuid is redeemable exactly once (replay fix);
//   2. owner / reviewer / owner-wallet bypass cookies are revoked the moment
//      the credential that minted them is rotated or removed;
//   3. ?next= redirects stay on this origin (the "/\t/evil.com" open redirect);
//   4. proxy.js fails CLOSED for US traffic with no resolvable state, and
//      exempts the public plumbing files and /coming-soon from the gate.
//
// Run with:
//   DATABASE_URL=postgresql://…/onlyone_site \
//   node --import ./test-register.mjs lib/age-gate.test.mjs
//
// Truncates age_verification_uses, so it refuses anything but a local
// scratch database.
import { query, closePool } from './db.js';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database (…/onlyone_site).');
  process.exit(2);
}

process.env.SESSION_SECRET = 'test-secret-for-age-gate';
delete process.env.OWNER_ACCESS_KEY;
delete process.env.REVIEWER_ACCESS_KEY;
delete process.env.OWNER_WALLET_ADDRESS;
delete process.env.PREVIEW_ACCESS_KEY;

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x)); };

// Touch the schema (ensureSchema runs on first query), then start clean.
await query('select 1');
await query('delete from age_verification_uses');

const uses = await import('./age-verification-uses.js');
const age = await import('./age-verification.js');
const { safeRedirectPath } = await import('./safe-redirect.js');
const SECRET = age.ageVerificationSecret();

console.log('\n1. An accepted AgeChecker uuid is single-use');
check('first redemption claims it', (await uses.claimAgeVerificationUuid('AbC-123')) === true);
check('second redemption is refused', (await uses.claimAgeVerificationUuid('AbC-123')) === false);
check('a different casing is the same verification', (await uses.claimAgeVerificationUuid('abc-123')) === false);
check('surrounding whitespace does not make it new', (await uses.claimAgeVerificationUuid('  ABC-123 ')) === false);
check('a different uuid is still claimable', (await uses.claimAgeVerificationUuid('xyz-789')) === true);
{
  const results = await Promise.all(Array.from({ length: 20 }, () => uses.claimAgeVerificationUuid('race-uuid')));
  check('20 concurrent redemptions: exactly one wins', results.filter(Boolean).length === 1, JSON.stringify(results));
}

console.log('\n2. Bypass cookies are revoked when their credential changes');
process.env.OWNER_ACCESS_KEY = 'first-owner-key';
const ownerTok = await age.createBypassAgeVerificationToken(SECRET, 'owner');
check('owner cookie passes while its key is current', (await age.verifyAgeVerificationToken(SECRET, ownerTok))?.via === 'owner');
{
  const payload = JSON.parse(Buffer.from(ownerTok.split('.')[0], 'base64url').toString());
  check('fingerprint is not a plain hash of the key', typeof payload.kf === 'string' && !payload.kf.includes('first-owner-key'));
  check('owner cookie lasts ~180 days', Math.abs(payload.exp - Date.now() - 180 * 864e5) < 60_000);
}
process.env.OWNER_ACCESS_KEY = 'rotated-owner-key';
check('rotating the owner key revokes it', (await age.verifyAgeVerificationToken(SECRET, ownerTok)) === null);
delete process.env.OWNER_ACCESS_KEY;
check('unsetting the owner key revokes it', (await age.verifyAgeVerificationToken(SECRET, ownerTok)) === null);
process.env.OWNER_ACCESS_KEY = 'first-owner-key';
check('restoring the same key restores it (fingerprint, not a nonce)', (await age.verifyAgeVerificationToken(SECRET, ownerTok))?.via === 'owner');

// A cookie minted by the OLD code: correctly signed, via:'owner', no kf.
const legacy = await age.createAgeVerificationToken(SECRET, { via: 'owner' });
check('pre-revocation owner cookie (no kf) is refused', (await age.verifyAgeVerificationToken(SECRET, legacy)) === null);
const forgedKf = await age.createAgeVerificationToken(SECRET, { via: 'owner', kf: 'AAAAAAAAAAAAAAAAAAAAAA' });
check('a wrong kf is refused', (await age.verifyAgeVerificationToken(SECRET, forgedKf)) === null);
const unknownVia = await age.createAgeVerificationToken(SECRET, { via: 'backdoor', kf: 'x' });
check('an unknown via is refused', (await age.verifyAgeVerificationToken(SECRET, unknownVia)) === null);

process.env.REVIEWER_ACCESS_KEY = 'reviewer-key-1';
const revTok = await age.createBypassAgeVerificationToken(SECRET, 'reviewer');
check('reviewer cookie passes while its key is current', (await age.verifyAgeVerificationToken(SECRET, revTok))?.via === 'reviewer');
{
  const payload = JSON.parse(Buffer.from(revTok.split('.')[0], 'base64url').toString());
  check('reviewer cookie lasts 14 days, not 180', Math.abs(payload.exp - Date.now() - 14 * 864e5) < 60_000);
}
check('owner key cannot validate a reviewer cookie', (await age.verifyAgeVerificationToken(SECRET, revTok))?.via === 'reviewer');
process.env.REVIEWER_ACCESS_KEY = 'reviewer-key-2';
check('rotating the reviewer key revokes it', (await age.verifyAgeVerificationToken(SECRET, revTok)) === null);
check('...without touching the owner cookie', (await age.verifyAgeVerificationToken(SECRET, ownerTok))?.via === 'owner');

process.env.OWNER_WALLET_ADDRESS = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
const walletTok = await age.createBypassAgeVerificationToken(SECRET, 'owner-wallet');
process.env.OWNER_WALLET_ADDRESS = '0xabcdef0123456789abcdef0123456789abcdef01';
check('re-saving the wallet in different casing keeps it valid', (await age.verifyAgeVerificationToken(SECRET, walletTok))?.via === 'owner-wallet');
process.env.OWNER_WALLET_ADDRESS = '0x1111111111111111111111111111111111111111';
check('changing the owner wallet revokes it', (await age.verifyAgeVerificationToken(SECRET, walletTok)) === null);

const realTok = await age.createAgeVerificationToken(SECRET, { uuid: 'real-uuid' });
check('a real AgeChecker cookie is unaffected by all of this', (await age.verifyAgeVerificationToken(SECRET, realTok))?.uuid === 'real-uuid');
let threw = false;
delete process.env.REVIEWER_ACCESS_KEY;
try { await age.createBypassAgeVerificationToken(SECRET, 'reviewer'); } catch { threw = true; }
check('minting with no configured credential throws', threw);

console.log('\n3. ?next= stays on this origin');
const F = '/fallback';
for (const [input, want] of [
  ['/creator/5?tab=wall#x', '/creator/5?tab=wall#x'],
  ['/dashboard', '/dashboard'],
  ['//evil.com', F],
  ['/\\evil.com', F],
  ['/\t/evil.com', F],
  ['/\n/evil.com', F],
  ['/%09/evil.com', '/%09/evil.com'],
  ['/.//evil.com', F],
  ['https://evil.com', F],
  ['javascript:alert(1)', F],
  ['evil.com', F],
  ['', F],
  [undefined, F],
  [['/a'], F],
  [{ toString: () => '/a' }, F],
]) {
  const got = safeRedirectPath(input, F);
  check(`${JSON.stringify(String(input))} -> ${want}`, got === want, `got ${got}`);
}

console.log('\n4. proxy.js: fail closed on unknown US state; static files and /coming-soon exempt');
// Bare Node cannot resolve the extensionless 'next/server' proxy.js imports
// (next ships no ESM "exports" map for it), and test-resolver.mjs only
// extends relative specifiers -- so register one more resolve hook, local to
// this test, that maps it to the real file.
const { register, createRequire } = await import('node:module');
const hook = `export async function resolve(s, c, n) { return n(s === 'next/server' ? 'next/server.js' : s, c); }`;
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);
const { NextRequest } = createRequire(import.meta.url)('next/server.js');
const { proxy } = await import('../proxy.js');
const run = async (path, headers = {}, cookie = '') => {
  const req = new NextRequest(`https://www.joinonlyone.com${path}`, {
    headers: { host: 'www.joinonlyone.com', ...headers, ...(cookie ? { cookie } : {}) },
  });
  return proxy(req);
};
const rewrittenTo = (res) => res.headers.get('x-middleware-rewrite') || '';
const US = (region) => (region === undefined ? { 'x-vercel-ip-country': 'US' } : { 'x-vercel-ip-country': 'US', 'x-vercel-ip-country-region': region });

check('US + no region header is gated', rewrittenTo(await run('/home', US())).endsWith('/blocked-region'));
check('US + empty region header is gated', rewrittenTo(await run('/home', US(''))).endsWith('/blocked-region'));
check('US + no region: API answers 451', (await run('/api/creators', US())).status === 451);
check('US + blocked state (TX) is gated', rewrittenTo(await run('/home', US('TX'))).endsWith('/blocked-region'));
check('US + open state (NY) is not gated', !rewrittenTo(await run('/home', US('NY'))));
check('non-US with no region is not gated', !rewrittenTo(await run('/home', { 'x-vercel-ip-country': 'CA' })));
check('no geo headers at all (dev) is not gated', !rewrittenTo(await run('/home')));
for (const p of ['/robots.txt', '/sitemap.xml', '/manifest.json', '/apple-touch-icon.png', '/coming-soon']) {
  check(`${p} reachable from TX with no cookie`, !rewrittenTo(await run(p, US('TX'))));
}
check('similar-looking path is NOT exempt', rewrittenTo(await run('/robots.txt.bak', US('TX'))).endsWith('/blocked-region'));
check('/api/media stays gated', (await run('/api/media/gallery/1/x.jpg', US('TX'))).status === 451);
check('/api/token-gate stays gated', (await run('/api/token-gate/verify', US('TX'))).status === 451);
check('creator images stay gated', rewrittenTo(await run('/images/demo_female_1.jpg', US('TX'))).endsWith('/blocked-region'));

process.env.OWNER_ACCESS_KEY = 'proxy-owner-key';
const pTok = await age.createBypassAgeVerificationToken(SECRET, 'owner');
check('a current owner cookie passes the proxy', !rewrittenTo(await run('/home', US('TX'), `oa_age_verified=${pTok}`)));
process.env.OWNER_ACCESS_KEY = 'proxy-owner-key-rotated';
check('after rotation the same cookie is gated at the proxy', rewrittenTo(await run('/home', US('TX'), `oa_age_verified=${pTok}`)).endsWith('/blocked-region'));
check('a real verification cookie still passes the proxy', !rewrittenTo(await run('/home', US(), `oa_age_verified=${realTok}`)));

process.env.PREVIEW_ACCESS_KEY = 'preview-key-for-test';
for (const p of ['/robots.txt', '/sitemap.xml', '/manifest.json', '/apple-touch-icon.png']) {
  check(`${p} not hidden behind the preview gate`, !rewrittenTo(await run(p)));
}
check('preview gate still hides /home', rewrittenTo(await run('/home')).endsWith('/coming-soon'));
delete process.env.PREVIEW_ACCESS_KEY;

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
