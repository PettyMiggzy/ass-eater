// Round-9 R9U1 regression tests: a cart built on a shared browser must never
// be shown to, or paid for by, a different account (public-pages#1).
// lib/cart-ownership.js holds the pure rules lib/cart.js's CartProvider runs.
//
//   node --test lib/r9u1.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCartOwnership, editCart } from './cart-ownership.js';

const item = (id) => ({ id, title: `Listing ${id}`, priceCents: 500 });
const add = (it) => (prev) => (prev.some((p) => p.id === it.id) ? prev : [...prev, it]);

test('an owned cart is withheld until the viewer is known', () => {
  const stored = { owner: 'A', items: [item(1)] };
  const r = resolveCartOwnership(stored, undefined);
  assert.deepEqual(r.visible, []);
  assert.equal(r.ready, false);
  assert.equal(r.state, stored, 'withheld, not deleted');
});

test('the owner sees their own cart', () => {
  const stored = { owner: 'A', items: [item(1)] };
  const r = resolveCartOwnership(stored, 'A');
  assert.deepEqual(r.visible, [item(1)]);
  assert.equal(r.state, stored);
});

test('a different account signing in never sees, and discards, the previous cart', () => {
  const stored = { owner: 'A', items: [item(1), item(2)] };
  const r = resolveCartOwnership(stored, 'B');
  assert.deepEqual(r.visible, []);
  assert.deepEqual(r.state, { owner: 'B', items: [] });
});

test('signing out discards an owned cart', () => {
  const r = resolveCartOwnership({ owner: 'A', items: [item(1)] }, null);
  assert.deepEqual(r.visible, []);
  assert.deepEqual(r.state, { owner: null, items: [] });
});

test('numeric and string account ids compare equal', () => {
  const r = resolveCartOwnership({ owner: '7', items: [item(1)] }, 7);
  assert.deepEqual(r.visible, [item(1)]);
});

test('an anonymous cart is shown and adopted by the first account to sign in', () => {
  const stored = { owner: null, items: [item(1)] };
  assert.deepEqual(resolveCartOwnership(stored, undefined).visible, [item(1)]);
  const signedOut = resolveCartOwnership(stored, null);
  assert.equal(signedOut.state, stored, 'stable: no state churn while signed out');
  const r = resolveCartOwnership(stored, 'A');
  assert.deepEqual(r.state, { owner: 'A', items: [item(1)] });
  // ...and after adoption it is A's alone.
  assert.deepEqual(resolveCartOwnership(r.state, 'B').visible, []);
});

test('resolution is stable once settled (no render loop)', () => {
  for (const [stored, viewer] of [
    [{ owner: 'A', items: [item(1)] }, 'A'],
    [{ owner: null, items: [] }, 'A'],
    [{ owner: null, items: [item(1)] }, null],
  ]) {
    const r = resolveCartOwnership(stored, viewer);
    assert.equal(resolveCartOwnership(r.state, viewer).state, r.state);
  }
});

test('editing as B never extends A\'s cart', () => {
  const next = editCart({ owner: 'A', items: [item(1)] }, 'B', add(item(2)));
  assert.deepEqual(next, { owner: 'B', items: [item(2)] });
});

test('an edit before the viewer is known stays under the existing owner', () => {
  const next = editCart({ owner: 'A', items: [item(1)] }, undefined, add(item(2)));
  assert.deepEqual(next, { owner: 'A', items: [item(1), item(2)] });
  // If the viewer then turns out to be someone else, all of it goes.
  assert.deepEqual(resolveCartOwnership(next, 'B').visible, []);
});

test('adding while signed in stamps the owner; signed out stays anonymous', () => {
  assert.deepEqual(editCart({ owner: null, items: [] }, 'A', add(item(1))), { owner: 'A', items: [item(1)] });
  assert.deepEqual(editCart({ owner: null, items: [] }, null, add(item(1))), { owner: null, items: [item(1)] });
});

test('clear as the owner empties the cart', () => {
  assert.deepEqual(editCart({ owner: 'A', items: [item(1)] }, 'A', () => []), { owner: 'A', items: [] });
});
