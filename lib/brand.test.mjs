import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCredits } from './brand.js';

/**
 * The display rule is "show both, always" -- these are the regression tests
 * for the two ways that could quietly stop being true.
 */
test('shows both the credit count and the dollar figure', () => {
  assert.equal(formatCredits(5000), '50 credits ($50.00)');
});

test('singular "credit" for exactly one', () => {
  assert.equal(formatCredits(100), '1 credit ($1.00)');
});

test('fractional credits still show two decimal places on the dollar side', () => {
  assert.equal(formatCredits(150), '1.50 credits ($1.50)');
});

test('zero reads as zero, not blank', () => {
  assert.equal(formatCredits(0), '0 credits ($0.00)');
});

test('large balances get thousands separators on the credit count', () => {
  assert.equal(formatCredits(123456700), '1,234,567 credits ($1,234,567.00)');
});
