import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProhibitedTerms, screenPublicText, publicProfileTextEntries } from './prohibited-terms.js';
import { normalizeHandle, handleKey, isAllowedAvatarSrc, sanitizeDmPriceCents, looksLikePhoneNumber } from './field-validation.js';

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

// Round-2 accounts#0: tags and handles are glued words, so a word-only match
// let every prohibited term through as long as it touched another word.
test('blocks prohibited terms glued into compounds (tags, handles)', () => {
  for (const bad of ['teenpussy', '@hotteen', 'jailbaitxx', 'sexyschoolgirl', 'rapefantasy', 'teenslut', '@teenbabe',
    'petiteteen', 'schoolgirlxo', 'lolibabe', 'l0libabe', 'incestfun', 't33npussy', 'barelylegalxo', 'underagegirl',
    'preteenz', 'nonconsentplay', 'teeny']) {
    assert.equal(detectProhibitedTerms(bad).flagged, true, `should block ${bad}`);
    assert.equal(screenPublicText(bad)?.kind, 'prohibited', `screen should refuse ${bad}`);
  }
});

test('the compound allowlist keeps honest words that contain a term clean', () => {
  for (const ok of ['eighteen', 'nineteenth', 'canteen', 'velveteen sheets', 'sweet sixteen', 'Kirsteen', 'grapefruit',
    'skyscraper', 'therapeutic', 'parapet', 'rapeseed', 'draper', 'trapeze', 'lolipop', 'lollipop', 'stageplay',
    'hello11', 'yolo11', 'headshotart', 'torpedo', 'speedo', 'nonconformist', 'between', 'thunder ages', 'Esteban']) {
    assert.equal(detectProhibitedTerms(ok).flagged, false, `should allow ${ok}`);
  }
});

// Round-2 review: real names that contain "teen"/"rape" must not be refused
// (and logged as minor-suggestive) while the glued forms stay blocked.
test('names containing a compound term are allowed; the glued forms still are not', () => {
  for (const ok of ['Sarah Steen', 'Ronnie Steen', 'Steenbergen', 'Vansteenkiste', 'thanks Mateen!', 'Justeen',
    'Teena Marie', 'Teenah', 'Rapeepat', 'Rapeeporn', 'pristeen']) {
    assert.equal(detectProhibitedTerms(ok).flagged, false, `should allow ${ok}`);
  }
  for (const bad of ['hotteen', 'teenpussy', 'teenass', 'teenanal', 'teenaxo', 'rapefantasy', 'rapeeteen', 'mateen teenpussy']) {
    assert.equal(detectProhibitedTerms(bad).flagged, true, `should block ${bad}`);
  }
});

// Round-3 accounts#1: the inflections of "rape" that drop the "e", the common
// "beastiality" misspelling, and explicit under-18 ages.
test('blocks raping/rapist/molest, beastiality and explicit minor ages', () => {
  for (const bad of ['raping', 'rapist', 'rapists', 'molested', 'molester', 'beastiality', 'beastialityfun',
    '16yo', '16 yo', '17 y/o', '15 y.o.', '#17yo', "I'm 12 yr old", 'i am 15 years old', 'im only 16 years old',
    'I\u2019m 16 years old', 'aged 15 years old', 'she is 14 yrs old', 'just turned 17 years old',
    '17-year-old girl', '15 year old schoolgirl', '16yo teen']) {
    assert.equal(detectProhibitedTerms(bad).flagged, true, `should block ${bad}`);
    assert.equal(screenPublicText(bad)?.kind, 'prohibited', `screen should refuse ${bad}`);
  }
});

test('the new rules leave honest words and adult ages alone', () => {
  for (const ok of ['therapist', 'therapists', 'draping', 'scraping', 'grapes', '18yo', '18 y/o', '19 years old',
    '21 years old', '118yo', 'I have 5 years of experience', 'No one under 18', 'Nobody under 18 allowed',
    'If you are under 18, leave now', "if you're under 18 please leave", 'Not for anyone under 18', 'you know',
    // Round-3 review: ordinary adult text the first version of this rule refused.
    'If you\u2019re under 18, leave', 'Minors (under 18) are not allowed', '18+ only. Under 18? Leave.',
    'users under 18 banned', 'under 18s not welcome', 'my 2 year old cat', '3 years old page anniversary',
    "I'm 1 year old on here", 'my dog is 12 years old', 'this account is 15 years old', '9 year old',
    "I'm 21 years old", 'she is 19 yrs old']) {
    assert.equal(detectProhibitedTerms(ok).flagged, false, `should allow ${ok}`);
  }
});

// Round-3 accounts#3: Romance-language words that contain "rape".
test('terapeuta, rapero/rapera and frape are not refused as "rape"', () => {
  for (const ok of ['Ex terapeuta, ahora creadora', 'terapeutico', 'soy rapero', 'raperas', 'frapé lover']) {
    assert.equal(detectProhibitedTerms(ok).flagged, false, `should allow ${ok}`);
  }
  // Whole-word only: a glued "rape roleplay" is still caught.
  for (const bad of ['raperoleplay', 'rapefantasy', 'frapeteen']) {
    assert.equal(detectProhibitedTerms(bad).flagged, true, `should block ${bad}`);
  }
});

// Round-3 accounts#2: a creator's own handle is screened without its "@", so a
// contact-app word inside it is not read as a handover to that app.
test('handles are screened without their leading @', () => {
  const entries = publicProfileTextEntries({ handle: '@snap_queen' });
  assert.deepEqual(entries, [['handle', 'snap_queen']]);
  for (const h of ['@snap_queen', '@oh.snap', '@signal_girl', '@mia_ig']) {
    for (const [, value] of publicProfileTextEntries({ handle: h })) {
      assert.equal(screenPublicText(value), null, `handle ${h} should be allowed`);
    }
  }
  // Prohibited terms inside a handle are still refused.
  const [[, v]] = publicProfileTextEntries({ handle: '@hotteen' });
  assert.equal(screenPublicText(v)?.kind, 'prohibited');
  // And a real handover in a bio is still caught.
  assert.equal(screenPublicText('add my snap @janedoe99')?.kind, 'payment');
});

// Round-4 accounts#3: noun forms, the spaced "jail bait", spelled-out ages and
// stretched letters.
test('blocks noun forms, jail bait, spelled-out minor ages and stretched letters', () => {
  for (const bad of ['pedophilia', 'paedophilia', 'paedo', 'molestation', 'zoophile', 'jail bait', 'pthc',
    'seventeen year old girl', 'sixteen years old schoolgirl', "i'm seventeen", 'im seventeen', 'aged sixteen',
    'she is fifteen years old', 'i am sixteen yo', 'teeen', 'teeeeens', 'i just turned 16', 'I turned 15.',
    'hot 16yo', 'new 17yo set', '16yo', '#17yo']) {
    assert.equal(detectProhibitedTerms(bad).flagged, true, `should block ${bad}`);
  }
});

// Round-4 accounts#8: non-person text the under-18 rule used to refuse.
test('the age rule leaves products, "yo mama" and non-person subjects alone', () => {
  for (const ok of ['Toyota 12yo', 'Rolling 10yo', 'Top 10 yo mama jokes', 'My Kia is 11 yo lol',
    'aged 12 years old single malt', 'My blog turned 15 years old today', 'Brand turned 12 yrs old',
    'sipping a Macallan 12yo and watching your new set', "I'm fifteen minutes away", 'ten minutes of teasing',
    'I have sixteen new photos', 'coffee', 'bookkeeper', 'balloon']) {
    assert.equal(detectProhibitedTerms(ok).flagged, false, `should allow ${ok}`);
  }
});

// Round-4 accounts#1: a phone number inside a handle or username.
test('a handle or username carrying a phone number is refused', () => {
  for (const bad of ['text-617-555-1234', 'call.6175551234', 'jane_617_555_1234', '@text-617-555-1234']) {
    assert.equal(looksLikePhoneNumber(bad), true, `should refuse ${bad}`);
    if (bad.startsWith('@') || /^[A-Za-z0-9._-]+$/.test(bad)) assert.ok(normalizeHandle(bad).error, `handle ${bad}`);
  }
  for (const ok of ['jane2000', 'mia_1999', 'user.12345', 'club_2026_09']) {
    assert.equal(looksLikePhoneNumber(ok), false, `should allow ${ok}`);
  }
});
