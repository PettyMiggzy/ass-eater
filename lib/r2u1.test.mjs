import test from 'node:test';
import assert from 'node:assert/strict';
import { inferContentType, preflightUpload, payoutWalletError } from '../components/dashboard/helpers.js';
import { mediaKindFor, isHeicType, HEIC_TYPE_MESSAGE, IMAGE_TYPES } from './upload-guard.js';
import { payoutWalletError as serverPayoutWalletError } from './field-validation.js';
import { isDemoCreator, isDemoListing } from '../components/public/cards.js';
import * as status from './creator-status.js';

/**
 * Round-2 UI fixes (R2U1). Pure -- no DB.
 */

test('HEIC/HEIF is refused for every upload purpose, with a message that says what to do', () => {
  for (const t of ['image/heic', 'image/heif', 'image/HEIC', 'image/heic-sequence']) {
    assert.ok(isHeicType(t), t);
    for (const p of ['gallery', 'avatar', 'listing']) {
      assert.equal(mediaKindFor(p, t), null, `${p} ${t} must not be accepted by the server allowlist`);
      assert.equal(preflightUpload(p, t, 1000), HEIC_TYPE_MESSAGE, `${p} ${t}`);
    }
  }
  assert.ok(!('image/heic' in IMAGE_TYPES) && !('image/heif' in IMAGE_TYPES));
  // A .HEIC picked with an empty browser type is recognised, then refused.
  assert.equal(preflightUpload('gallery', inferContentType({ type: '', name: 'IMG_0001.HEIC' }), 1000), HEIC_TYPE_MESSAGE);
  assert.match(HEIC_TYPE_MESSAGE, /JPEG/);
  // Formats browsers can draw still go through.
  for (const t of ['image/jpeg', 'image/png', 'image/webp']) assert.equal(preflightUpload('avatar', t, 1000), null);
});

test('dashboard wallet check is exactly the server rule (EIP-55 parity)', () => {
  const lower = '0x52908400098527886e0f7030069857d2e4169ee7';
  const cases = [
    '',
    lower,
    lower.toUpperCase().replace('0X', '0x'),
    '0x52908400098527886E0F7030069857D2E4169EE7',
    '0x52908400098527886E0F7030069857D2E4169Ee7', // mixed case, bad checksum
    '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
    '0x0000000000000000000000000000000000000000',
    '0x123',
    'not an address',
  ];
  for (const c of cases) {
    assert.equal(payoutWalletError(c), c.trim() ? serverPayoutWalletError(c.trim()) : null, JSON.stringify(c));
  }
  assert.ok(payoutWalletError('0x52908400098527886E0F7030069857D2E4169Ee7'), 'bad mixed-case checksum is refused');
  assert.equal(payoutWalletError(lower), null, 'all-lowercase is accepted');
});

test('the UI demo label uses the same predicate checkout does', () => {
  assert.equal(isDemoCreator, status.isDemoCreator);
  assert.equal(isDemoListing, status.isDemoListing);
  assert.ok(isDemoListing({ id: 1 }, { seed: true }));
  assert.ok(isDemoListing({ id: 1, demo: true }, null));
  assert.ok(!isDemoListing({ id: 1 }, { seed: false }));
});
