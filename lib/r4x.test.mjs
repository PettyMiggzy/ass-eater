// Regression tests for the round-4 orchestrator fixes, against a real scratch
// Postgres (it truncates tables), never mocks:
//  - a paid physical order whose shipping address can't be read is refused
//    by markOrderShipped (and the ship route answers 409 ADDRESS_UNREADABLE);
//  - a readable one still ships;
//  - isCheckoutKeyClaimed recognises this buyer's committed key only.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r4x.test.mjs

import crypto from 'crypto';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
if (!process.env.ORDERS_ENCRYPTION_KEY) process.env.ORDERS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { query, closePool } = await import('./db.js');
const orders = await import('./orders-store.js');
const { encryptShippingAddress } = await import('./crypto.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
const origError = console.error;
const quiet = async (fn) => { console.error = () => {}; try { return await fn(); } finally { console.error = origError; } };

await query('truncate orders, checkout_idempotency restart identity');

async function mkOrder(creatorId, shippingAddress) {
  const { rows } = await query(
    'insert into orders (data) values ($1::jsonb) returning id',
    [JSON.stringify({ creatorId: String(creatorId), buyerId: 'b1', kind: 'physical', status: 'pending_shipment', shippingAddress })],
  );
  return String(rows[0].id);
}

const good = await mkOrder('7', encryptShippingAddress({ fullName: 'A B', line1: '1 Main St', city: 'X', postalCode: '1', country: 'US' }));
const garbled = await mkOrder('7', { line1: 'not-a-real-ciphertext' });
const missing = await mkOrder('7', null);

async function shipErr(id) {
  try { await quiet(() => orders.markOrderShipped(id, '7', { carrier: 'UPS', trackingNumber: 'T1' })); return null; } catch (err) { return err; }
}
check('readable address ships', (await shipErr(good)) === null);
const e1 = await shipErr(garbled);
check('undecryptable address is refused', e1 && e1.code === 'ADDRESS_UNREADABLE', e1 && e1.message);
const e2 = await shipErr(missing);
check('missing address is refused', e2 && e2.code === 'ADDRESS_UNREADABLE', e2 && e2.message);
const { rows: st } = await query(`select data->>'status' as s from orders where id = $1`, [garbled]);
check('refused order stays pending_shipment', st[0].s === 'pending_shipment');
const e3 = await shipErr(good.replace(/\d+$/, (d) => String(Number(d) + 999)));
check('unknown order still reads as not found', e3 && e3.message === 'Order not found');

await query(`insert into checkout_idempotency (idempotency_key, buyer_id) values ('k-1', 'u1')`);
check('own committed key is claimed', await orders.isCheckoutKeyClaimed('k-1', 'u1'));
check("another buyer's key is not reported as theirs", !(await orders.isCheckoutKeyClaimed('k-1', 'u2')));
check('unknown key is not claimed', !(await orders.isCheckoutKeyClaimed('k-2', 'u1')));
check('non-string key is not claimed', !(await orders.isCheckoutKeyClaimed({ x: 1 }, 'u1')));

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
