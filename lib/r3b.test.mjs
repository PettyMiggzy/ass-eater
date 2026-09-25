// Regression tests for the round-3 backend fixes (package R3B), run against a
// real scratch Postgres (it truncates tables), never mocks:
//  - the orphan sweep claims rows instead of deleting them up front: a sweep
//    that stops part-way leaves unprocessed rows in place, stale claims are
//    picked up again, and a path re-recorded mid-sweep is not dropped;
//  - removals record 'delete_pending' rows in the same commit (creator
//    delete, listing takedown, gallery/avatar replacement), and deleting a
//    creator reports the site logins it removed;
//  - checkout refuses a digital listing the buyer already owns, and carts in
//    opposite order no longer deadlock;
//  - a live creator's only §2257 record cannot be archived or unlinked
//    without explicit confirmation; URL search resolves creator/media URLs;
//  - fan accounts can be suspended/banned (credits frozen, session killed);
//  - a token gate over public-file media is never "gated";
//  - admin media cookie fingerprints are keyed, and rotate with the key;
//  - viewer marks normalise and look up.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r3b.test.mjs

import crypto from 'crypto';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
delete process.env.BRIDGE_SECRET;
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r3b';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { query, withTransaction, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const credits = await import('./credits-store.js');
const orders = await import('./orders-store.js');
const media = await import('./media.js');
const records = await import('./performer-records-store.js');
const gate = await import('./token-gate.js');
const moderation = await import('./user-moderation.js');
const viewerMark = await import('./viewer-mark.js');
const { createSessionToken, getSessionUser } = await import('./session.js');
const { default: performerRecordsRoute } = await import('../pages/api/admin/performer-records.js');
const { default: userModerationRoute } = await import('../pages/api/admin/user-moderation.js');
const { default: viewerMarkRoute } = await import('../pages/api/admin/viewer-mark.js');
const { default: reportContentRoute } = await import('../pages/api/report-content.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);
const origError = console.error;
const origWarn = console.warn;
const origInfo = console.info;
const quiet = async (fn) => {
  console.error = () => {}; console.warn = () => {}; console.info = () => {};
  try { return await fn(); } finally { console.error = origError; console.warn = origWarn; console.info = origInfo; }
};
function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; },
  };
}
let ipN = 0;
async function call(route, { method = 'POST', body, query: q = {}, admin = true } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = { 'x-forwarded-for': `10.33.0.${ipN}` };
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  await quiet(() => route({ method, body, query: q, headers, socket: { remoteAddress: `10.33.0.${ipN}` } }, res));
  return res;
}

async function reset() {
  await query('truncate creators, users, listings, orders, credit_balances, credit_ledger, payout_requests, checkout_idempotency, used_payment_tx, ncii_reports, media_uploads, performer_records restart identity');
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
let n = 0;
async function mkCreatorUser(fields = {}) {
  n++;
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r3bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r3b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r3b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
const galleryFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'gallery', creatorId, contentType: 'image/jpeg' }));
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
const pendingRows = async () => (await query('select pathname, reason, claim_token from media_uploads order by pathname')).rows;
const itemFor = (listing, creatorUser) => ({
  listingId: listing.id, creatorId: listing.creatorId, creatorUserId: creatorUser.id,
  priceCents: listing.priceCents, shippingCents: 0, kind: 'digital', unlimited: true, title: listing.title,
});

await reset();

section('Orphan sweep claims rows; nothing is lost when it stops part-way');
{
  const paths = ['a', 'b', 'c'].map(() => media.newMediaPathname({ purpose: 'gallery', creatorId: '1', contentType: 'image/jpeg' }));
  for (const p of paths) await media.recordPendingMediaPath(p, 'delete_failed');
  await query(`update media_uploads set created_at = now() - interval '2 hours'`);

  const none = await media.sweepOrphanedMedia({ timeBudgetMs: -1, deleteFile: async () => { throw new Error('must not run'); } });
  check('a sweep out of time processes nothing and hands the rows back', none.checked === 0 && none.remaining === 3, JSON.stringify(none));
  let rows = await pendingRows();
  check('...and every row is still there, unclaimed', rows.length === 3 && rows.every((r) => r.claim_token === null));

  // A sweep killed after claiming (no release): the claim is stale later.
  await query(`update media_uploads set claimed_at = now(), claim_token = 'dead-sweep'`);
  const blocked = await media.sweepOrphanedMedia({ deleteFile: async () => {} });
  check('a fresh claim held by another sweep is skipped', blocked.checked === 0);
  await query(`update media_uploads set claimed_at = now() - interval '20 minutes'`);
  const deleted = [];
  const recovered = await media.sweepOrphanedMedia({ deleteFile: async (p) => { deleted.push(p); } });
  check('a stale claim is picked up again', recovered.checked === 3 && recovered.deleted === 3 && deleted.length === 3, JSON.stringify(recovered));
  check('processed rows are gone', (await pendingRows()).length === 0);

  // Re-recorded while a sweep holds it: the sweep must not drop the new row.
  const p = paths[0];
  await media.recordPendingMediaPath(p, 'token');
  await query(`update media_uploads set created_at = now() - interval '2 hours'`);
  const out = await media.sweepOrphanedMedia({
    deleteFile: async (x) => { await media.recordPendingMediaPath(x, 'delete_failed'); },
  });
  rows = await pendingRows();
  check('a path re-recorded mid-sweep survives it', out.checked === 1 && rows.length === 1 && rows[0].reason === 'delete_failed', JSON.stringify(rows));
}

section('Removals record their files for the sweep in the same commit');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const g = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g }, []);
  const avatar = media.mediaSrc(media.newMediaPathname({ purpose: 'avatar', creatorId: creator.id, contentType: 'image/jpeg' }));
  await creators.setCreatorAvatar(creator.id, avatar, { performers: { othersAppear: false, attestedAt: 'x' } });
  const l = await mkListing(creator.id);
  await query('delete from media_uploads');

  const out = await quiet(() => creators.deleteCreator(creator.id));
  const rows = await pendingRows();
  const recorded = new Set(rows.map((r) => r.pathname));
  check('deleting a creator records avatar, gallery and listing files',
    [avatar, g, l.media[0].src].every((src) => recorded.has(src.replace('/api/media/', ''))), JSON.stringify(rows));
  check('...and reports the site login it removed', out.removedUserIds.length === 1 && out.removedUserIds[0] === String(user.id), JSON.stringify(out.removedUserIds));

  await reset();
  const { creator: c2 } = await mkCreatorUser();
  const l2 = await mkListing(c2.id);
  await query('delete from media_uploads');
  await quiet(() => listings.markListingRemoved(l2.id));
  check('a listing takedown records its files', (await pendingRows()).some((r) => r.pathname === l2.media[0].src.replace('/api/media/', '')));

  await query('delete from media_uploads');
  const g2 = galleryFile(c2.id);
  await creators.addGalleryItem(c2.id, { type: 'image', src: g2 }, []);
  await quiet(() => creators.removeGalleryItem(c2.id, { src: g2 }));
  check('a removed gallery item is recorded', (await pendingRows()).some((r) => r.pathname === g2.replace('/api/media/', '')));

  await query('delete from media_uploads');
  const { files } = await quiet(() => listings.removeListingsForCreator(c2.id, { moderation: true }));
  check('removeListingsForCreator returns the files it deleted', Array.isArray(files));

  // With the sweep claim model, recorded-but-referenced rows are simply forgotten.
  const keep = galleryFile(c2.id);
  await creators.addGalleryItem(c2.id, { type: 'image', src: keep }, []);
  await media.recordPendingMediaPath(keep.replace('/api/media/', ''), 'delete_pending');
  await query(`update media_uploads set created_at = now() - interval '2 hours'`);
  const sw = await media.sweepOrphanedMedia({ deleteFile: async () => { throw new Error('must not delete a referenced file'); } });
  check('a referenced file is never deleted by the sweep', sw.kept === 1 && sw.failed === 0, JSON.stringify(sw));
}

section('Checkout: already-owned digital items are refused; opposite-order carts do not deadlock');
{
  await reset();
  const { creator: x, user: xu } = await mkCreatorUser();
  const { creator: y, user: yu } = await mkCreatorUser();
  const lx = await mkListing(x.id, { priceCents: 700 });
  const ly = await mkListing(y.id, { priceCents: 300 });
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'test' });
  await orders.createOrdersFromCredits({ buyerId: fan.id, items: [itemFor(lx, xu)], ageConfirmed: true, tosAccepted: true });
  const before = await credits.getBalanceCents(fan.id);
  let code = null;
  try {
    await orders.createOrdersFromCredits({ buyerId: fan.id, items: [itemFor(lx, xu)], ageConfirmed: true, tosAccepted: true });
  } catch (err) { code = err.code; }
  check('buying an owned unlimited digital listing again is refused', code === orders.ALREADY_OWNED, String(code));
  check('...and nothing is charged', (await credits.getBalanceCents(fan.id)) === before);

  const a = await mkFan();
  const b = await mkFan();
  await credits.creditAccount({ userId: a.id, cents: 5000, type: 'test' });
  await credits.creditAccount({ userId: b.id, cents: 5000, type: 'test' });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => {
    const fanI = i % 2 ? a : b;
    const cart = i % 2 ? [itemFor(lx, xu), itemFor(ly, yu)] : [itemFor(ly, yu), itemFor(lx, xu)];
    return orders.createOrdersFromCredits({ buyerId: fanI.id, items: cart, ageConfirmed: true, tosAccepted: true, idempotencyKey: `k${i}` });
  }));
  const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.code || r.reason?.message);
  check('opposite-order carts: no deadlock errors', !failures.some((c) => c === '40P01'), JSON.stringify(failures));
  check('...one purchase each, the repeats refused as already owned',
    results.filter((r) => r.status === 'fulfilled').length === 2 && failures.every((c) => c === orders.ALREADY_OWNED), JSON.stringify(failures));
}

section('§2257: a live creator cannot silently lose their only record');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const rec = await records.createPerformerRecord({ legalName: 'Jane Q', dateOfBirth: '1990-01-01', aliases: ['JaneX'], creatorId: String(creator.id), documentLocation: 'offline' });
  let res = await call(performerRecordsRoute, { body: { action: 'archive', id: rec.id, reason: 'typo' } });
  check('archiving the only record of a live creator is refused (409)', res.statusCode === 409 && res.body.code === records.RECORD_REQUIRED_BY_LIVE_CREATOR, JSON.stringify(res.body));
  res = await call(performerRecordsRoute, { body: { action: 'update', id: rec.id, fields: { creatorId: null } } });
  check('unlinking it is refused too', res.statusCode === 409, JSON.stringify(res.body));
  res = await call(performerRecordsRoute, { body: { action: 'update', id: rec.id, fields: { aliases: ['JaneX', 'JQ'] } } });
  check('an unrelated edit still saves', res.statusCode === 200, JSON.stringify(res.body));

  const replacement = await records.createPerformerRecord({ legalName: 'Jane Q', dateOfBirth: '1990-01-02', aliases: ['JaneX'], creatorId: String(creator.id), documentLocation: 'offline' });
  res = await call(performerRecordsRoute, { body: { action: 'archive', id: rec.id, reason: 'typo' } });
  check('once the corrected record is linked, the old one archives', res.statusCode === 200, JSON.stringify(res.body));
  res = await call(performerRecordsRoute, { body: { action: 'archive', id: replacement.id, reason: 'x', confirmUnrecordedLiveCreator: true } });
  check('explicit confirmation overrides', res.statusCode === 200, JSON.stringify(res.body));

  const { creator: pend } = await mkCreatorUser({ status: 'pending' });
  const pr = await records.createPerformerRecord({ legalName: 'P', dateOfBirth: '1990-01-01', creatorId: String(pend.id), documentLocation: 'offline' });
  res = await call(performerRecordsRoute, { body: { action: 'archive', id: pr.id, reason: 'x' } });
  check('a pending creator\'s record archives freely', res.statusCode === 200);

  const { creator: live } = await mkCreatorUser();
  const lr = await records.createPerformerRecord({ legalName: 'Mia R', dateOfBirth: '1991-01-01', aliases: ['Mia'], creatorId: String(live.id), documentLocation: 'offline' });
  const co = await records.createPerformerRecord({ legalName: 'Co Star', dateOfBirth: '1992-01-01', aliases: ['CoS'], documentLocation: 'offline' });
  const src = galleryFile(live.id);
  await creators.addGalleryItem(live.id, { type: 'image', src, performers: { othersAppear: true, coPerformerRecordIds: [String(co.id)] } }, []);
  const byPage = await records.searchPerformerRecords(`https://www.joinonlyone.com/creator/${live.id}`);
  check('a creator page URL finds the linked record', byPage.some((r) => String(r.id) === String(lr.id)) && !byPage.some((r) => String(r.id) === String(co.id)));
  const byMedia = await records.searchPerformerRecords(`https://www.joinonlyone.com${src}?x=1`);
  const ids = byMedia.map((r) => String(r.id));
  check('a media URL finds the creator AND the co-performer on that item', ids.includes(String(lr.id)) && ids.includes(String(co.id)), JSON.stringify(ids));
  res = await call(performerRecordsRoute, { method: 'GET', query: { q: `/creator/${live.id}` } });
  check('GET ?q= searches server-side', res.statusCode === 200 && res.body.records.some((r) => String(r.id) === String(lr.id)));
}

section('Fan account moderation');
{
  await reset();
  const fan = await mkFan();
  const { creator, user: cu } = await mkCreatorUser();
  const l = await mkListing(creator.id);
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'test' });
  let res = await call(userModerationRoute, { body: { userId: fan.id, action: 'suspend', days: 7 } });
  check('admin suspends a fan', res.statusCode === 200 && res.body.user.status === 'suspended', JSON.stringify(res.body));
  const suspended = await users.findUserById(fan.id);
  check('a suspended fan is restricted from writing', !!moderation.userWriteRestriction(suspended));
  let code = null;
  try {
    await orders.createOrdersFromCredits({ buyerId: fan.id, items: [itemFor(l, cu)], ageConfirmed: true, tosAccepted: true });
  } catch (err) { code = err.code; }
  check("a suspended fan's credits are frozen at checkout", code === credits.ACCOUNT_FROZEN, String(code));
  check('the standing reads frozen', credits.isFrozenStanding(await credits.accountStanding(fan.id)));

  const token = createSessionToken(fan.id, Number(suspended.sessionVersion || 0));
  const req = { headers: { cookie: `oa_session=${encodeURIComponent(token)}` } };
  check('a suspended fan is still signed in', !!(await getSessionUser(req)));
  res = await call(userModerationRoute, { body: { userId: fan.id, action: 'ban' } });
  check('admin bans the fan', res.statusCode === 200 && res.body.user.status === 'banned');
  check('the ban kills the existing session', (await getSessionUser(req)) === null);
  const bannedUser = await users.findUserById(fan.id);
  const fresh = createSessionToken(fan.id, Number(bannedUser.sessionVersion || 0));
  check('...and any new one', (await getSessionUser({ headers: { cookie: `oa_session=${encodeURIComponent(fresh)}` } })) === null);
  res = await call(userModerationRoute, { body: { userId: fan.id, action: 'clear' } });
  check('clear lifts it', res.statusCode === 200 && res.body.user.status === 'active');
  res = await call(userModerationRoute, { body: { userId: cu.id, action: 'ban' } });
  check('a creator account is refused (use the creator profile)', res.statusCode === 400);
  res = await call(userModerationRoute, { body: { userId: fan.id, action: 'ban' }, admin: false });
  check('admin key required', res.statusCode === 401 || res.statusCode === 403, String(res.statusCode));
  check('a lapsed suspension reads active', moderation.effectiveUserStatus({ moderationStatus: 'suspended', moderationUntil: new Date(Date.now() - 1000).toISOString() }) === 'active');
}

section('Token gate: only enforceable over private media');
{
  const priv = { locked: true, gateTokens: 1000, gallery: [{ src: '/api/media/gallery/7/a.jpg' }] };
  check('private uploads can be gated', gate.isTokenGated(priv));
  check('public-file gallery is never "gated"', !gate.isTokenGated({ ...priv, gallery: [{ src: '/images/diesel_1.jpg' }] }));
  check('a demo creator is never gated', !gate.isTokenGated({ ...priv, demo: true }) && !gate.isTokenGated({ ...priv, seed: true }));
  check('turning a gate on for a demo is refused', !!gate.refusesUnenforceableGate({ seed: true, gallery: [] }, { locked: true, gateTokens: 5 }));
  check('an echo of an existing setting is not', gate.refusesUnenforceableGate({ seed: true, locked: true, gateTokens: 5 }, { locked: true, gateTokens: 5 }) === null);
  check('turning a gate off is never refused', gate.refusesUnenforceableGate({ seed: true, locked: true, gateTokens: 5 }, { locked: false }) === null);
  check('a real creator may gate', gate.refusesUnenforceableGate({ gallery: [{ src: '/api/media/gallery/1/a.jpg' }] }, { locked: true, gateTokens: 5 }) === null);
  // Round-3 review: enforcement fails CLOSED. A gated real creator carrying
  // one legacy public-file src is not SHOWN as gated, but every private
  // upload is still withheld and still needs a holder.
  const mixed = { locked: true, gateTokens: 1000, gallery: [{ type: 'image', src: '/api/media/gallery/7/a.jpg' }, { type: 'image', src: '/images/legacy.jpg' }], video: '/api/media/gallery/7/v.mp4' };
  check('mixed media: the raw setting still reads as configured', gate.gateConfigured(mixed) && !gate.isTokenGated(mixed));
  check('mixed media: the gate decision is not "not_gated"', gate.tokenGateDecision(mixed, null).allowed === false);
  const creatorStatus = await import('./creator-status.js');
  const mixedPub = creatorStatus.toPublicCreator(mixed);
  check('mixed media: the private upload is withheld', mixedPub.gallery[0].locked === true && mixedPub.gallery[0].src === undefined);
  check('mixed media: the public site file is not padlocked', mixedPub.gallery[1].src === '/images/legacy.jpg' && !mixedPub.gallery[1].locked);
  check('mixed media: the private hero video is withheld', mixedPub.video === null);
  check('a demo gate setting still withholds private uploads', creatorStatus.toPublicCreator({ ...mixed, seed: true }).gallery[0].locked === true);
}

section('Admin media cookie fingerprint is keyed and rotates');
{
  const t = media.createAdminMediaToken();
  check('a fresh admin media token verifies', media.verifyAdminMediaToken(t));
  const payload = JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
  const plain = crypto.createHash('sha256').update(`oa:admin-media-key:${process.env.ADMIN_UPLOAD_KEY}`).digest('hex').slice(0, 32);
  check('the fingerprint is not a plain hash of the key', payload.kf !== plain && payload.kf.length === 22);
  process.env.ADMIN_UPLOAD_KEY = 'rotated-key';
  check('rotating ADMIN_UPLOAD_KEY retires the cookie', !media.verifyAdminMediaToken(t));
  process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r3b';
}

section('Viewer-mark lookup');
{
  await reset();
  const fan = await mkFan();
  const code = viewerMark.viewerMarkFor(fan.id);
  check('normalise: no dash, lowercase, prefix', viewerMark.normalizeViewerMark(`onlyone ${code.replace('-', '').toLowerCase()}`) === code);
  check('normalise refuses junk', viewerMark.normalizeViewerMark('zzzz') === null && viewerMark.normalizeViewerMark({}) === null);
  let res = await call(viewerMarkRoute, { body: { code: code.toLowerCase() } });
  check('the lookup finds the account', res.statusCode === 200 && res.body.match.userId === String(fan.id), JSON.stringify(res.body));
  res = await call(viewerMarkRoute, { body: { code: '0000-0000' } });
  check('an unknown mark is a 404', res.statusCode === 404);
  res = await call(viewerMarkRoute, { body: { code }, admin: false });
  check('admin key required', res.statusCode === 401 || res.statusCode === 403);
}

section('Takedown form: over-long input is refused, not truncated');
{
  const long = 'https://example.com/x '.repeat(200);
  let res = await call(reportContentRoute, { admin: false, body: { reporterName: 'V', reporterContact: 'v@x.co', contentLocation: long, consentStatement: true } });
  check('over the limit -> 400 naming the field', res.statusCode === 400 && res.body.field === 'contentLocation', JSON.stringify(res.body));
  const seven = 'https://example.com/content/1234567890 '.repeat(20); // ~800 chars, over the old 500 cut
  res = await call(reportContentRoute, { admin: false, body: { reporterName: 'V', reporterContact: 'v@x.co', contentLocation: seven, consentStatement: true } });
  check('a long location list is accepted', res.statusCode === 200, JSON.stringify(res.body));
  const { rows } = await query('select data from ncii_reports order by id desc limit 1');
  check('...and stored in full', rows[0].data.contentLocation === seven);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
