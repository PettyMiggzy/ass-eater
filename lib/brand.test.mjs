import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCredits,
  PLATFORM_FEE_PCT,
  MARKETPLACE_FEE_PCT,
  LISTING_FEE_PCT,
  CREDIT_PURCHASE_FEE_PCT,
  DM_PRICE_FLOOR_CENTS,
} from './brand.js';
import { FEES } from './fees.js';
import { ALL_SUGGESTED_TAGS, LANDING_CATEGORIES } from './tag-taxonomy.js';

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

/**
 * Fee copy. Public pages and the Terms quote these, so they must be the
 * rates lib/fees.js actually charges. "We take 10% -- nothing else" shipped
 * while every live sale was charged 15%; these pin the decided numbers so a
 * rate change forces the copy (and this test) to be looked at together.
 */
test('fee percentages for copy are derived from the rates the code charges', () => {
  assert.equal(PLATFORM_FEE_PCT, FEES.DEFAULT_BPS / 100);
  assert.equal(MARKETPLACE_FEE_PCT, FEES.MARKETPLACE_BPS / 100);
  assert.equal(CREDIT_PURCHASE_FEE_PCT, FEES.DEPOSIT_BPS / 100);
  assert.equal(PLATFORM_FEE_PCT + LISTING_FEE_PCT, MARKETPLACE_FEE_PCT);
});

test('decided rates: 10% platform, 15% marketplace (10% + 5% listing), 2% to buy credits', () => {
  assert.equal(PLATFORM_FEE_PCT, 10);
  assert.equal(MARKETPLACE_FEE_PCT, 15);
  assert.equal(LISTING_FEE_PCT, 5);
  assert.equal(CREDIT_PURCHASE_FEE_PCT, 2);
  assert.equal(DM_PRICE_FLOOR_CENTS, 99);
});

test('the "$100 buys 98 credits" example in the copy matches the purchase fee', () => {
  const grossCents = 10000;
  // Same arithmetic as lib/deposit.js (fee floored).
  const creditedCents = grossCents - Math.floor((grossCents * FEES.DEPOSIT_BPS) / 10_000);
  assert.equal(creditedCents, 9800);
});

/**
 * /search matches tags exactly. The landing page's category links used to
 * point at 'men'/'women'/'couples' while the picker suggests
 * 'man'/'woman'/'couple', so those links could never find a creator who
 * tagged themselves as suggested.
 */
test('every landing-page category links to a tag the tag picker actually offers', () => {
  for (const c of LANDING_CATEGORIES) {
    if (c.tag === null) continue;
    assert.ok(ALL_SUGGESTED_TAGS.includes(c.tag), `landing category ${c.label} -> '${c.tag}' is not a suggested tag`);
  }
});
