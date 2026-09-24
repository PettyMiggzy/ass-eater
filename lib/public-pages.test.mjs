import test from 'node:test';
import assert from 'node:assert/strict';
import { toPublicCreator, toPublicListing } from './creator-status.js';
import { toCreatorCard, isDemoCreator, isDemoListing, DEMO_LABEL } from '../components/public/cards.js';

/**
 * Regression tests for what the public browse pages (/home, /creators,
 * /search, /favorites, /marketplace, /creator/[id]) put in page props.
 * Page props are readable by anyone in __NEXT_DATA__ and /_next/data, so
 * "the page doesn't render it" is not protection -- these check the data.
 */

const gated = {
  id: 7,
  name: 'Gated',
  handle: '@gated',
  img: '/api/media/avatars/7/a.jpg',
  video: '/api/media/gallery/7/hero.mp4',
  locked: true,
  gateTokens: 5000,
  gallery: [
    { type: 'image', src: '/api/media/gallery/7/1.jpg' },
    { type: 'video', src: '/api/media/gallery/7/2.mp4' },
  ],
  walletAddress: '0x0000000000000000000000000000000000000001',
  status: 'active',
};

const open = {
  id: 8,
  name: 'Open',
  handle: '@open',
  img: '/images/demo_female_avatar.jpg',
  video: null,
  gallery: [{ type: 'image', src: '/images/demo_female_1.jpg' }],
  status: 'active',
  seed: true,
};

function deepStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => deepStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => deepStrings(v, out));
  return out;
}

test('a gated creator card carries no media src at all, only counts and the gate label', () => {
  const card = toCreatorCard(toPublicCreator(gated));
  const strings = deepStrings(card);
  assert.ok(!strings.some((s) => s.includes('/gallery/')), 'no gallery or hero src on the card');
  assert.equal(card.video, null);
  assert.equal(card.galleryCount, 2);
  assert.equal(card.gated, true);
  assert.match(card.gateLabel, /5,000 \$ONLYONE/);
  assert.equal('gallery' in card, false);
  assert.equal('walletAddress' in card, false);
});

test('even an unlocked projection of a gated creator yields a card without the hero video', () => {
  const card = toCreatorCard(toPublicCreator(gated, { viewerMayUnlock: true }));
  assert.equal(card.video, null);
});

test('the profile projection of a gated creator strips srcs unless the server unlocked it', () => {
  const locked = toPublicCreator(gated);
  assert.ok(locked.gallery.every((g) => g.locked === true && !('src' in g)));
  assert.equal(locked.video, null);
  const unlocked = toPublicCreator(gated, { viewerMayUnlock: true });
  assert.equal(unlocked.gallery[0].src, '/api/media/gallery/7/1.jpg');
});

test('cards serialise: no undefined values (getServerSideProps rejects them)', () => {
  const card = toCreatorCard(toPublicCreator({ id: 1, gallery: [] }));
  for (const [k, v] of Object.entries(card)) assert.notEqual(v, undefined, `card.${k} is undefined`);
});

test('seed and demo creators are demo; ordinary creators are not', () => {
  assert.equal(isDemoCreator(open), true);
  assert.equal(isDemoCreator({ id: 2, demo: true }), true);
  assert.equal(isDemoCreator(gated), false);
  assert.equal(isDemoCreator(null), false);
  assert.equal(toCreatorCard(toPublicCreator(open)).demo, true);
  assert.equal(DEMO_LABEL, 'Demo — not for sale');
});

test('a listing is demo if it or its creator is', () => {
  assert.equal(isDemoListing({ id: 1, demo: true }, gated), true);
  assert.equal(isDemoListing({ id: 1 }, open), true);
  assert.equal(isDemoListing({ id: 1 }, gated), false);
  assert.equal(isDemoListing(null, open), false);
});

test('public listings carry previews and no media src', () => {
  const pub = toPublicListing({
    id: 3,
    title: 'Set',
    media: [
      { type: 'video', src: '/api/media/listings/7/3/x.mp4', preview: 'data:image/jpeg;base64,AAAA' },
      { type: 'image', src: '/api/media/listings/7/3/y.jpg', preview: 'https://evil.example/x.jpg' },
    ],
  });
  assert.ok(!deepStrings(pub).some((s) => s.includes('/api/media/')));
  assert.equal(pub.media[0].preview, 'data:image/jpeg;base64,AAAA');
  assert.equal(pub.media[1].preview, null, 'a non-data-URL preview is dropped');
  assert.equal(pub.mediaCount, 2);
});
