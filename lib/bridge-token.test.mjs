import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.BRIDGE_SECRET = 'test-bridge-secret';
const { mintBridgeToken } = await import('./bridge-token.js');

const decode = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));

test('every token carries a fresh single-use jti and the site uid', () => {
  const a = decode(mintBridgeToken({ id: 'abc-1', role: 'fan', email: 'x@y.z' }));
  const b = decode(mintBridgeToken({ id: 'abc-1', role: 'fan', email: 'x@y.z' }));
  assert.equal(a.uid, 'abc-1');
  assert.equal(typeof a.jti, 'string');
  assert.ok(a.jti.length >= 16);
  assert.notEqual(a.jti, b.jti);
  assert.ok(a.exp > Date.now() && a.exp <= Date.now() + 61_000);
});

test('creatorStatus is carried for creators only, and only known values', () => {
  assert.equal(decode(mintBridgeToken({ id: '1', role: 'creator' }, 'banned')).creatorStatus, 'banned');
  assert.equal(decode(mintBridgeToken({ id: '1', role: 'creator' }, 'active')).role, 'CREATOR');
  assert.equal(decode(mintBridgeToken({ id: '1', role: 'fan' }, 'banned')).creatorStatus, null);
  assert.equal(decode(mintBridgeToken({ id: '1', role: 'creator' }, 'weird')).creatorStatus, 'banned'); // fails closed: unknown creator status is sent as banned
});
