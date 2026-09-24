import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferContentType,
  preflightUpload,
  responseErrorMessage,
  dollarsToCents,
  dmPriceCentsFromInput,
  payoutWalletError,
  draftFromCreator,
  profileFieldsFromDraft,
  payoutStatusDisplay,
  cashOutBlockedReason,
} from '../components/dashboard/helpers.js';
import { sanitizeDmPriceCents, sanitizePayoutFields } from './field-validation.js';
import { mediaKindFor, maxBytesFor } from './upload-guard.js';

/**
 * Pure helpers behind the creator dashboard (components/dashboard/*). No DB.
 * The point of most of these cases: whatever the dashboard sends must be
 * something the server-side validators accept, and whatever they refuse the
 * dashboard must refuse first with the same meaning.
 */

test('inferContentType recovers a missing browser type from an allowlisted extension only', () => {
  assert.equal(inferContentType({ type: 'image/jpeg', name: 'a.jpg' }), 'image/jpeg');
  assert.equal(inferContentType({ type: '', name: 'IMG_0001.HEIC' }), 'image/heic');
  assert.equal(inferContentType({ type: '', name: 'clip.mov' }), 'video/quicktime');
  assert.equal(inferContentType({ type: 'video/mp4; codecs=avc1', name: 'x' }), 'video/mp4');
  assert.equal(inferContentType({ type: '', name: 'page.html' }), null);
  assert.equal(inferContentType({ type: 'image/svg+xml', name: 'x.svg' }), 'image/svg+xml');
  // ...and svg is then refused by the same allowlist the server uses.
  assert.ok(preflightUpload('gallery', 'image/svg+xml', 10));
});

test('preflightUpload mirrors the upload-token route checks', () => {
  assert.equal(preflightUpload('gallery', 'image/png', 1000), null);
  assert.equal(preflightUpload('listing', 'video/mp4', 1000), null);
  assert.match(preflightUpload('avatar', 'video/mp4', 1000), /image/i);
  assert.ok(preflightUpload('gallery', null, 1000));
  assert.ok(preflightUpload('gallery', 'image/png', 0));
  const max = maxBytesFor('gallery', 'video/mp4');
  assert.equal(preflightUpload('gallery', 'video/mp4', max), null);
  assert.match(preflightUpload('gallery', 'video/mp4', max + 1), /too large/);
  assert.match(preflightUpload('avatar', 'image/png', maxBytesFor('avatar', 'image/png') + 1), /too large/);
  // Every type the preflight accepts is one the server accepts for that purpose.
  for (const t of ['image/jpeg', 'image/heic', 'video/webm']) {
    for (const p of ['gallery', 'avatar', 'listing']) {
      assert.equal(preflightUpload(p, t, 1) === null, !!mediaKindFor(p, t), `${p} ${t}`);
    }
  }
});

test('responseErrorMessage prefers the server message and survives a non-JSON body', () => {
  assert.equal(responseErrorMessage(400, { error: 'Bad handle' }), 'Bad handle');
  assert.equal(responseErrorMessage(413, null), 'That file is too large.');
  assert.equal(responseErrorMessage(413, { error: 'That file is too large (50MB maximum).' }), 'That file is too large (50MB maximum).');
  assert.match(responseErrorMessage(401, null), /log in/i);
  assert.match(responseErrorMessage(429, null), /too many/i);
  assert.equal(responseErrorMessage(500, null, 'Fallback'), 'Fallback');
  assert.equal(responseErrorMessage(500, { error: {} }, 'Fallback'), 'Fallback');
});

test('dollarsToCents accepts plain dollar amounts only', () => {
  assert.equal(dollarsToCents('12'), 1200);
  assert.equal(dollarsToCents('12.5'), 1250);
  assert.equal(dollarsToCents('0.99'), 99);
  assert.equal(dollarsToCents(' 3.07 '), 307);
  assert.equal(dollarsToCents(4.2), 420);
  for (const bad of ['', '1e3', '12.345', '-5', 'abc', '1,000', null, undefined, {}]) {
    assert.equal(dollarsToCents(bad), null, String(bad));
  }
});

test('dm price input: blank means the floor, and every value sent is one the server accepts', () => {
  assert.deepEqual(dmPriceCentsFromInput(''), { value: null });
  assert.deepEqual(dmPriceCentsFromInput('  '), { value: null });
  assert.deepEqual(dmPriceCentsFromInput('0.99'), { value: 99 });
  assert.deepEqual(dmPriceCentsFromInput('5'), { value: 500 });
  assert.deepEqual(dmPriceCentsFromInput('500'), { value: 50000 });
  for (const bad of ['0.98', '500.01', 'x', '-1', '1.234']) {
    assert.ok(dmPriceCentsFromInput(bad).error, bad);
  }
  for (const ok of ['', '0.99', '1', '12.34', '500']) {
    const { value } = dmPriceCentsFromInput(ok);
    assert.deepEqual(sanitizeDmPriceCents(value), { value }, ok);
  }
});

test('payout wallet check agrees with the server validator', () => {
  const good = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  for (const w of ['', '  ', good, good.toLowerCase()]) {
    assert.equal(payoutWalletError(w), null, w);
    assert.equal(sanitizePayoutFields({ walletAddress: w }), null, w);
  }
  for (const w of ['0x123', 'bc1qxyz', 'my wallet', `${good}00`]) {
    assert.ok(payoutWalletError(w), w);
    assert.ok(sanitizePayoutFields({ walletAddress: w }), w);
  }
});

test('draft round-trip never sends img or payoutMethod, and resyncs server-normalised values', () => {
  const creator = {
    id: '7',
    name: 'Mia',
    handle: '@mia',
    bio: 'hi',
    tags: ['gym', 'asmr'],
    img: '/api/media/avatars/7/abc.jpg',
    payoutMethod: 'eth',
    walletAddress: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    locked: true,
    gateTokens: 2500,
    dmPriceCents: 250,
    socials: { twitter: 'mia' },
  };
  const draft = draftFromCreator(creator);
  assert.equal(draft.tags, 'gym, asmr');
  assert.equal(draft.dmPrice, '2.50');
  assert.equal(draft.gateTokens, 2500);
  assert.equal(draft.handle, '@mia');
  assert.equal(draft.socials.instagram, '');
  assert.ok(!('img' in draft));
  assert.ok(!('payoutMethod' in draft));

  const { fields, error } = profileFieldsFromDraft(draft);
  assert.equal(error, undefined);
  assert.ok(!('img' in fields));
  assert.ok(!('payoutMethod' in fields));
  assert.ok(!('dmPrice' in fields));
  assert.equal(fields.dmPriceCents, 250);

  assert.equal(profileFieldsFromDraft({ ...draft, dmPrice: '' }).fields.dmPriceCents, null);
  assert.ok(profileFieldsFromDraft({ ...draft, dmPrice: '0.10' }).error);
  assert.ok(profileFieldsFromDraft({ ...draft, walletAddress: '0xnope' }).error);
  assert.equal(profileFieldsFromDraft({ ...draft, walletAddress: `  ${creator.walletAddress} ` }).fields.walletAddress, creator.walletAddress);

  // A creator with no stored DM price shows a blank (= floor) box, not "0.00".
  assert.equal(draftFromCreator({ dmPriceCents: null }).dmPrice, '');
  assert.equal(draftFromCreator(null).name, '');
});

test('payout status labels include rejected', () => {
  assert.equal(payoutStatusDisplay('paid').label, 'Paid');
  assert.equal(payoutStatusDisplay('rejected').label, 'Declined');
  assert.equal(payoutStatusDisplay('pending').label, 'Pending review');
});

test('cash-out is offered only to active, non-demo creators', () => {
  const c = { id: '1' };
  assert.equal(cashOutBlockedReason(c, 'active'), null);
  assert.match(cashOutBlockedReason(c, 'pending'), /approved/);
  assert.match(cashOutBlockedReason(c, 'suspended'), /held/);
  assert.match(cashOutBlockedReason(c, 'banned'), /never paid/);
  assert.match(cashOutBlockedReason({ ...c, seed: true }, 'active'), /Demo/);
  assert.match(cashOutBlockedReason({ ...c, demo: true }, 'active'), /Demo/);
  assert.ok(cashOutBlockedReason(null, 'active'));
});
