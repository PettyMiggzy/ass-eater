import test from 'node:test';
import assert from 'node:assert/strict';
import { marketplaceHrefFor } from '../components/public/cards.js';

// public-pages#1: listing tiles on a creator profile and in /search link to
// the marketplace scoped to that creator and that listing, which
// pages/marketplace.js reads server-side -- not to the bare, unfiltered
// /marketplace for every item.

test('marketplaceHrefFor scopes to the creator and the listing', () => {
  assert.equal(marketplaceHrefFor({ id: 12, creatorId: 7 }), '/marketplace?creator=7&listing=12');
  assert.equal(
    marketplaceHrefFor({ id: 'a1b2c3d4-0000-4000-8000-000000000000', creatorId: 'c-9' }),
    '/marketplace?creator=c-9&listing=a1b2c3d4-0000-4000-8000-000000000000',
  );
});

test('marketplaceHrefFor encodes odd ids and degrades to /marketplace', () => {
  assert.equal(marketplaceHrefFor({ id: 'x&y', creatorId: '1' }), '/marketplace?creator=1&listing=x%26y');
  assert.equal(marketplaceHrefFor({ id: 3 }), '/marketplace?listing=3');
  assert.equal(marketplaceHrefFor(null), '/marketplace');
  assert.equal(marketplaceHrefFor({}), '/marketplace');
});
