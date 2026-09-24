import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProhibitedTerms, screenPublicText, publicProfileTextEntries } from './prohibited-terms.js';
import { normalizeHandle, handleKey, isAllowedAvatarSrc, sanitizeDmPriceCents } from './field-validation.js';

// Audit creators-users#15: tags feed the public tag cloud with no re-review.
test('blocks minor-suggestive and card-network-prohibited terms, including evasions', () => {
  for (const bad of ['teen', 'teens', 'Teenage dream', 't33n', 't e e n', 'T-E-E-N', 'schoolgirl', 'school girl',
    'barely-legal', 'barelylegal', 'loli', 'lolita', 'jailbait', 'underage', 'age play', 'incest', 'bestiality',
    'non-consensual', 'rape', 'littlegirl', 'tееn' /* Cyrillic е */]) {
    assert.equal(detectProhibitedTerms(bad).flagged, true, `should block ${bad}`);
  }
});

test('does not flag ordinary words that merely contain a term', () => {
  for (const ok of ['eighteen', 'nineteen', 'canteen', 'Esteban', 'grape', 'drape', 'scraped', 'rapeseed oil',
    'therapist', 'lol!', 'lol', 'torpedo', 'speedo', 'pedometer', 'Los Angeles, CA', 'cosplay', 'gym', 'asmr',
    'minor edits', 'no kids on set', '$9.99 / month', 'Free', '', undefined]) {
    assert.equal(detectProhibitedTerms(ok).flagged, false, `should allow ${ok}`);
  }
});

// Review follow-up: a separator allowed between SOME letters let terms match
// across ordinary word breaks. Only a fully spaced-out word counts now.
test('does not match a term across an ordinary word break', () => {
  for (const ok of ['I shot a new video today', 'Just shot a gym session', 'lol i love this', 'Rap e',
    'We shot a set', 'sho ta', 'te en']) {
    assert.equal(detectProhibitedTerms(ok).flagged, false, `should allow ${ok}`);
  }
  for (const bad of ['s h o t a', 'l.o.l.i', 'r a p e', 'b a r e l y l e g a l', 'T 3 3 N', 'teen.']) {
    assert.equal(detectProhibitedTerms(bad).flagged, true, `should block ${bad}`);
  }
  // A standalone term is still the term, whatever follows it.
  assert.equal(detectProhibitedTerms('loli pop').flagged, true);
  assert.equal(detectProhibitedTerms('pedo meter').flagged, true);
});

test('screenPublicText reports prohibited terms before payment circumvention', () => {
  assert.equal(screenPublicText('teen cashapp $jane').kind, 'prohibited');
  assert.equal(screenPublicText('Miami, FL - cashapp $jane').kind, 'payment');
  assert.equal(screenPublicText('venmo @mia 555-123-4567').kind, 'payment');
  assert.equal(screenPublicText('Los Angeles, CA'), null);
  assert.equal(screenPublicText('$12.99 / month'), null);
});

// Audit admin-dashboard#10 / creators-users#8: location, price, tags and
// socials are public and must be screened like name/handle/bio.
test('publicProfileTextEntries covers every public text field', () => {
  const entries = publicProfileTextEntries({
    name: 'A', handle: '@a', bio: 'b', location: 'L', price: 'P', tags: ['x', 'y'], socials: { twitter: 't' }, walletAddress: '0x1',
  });
  assert.deepEqual(entries.map(([k]) => k), ['name', 'handle', 'bio', 'location', 'price', 'tag', 'tag', 'social_twitter']);
});

// Audit admin-dashboard#12 / creators-users#17 / platform-public#13.
test('handles normalise to one canonical form', () => {
  assert.deepEqual(normalizeHandle('alice'), { handle: '@alice' });
  assert.deepEqual(normalizeHandle('@@alice '), { handle: '@alice' });
  assert.equal(handleKey('@Alice'), handleKey('alice'));
  assert.ok(normalizeHandle('ali ce').error);
  assert.ok(normalizeHandle('a').error);
  assert.ok(normalizeHandle('').error);
  assert.deepEqual(normalizeHandle('', { allowBlank: true }), { handle: '' });
  assert.ok(normalizeHandle({}).error);
  assert.ok(normalizeHandle('<script>').error);
});

// Audit cross-cutting-ops#12 et al.: no arbitrary avatar URLs.
test('avatar src must be our own media route for that creator, or a local image', () => {
  assert.equal(isAllowedAvatarSrc('/api/media/avatars/7/abc-123.jpg', '7'), true);
  assert.equal(isAllowedAvatarSrc('/api/media/avatars/8/abc.jpg', '7'), false);
  assert.equal(isAllowedAvatarSrc('/api/media/avatars/7/../8/x.jpg', '7'), false);
  assert.equal(isAllowedAvatarSrc('/images/avatar-placeholder.png', null), true);
  assert.equal(isAllowedAvatarSrc('https://tracker.example/p.gif', '7'), false);
  assert.equal(isAllowedAvatarSrc('//tracker.example/p.gif', '7'), false);
  assert.equal(isAllowedAvatarSrc('data:image/png;base64,AAAA', '7'), false);
  assert.equal(isAllowedAvatarSrc('/api/media/avatars/7/a.jpg', null), false);
});

test('dm price is null or a whole number of cents in range', () => {
  assert.deepEqual(sanitizeDmPriceCents(null), { value: null });
  assert.deepEqual(sanitizeDmPriceCents(''), { value: null });
  assert.deepEqual(sanitizeDmPriceCents(250), { value: 250 });
  assert.deepEqual(sanitizeDmPriceCents('250'), { value: 250 });
  for (const bad of [98, 50001, 1.5, 'abc', {}, -1, true]) assert.ok(sanitizeDmPriceCents(bad).error, `should refuse ${bad}`);
});
