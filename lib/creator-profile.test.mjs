import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAge, sanitizeLocation, UnderageProfile, MAX_CREATOR_AGE } from './creators-store.js';

/**
 * The age field is the one thing on a creator profile that must never fail
 * open. Clamping an under-18 entry up to 18, or silently dropping it, would
 * leave a profile saying one thing and a record saying another -- so it
 * throws, and the API turns that into a refusal the creator sees.
 */
test('refuses an age under 18 rather than correcting it', () => {
  for (const bad of [17, 16, 0, -3, '17', 17.9]) {
    assert.throws(() => sanitizeAge(bad), UnderageProfile, `should refuse ${bad}`);
  }
});

test('accepts 18 and above', () => {
  assert.equal(sanitizeAge(18), 18);
  assert.equal(sanitizeAge('24'), 24);
  assert.equal(sanitizeAge(24.9), 24); // floored, not rounded up past what was typed
});

test('treats blank as "not stated" rather than as zero', () => {
  for (const blank of ['', null, undefined]) assert.equal(sanitizeAge(blank), null);
  // Garbage is not an under-18 claim, so it is dropped rather than refused --
  // refusing it would block a save over a typo in an optional field.
  assert.equal(sanitizeAge('abc'), null);
});

test('caps an implausible age instead of storing it verbatim', () => {
  assert.equal(sanitizeAge(100000), MAX_CREATOR_AGE);
});

test('location is trimmed, collapsed and bounded', () => {
  assert.equal(sanitizeLocation('  Los   Angeles,  CA '), 'Los Angeles, CA');
  assert.equal(sanitizeLocation(null), '');
  assert.equal(sanitizeLocation('x'.repeat(200)).length, 60);
});
