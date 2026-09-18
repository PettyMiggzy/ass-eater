import { mock } from 'node:test';

// Real error classes so instanceof checks are exercised for real.
const real = await import('@vercel/blob');

let state = { mode: 'ok', blob: null, etag: 'etag-1', puts: [] };

mock.module('@vercel/blob', {
  namedExports: {
    BlobNotFoundError: real.BlobNotFoundError,
    BlobPreconditionFailedError: real.BlobPreconditionFailedError,
    head: async () => {
      if (state.mode === 'missing') throw new real.BlobNotFoundError();
      if (state.mode === 'head-5xx') throw new Error('Vercel Blob: service unavailable');
      if (state.mode === 'store-missing') throw new real.BlobStoreNotFoundError();
      return { url: 'https://example.test/manifest.json', etag: state.etag };
    },
    put: async (path, body, opts) => {
      state.puts.push({ path, body, ifMatch: opts.ifMatch });
      if (state.mode === 'conflict-once') {
        state.mode = 'ok';
        throw new real.BlobPreconditionFailedError();
      }
      state.blob = JSON.parse(body);
      return { url: 'x' };
    },
  },
});

globalThis.fetch = async () => {
  if (state.mode === 'body-fail') throw new TypeError('fetch failed');
  if (state.mode === 'body-5xx') return { ok: false, status: 503 };
  return { ok: true, status: 200, json: async () => state.blob };
};

const { readJsonList, updateJsonList } = await import('./blob-json-store.js');

let pass = 0, fail = 0;
const check = (name, cond, extra='') => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); } };

const REAL_USERS = [{ id: 'a', email: 'real1@x.com' }, { id: 'b', email: 'real2@x.com' }];

console.log('\n1. THE CATASTROPHIC CASE: manifest exists, body read throws mid-write');
state = { mode: 'body-fail', blob: [...REAL_USERS], etag: 'etag-1', puts: [] };
let threw = null;
try { await updateJsonList('data/users.json', (cur) => ({ next: cur, result: 'ok' })); }
catch (e) { threw = e; }
check('throws instead of writing', threw !== null, threw);
check('NOTHING was written to the blob', state.puts.length === 0, JSON.stringify(state.puts));
check('real records intact', JSON.stringify(state.blob) === JSON.stringify(REAL_USERS), JSON.stringify(state.blob));

console.log('\n2. Same, but storage returns 5xx on the body');
state = { mode: 'body-5xx', blob: [...REAL_USERS], etag: 'etag-1', puts: [] };
threw = null;
try { await updateJsonList('data/users.json', (cur) => ({ next: cur, result: 'ok' })); } catch (e) { threw = e; }
check('throws', threw !== null);
check('no write attempted', state.puts.length === 0);
check('real records intact', JSON.stringify(state.blob) === JSON.stringify(REAL_USERS));

console.log('\n3. head() itself fails (not a 404)');
state = { mode: 'head-5xx', blob: [...REAL_USERS], etag: 'etag-1', puts: [] };
threw = null;
try { await updateJsonList('data/users.json', (cur) => ({ next: cur, result: 'ok' })); } catch (e) { threw = e; }
check('throws', threw !== null);
check('no write attempted', state.puts.length === 0);
check('real records intact', JSON.stringify(state.blob) === JSON.stringify(REAL_USERS));

console.log('\n4. GENUINELY missing manifest still uses the fallback (must not regress)');
state = { mode: 'missing', blob: null, etag: null, puts: [] };
const seed = [{ id: 'seed1', seed: true }];
let res = await updateJsonList('data/creators.json', (cur) => ({ next: [...cur, { id: 'new' }], result: 'created' }), { fallback: seed });
check('returns transform result', res === 'created');
check('wrote seed + new', JSON.stringify(state.blob) === JSON.stringify([{ id: 'seed1', seed: true }, { id: 'new' }]), JSON.stringify(state.blob));
check('no ifMatch on first create', state.puts[0].ifMatch === undefined);

console.log('\n5. Normal update writes behind the ETag');
state = { mode: 'ok', blob: [...REAL_USERS], etag: 'etag-7', puts: [] };
res = await updateJsonList('data/users.json', (cur) => ({ next: [...cur, { id: 'c' }], result: 'added' }));
check('returns result', res === 'added');
check('sent ifMatch', state.puts[0].ifMatch === 'etag-7');
check('kept existing records', state.blob.length === 3);

console.log('\n6. Write conflict retries against fresh state');
state = { mode: 'conflict-once', blob: [...REAL_USERS], etag: 'etag-9', puts: [] };
res = await updateJsonList('data/users.json', (cur) => ({ next: [...cur, { id: 'd' }], result: 'added' }));
check('eventually succeeded', res === 'added');
check('retried (2 put attempts)', state.puts.length === 2, String(state.puts.length));

console.log('\n7. readJsonList: missing -> fallback, broken -> throws');
state = { mode: 'missing', blob: null, etag: null, puts: [] };
check('missing returns fallback', JSON.stringify(await readJsonList('p', [1,2])) === '[1,2]');
state = { mode: 'body-fail', blob: [...REAL_USERS], etag: 'e', puts: [] };
threw = null;
try { await readJsonList('p', [1,2]); } catch (e) { threw = e; }
check('real read failure throws instead of returning fallback', threw !== null);

console.log('\n8. transform returning a non-array is refused');
state = { mode: 'ok', blob: [...REAL_USERS], etag: 'e', puts: [] };
threw = null;
try { await updateJsonList('p', () => ({ next: 'oops', result: 1 })); } catch (e) { threw = e; }
check('throws', threw !== null);
check('nothing written', state.blob.length === 2);


console.log('\n9. A broken/deleted blob STORE must not read as "no data yet"');
state = { mode: 'store-missing', blob: [...REAL_USERS], etag: 'e', puts: [] };
threw = null;
try { await readJsonList('data/creators.json', [{ id: 'seed1', seed: true }]); } catch (e) { threw = e; }
check('store-not-found throws instead of serving the demo roster', threw !== null, String(threw));
threw = null;
try { await updateJsonList('data/creators.json', (cur) => ({ next: cur, result: 1 }), { fallback: [{ id: 'seed1', seed: true }] }); } catch (e) { threw = e; }
check('store-not-found aborts the write', threw !== null);
check('nothing written', state.puts.length === 0);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);

// Run with:
//   node --experimental-test-module-mocks --no-warnings lib/blob-json-store.test.mjs
//
// Test 1 is the one that matters most: it is a regression test for a bug that
// reached production. The version of this helper deployed on 2026-09-18 failed
// it by writing "[]" over the entire manifest, behind a VALID ETag precondition,
// and returning success -- i.e. a silent, complete loss of every stored record
// (all accounts, or all listings, or all takedown reports) caused by one
// transient read failure during any ordinary write. If a future change makes
// test 1 fail again, do not "fix" the test.
