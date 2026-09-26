// Regression tests for the round-15 admin-UI/legal fixes (package R15U2), run
// against a real scratch Postgres (it truncates tables):
//  - legal-journeys#0: erasing a shipped order's address (an erasure request,
//    or a fan deleting their account) also erases its tracking number and
//    every number kept in trackingHistory, and no correction can write one
//    back afterwards; pending orders and other buyers' orders are untouched.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r15u2.test.mjs

import crypto from 'crypto';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
if (!process.env.ORDERS_ENCRYPTION_KEY) process.env.ORDERS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { query, closePool } = await import('./db.js');
const orders = await import('./orders-store.js');
const { encryptShippingAddress } = await import('./crypto.js');

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; failures.push(`${name} ${extra}`); console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);
const orig = { error: console.error, warn: console.warn, info: console.info };
const quiet = async (fn) => {
  console.error = () => {}; console.warn = () => {}; console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
};

await query('truncate orders, notifications restart identity');
const addr = () => encryptShippingAddress({ fullName: 'A B', line1: '1 Main St', city: 'X', postalCode: '1', country: 'US' });
const mk = async (data) => String((await query(
  'insert into orders (data) values ($1::jsonb) returning id',
  [JSON.stringify({ creatorId: '7', kind: 'physical', ...data })],
)).rows[0].id);
const row = async (id) => (await query('select data from orders where id = $1', [id])).rows[0].data;
const noNumbers = (d) => d.trackingNumber === null
  && Array.isArray(d.trackingHistory) && d.trackingHistory.every((h) => h.trackingNumber === null);

// ---------------------------------------------------------------------------
section('legal-journeys#0: erasing one shipped order clears its tracking numbers too');
{
  const o = await mk({ buyerId: 'b1', status: 'pending_shipment', shippingAddress: addr() });
  await quiet(() => orders.markOrderShipped(o, '7', { carrier: 'UPS', trackingNumber: 'FIRST1' }));
  await quiet(() => orders.markOrderShipped(o, '7', { carrier: 'USPS', trackingNumber: 'SECOND2' }));
  await quiet(() => orders.markOrderShipped(o, '7', { carrier: 'FedEx', trackingNumber: 'THIRD3' }));
  const before = await row(o);
  check('setup: two corrections kept in history', before.trackingHistory.length === 2 && before.trackingNumber === 'THIRD3', JSON.stringify(before));

  const res = await orders.eraseOrderShippingAddress(o);
  const after = await row(o);
  check('the erase reports erased', res.erased === true && typeof res.addressErasedAt === 'string', JSON.stringify(res));
  check('...the address is gone', after.shippingAddress === null);
  check('...the current tracking number is gone', after.trackingNumber === null, JSON.stringify(after));
  check('...every number in the history is gone', noNumbers(after), JSON.stringify(after.trackingHistory));
  check('...the carriers, dates and correction count stay', after.carrier === 'FedEx' && after.trackingHistory.length === 2
    && after.trackingHistory[0].carrier === 'UPS' && after.trackingHistory[1].carrier === 'USPS'
    && typeof after.trackingHistory[0].replacedAt === 'string' && typeof after.shippedAt === 'string', JSON.stringify(after));
  check('...trackingErasedAt is stamped', typeof after.trackingErasedAt === 'string');
  check('no stored text anywhere still holds a number', !/FIRST1|SECOND2|THIRD3/.test(JSON.stringify(after)));

  let err = null;
  try { await quiet(() => orders.markOrderShipped(o, '7', { carrier: 'UPS', trackingNumber: 'AGAIN4' })); } catch (e) { err = e; }
  check('a creator cannot write a number back afterwards', err && err.code === orders.TRACKING_EDIT_LIMIT && /erased/.test(err.message), err && err.message);
  check('...and nothing was written', (await row(o)).trackingNumber === null);
  const view = (await orders.getOrdersForCreator('7')).find((x) => String(x.id) === o);
  check('the creator view shows 0 corrections left', view && view.trackingCorrectionsLeft === 0, JSON.stringify(view));
  const state = await orders.getOrderShipState(o, '7');
  check('the ship route sees 0 corrections left', state && state.correctionsLeft === 0, JSON.stringify(state));
  const buyerView = (await orders.getOrdersForBuyer('b1')).find((x) => String(x.id) === o);
  check('the buyer view says the tracking was erased', buyerView && typeof buyerView.trackingErasedAt === 'string' && buyerView.trackingNumber === null, JSON.stringify(buyerView));
  const again = await orders.eraseOrderShippingAddress(o);
  check('a second erase is a no-op', again.erased === false, JSON.stringify(again));
}

section('an order whose address was erased before this fix still has its tracking cleared');
{
  const o = await mk({ buyerId: 'b9', status: 'shipped', shippingAddress: null, addressErasedAt: '2026-01-01T00:00:00.000Z',
    carrier: 'UPS', trackingNumber: 'OLD1', trackingHistory: [{ carrier: 'UPS', trackingNumber: 'OLD0', replacedAt: '2025-12-01T00:00:00.000Z' }] });
  const res = await orders.eraseOrderShippingAddress(o);
  const after = await row(o);
  check('it is erased', res.erased === true && noNumbers(after), JSON.stringify(after));
  check('...keeping the original addressErasedAt', after.addressErasedAt === '2026-01-01T00:00:00.000Z', after.addressErasedAt);
}

section('neighbours: a pending order still refuses; a digital order has nothing to erase');
{
  const p = await mk({ buyerId: 'b2', status: 'pending_shipment', shippingAddress: addr() });
  let err = null;
  try { await orders.eraseOrderShippingAddress(p); } catch (e) { err = e; }
  check('pending -> ORDER_NOT_SHIPPED', err && err.code === orders.ORDER_NOT_SHIPPED, err && err.code);
  check('...its address stays', (await row(p)).shippingAddress !== null);
  const d = await mk({ buyerId: 'b2', kind: 'digital', status: 'paid' });
  const res = await orders.eraseOrderShippingAddress(d);
  check('digital -> erased: false', res.erased === false);
  check('...and nothing is stamped on it', !('trackingErasedAt' in (await row(d))));
}

section('legal-journeys#0: a buyer\'s account deletion clears every shipped order\'s tracking');
{
  const s1 = await mk({ buyerId: 'b3', status: 'pending_shipment', shippingAddress: addr() });
  await quiet(() => orders.markOrderShipped(s1, '7', { carrier: 'UPS', trackingNumber: 'B3A' }));
  await quiet(() => orders.markOrderShipped(s1, '7', { carrier: 'UPS', trackingNumber: 'B3B' }));
  const s2 = await mk({ buyerId: 'b3', status: 'shipped', shippingAddress: null, carrier: 'DHL', trackingNumber: 'B3C' });
  const pend = await mk({ buyerId: 'b3', status: 'pending_shipment', shippingAddress: addr() });
  const other = await mk({ buyerId: 'b4', status: 'pending_shipment', shippingAddress: addr() });
  await quiet(() => orders.markOrderShipped(other, '7', { carrier: 'UPS', trackingNumber: 'B4A' }));

  const count = await orders.eraseShippedAddressesForBuyer('b3');
  check('both shipped orders are erased', count === 2, String(count));
  const r1 = await row(s1);
  const r2 = await row(s2);
  check('...the first loses its address and every number', r1.shippingAddress === null && noNumbers(r1) && r1.trackingHistory.length === 1, JSON.stringify(r1));
  check('...the second (address already gone) loses its number', r2.trackingNumber === null && typeof r2.trackingErasedAt === 'string', JSON.stringify(r2));
  const rp = await row(pend);
  check('the pending order keeps its address', rp.shippingAddress !== null && !('trackingErasedAt' in rp));
  const ro = await row(other);
  check('another buyer\'s order is untouched', ro.trackingNumber === 'B4A' && ro.shippingAddress !== null, JSON.stringify(ro));
  check('a second run erases nothing', (await orders.eraseShippedAddressesForBuyer('b3')) === 0);
}

section('neighbour: an ordinary correction still works before any erasure');
{
  const o = await mk({ buyerId: 'b5', status: 'pending_shipment', shippingAddress: addr() });
  await quiet(() => orders.markOrderShipped(o, '7', { carrier: 'UPS', trackingNumber: 'N1' }));
  await quiet(() => orders.markOrderShipped(o, '7', { carrier: 'UPS', trackingNumber: 'N2' }));
  const r = await row(o);
  check('the correction is stored', r.trackingNumber === 'N2' && r.trackingHistory.length === 1 && !('trackingErasedAt' in r), JSON.stringify(r));
}

for (const f of failures) console.log('  FAILED:', f);
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
