// Regression tests for the round-2 backend fixes (package R2B1), run against a
// real scratch Postgres (it truncates tables), never mocks:
//  - the NCII resolve path uses THE content-violation ladder: a hand-banned
//    creator stays banned, a pending applicant stays pending, and a ban ends
//    Founding Creator status;
//  - toPublicCreator is an allowlist: moderation history and any unknown
//    internal field never reach a public page;
//  - a manual ban / creator deletion keeps the files of listings buyers paid
//    for (unlimited ones included), deletes the rest, and delivery/media keep
//    serving those buyers; a content takedown still deletes everything;
//  - a creator can remove one item from a listing; after a sale it is kept for
//    the buyers who paid before the removal and nobody else;
//  - checkout refuses a digital listing with no files and a demo listing;
//  - demo (not only seed) creators cannot be paid;
//  - the founding slot cap is atomic and banned founders do not hold slots;
//  - orphaned uploads are swept; referenced ones are kept;
//  - chain-verify sums every qualifying deposit transfer and can require an
//    exact payout amount.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r2b1.test.mjs

import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r2b1';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';

const { query, withTransaction, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const credits = await import('./credits-store.js');
const orders = await import('./orders-store.js');
const ncii = await import('./ncii-reports-store.js');
const media = await import('./media.js');
const founding = await import('./founding.js');
const chain = await import('./chain-verify.js');
const status = await import('./creator-status.js');
const { createSessionToken } = await import('./session.js');
const { default: deliveryRoute } = await import('../pages/api/marketplace/orders/delivery.js');
const { default: mediaRoute } = await import('../pages/api/media/[...path].js');
const { default: adminProfile } = await import('../pages/api/admin/profile.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);

const origError = console.error;
const origWarn = console.warn;
const quiet = async (fn) => {
  console.error = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { console.error = origError; console.warn = origWarn; }
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
const cookieFor = (u) => `oa_session=${encodeURIComponent(createSessionToken(u.id, 0))}`;
async function delivery(orderId, user) {
  const res = fakeRes();
  await quiet(() => deliveryRoute({ method: 'GET', query: { orderId: String(orderId) }, headers: { cookie: cookieFor(user) }, socket: {} }, res));
  return res;
}
// 404 = refused before touching storage; anything else (no blob token here, so
// an entitled request fails later in sendMedia) = entitled.
async function mediaServed(src, user) {
  const pathname = src.replace('/api/media/', '');
  const res = fakeRes();
  await quiet(() => mediaRoute({ method: 'GET', query: { path: pathname.split('/') }, headers: user ? { cookie: cookieFor(user) } : {}, socket: {} }, res));
  return res.statusCode !== 404;
}
let ipN = 0;
async function adminSave(body) {
  ipN++;
  const res = fakeRes();
  await quiet(() => adminProfile({
    method: 'POST',
    body,
    headers: { 'x-admin-key': process.env.ADMIN_UPLOAD_KEY, 'x-forwarded-for': `10.9.0.${ipN}` },
    socket: { remoteAddress: `10.9.0.${ipN}` },
  }, res));
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r2b1c${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r2b1.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r2b1.test`, password: 'password123', role: 'fan' });
}
const fileFor = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
async function mkListing(creatorId, fields = {}, files = 1) {
  let l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  for (let i = 0; i < files; i++) l = await listings.addListingMedia(l.id, { type: 'image', src: fileFor(creatorId, l.id) });
  return l;
}
async function paidOrder(listing, buyer, createdAt = new Date().toISOString()) {
  const { rows } = await query('insert into orders (data) values ($1) returning id', [
    { listingId: listing.id, creatorId: listing.creatorId, buyerId: buyer.id, kind: 'digital', status: 'fulfilled', createdAt },
  ]);
  return rows[0].id;
}

await reset();

section('NCII resolve uses the one ladder (pending stays pending, banned stays banned)');
{
  const banned = await creators.createCreator({ name: 'Hand banned', handle: '@handbanned', status: 'banned' });
  const r1 = await ncii.addNciiReport({ reporterName: 'V', reporterContact: 'v@x.co', contentLocation: 'a', consentStatement: true });
  const out1 = await quiet(() => ncii.resolveNciiReport(r1.id, 'removed', { creatorId: banned.id }));
  check('a hand-banned creator stays banned', out1.creator.status === 'banned' && !out1.creator.suspendedUntil, JSON.stringify(out1.creator));

  const pending = await creators.createCreator({ name: 'Applicant', handle: '@applicant', status: 'pending' });
  const r2 = await ncii.addNciiReport({ reporterName: 'W', reporterContact: 'w@x.co', contentLocation: 'b', consentStatement: true });
  const out2 = await ncii.resolveNciiReport(r2.id, 'removed', { creatorId: pending.id });
  check('a pending applicant stays pending (never a self-lifting suspension)',
    out2.creator.status === 'pending' && out2.creator.contentViolationCount === 1 && !out2.creator.suspendedUntil, JSON.stringify(out2.creator));

  const founder = await creators.createCreator({ name: 'Founder', handle: '@founder', status: 'active', founding: true, foundingSince: new Date().toISOString() });
  const r3 = await ncii.addNciiReport({ reporterName: 'X', reporterContact: 'x@x.co', contentLocation: 'c', consentStatement: true });
  const out3 = await ncii.resolveNciiReport(r3.id, 'removed', { creatorId: founder.id });
  check('an active creator is suspended on the first report', out3.creator.status === 'suspended' && typeof out3.creator.suspendedUntil === 'string');
  check('a suspension keeps the Founding badge', out3.creator.founding === true);
  const r4 = await ncii.addNciiReport({ reporterName: 'Y', reporterContact: 'y@x.co', contentLocation: 'd', consentStatement: true });
  const out4 = await quiet(() => ncii.resolveNciiReport(r4.id, 'removed', { creatorId: founder.id }));
  check('the second report bans', out4.creator.status === 'banned' && out4.creator.contentViolationCount === 2);
  check('a ban ends Founding status and records the revocation',
    out4.creator.founding === false && out4.creator.foundingSince === null && typeof out4.creator.foundingRevokedAt === 'string', JSON.stringify(out4.creator));
}

section('toPublicCreator is an allowlist');
{
  const raw = {
    id: '9', name: 'N', handle: '@n', bio: 'b', img: '/images/x.jpg', status: 'suspended',
    suspendedUntil: new Date(Date.now() - 1000).toISOString(), contentViolationCount: 1,
    appliedNciiReportIds: ['31'], foundingRevokedAt: '2026-01-01', foundingSince: '2026-01-01', founding: true,
    walletAddress: '0xabc', payoutMethod: 'usdg', contactEmail: 'a@b.c', someFutureInternalField: 'secret',
    gallery: [{ type: 'image', src: '/api/media/gallery/9/a.jpg', internalNote: 'x' }], tags: ['t'],
  };
  const pub = status.toPublicCreator(raw);
  for (const k of ['appliedNciiReportIds', 'foundingRevokedAt', 'foundingSince', 'contentViolationCount', 'suspendedUntil', 'walletAddress', 'payoutMethod', 'contactEmail', 'someFutureInternalField']) {
    check(`${k} never reaches a public page`, !(k in pub), JSON.stringify(pub));
  }
  check('public fields kept, lapsed suspension reads active', pub.name === 'N' && pub.founding === true && pub.status === 'active' && pub.tags[0] === 't');
  check('gallery items carry only type/src/aiGenerated', JSON.stringify(Object.keys(pub.gallery[0]).sort()) === JSON.stringify(['aiGenerated', 'src', 'type']));
  check('JSON-serialisable (no undefined values)', !Object.values(pub).some((v) => v === undefined));
}

section('Manual ban keeps paid files (unlimited included), deletes the rest');
{
  await reset();
  const { creator: seller } = await mkCreatorUser();
  const buyer = await mkFan();
  const paid = await mkListing(seller.id, { title: 'Paid unlimited', unlimited: true });
  const unpaid = await mkListing(seller.id, { title: 'Never bought' });
  const orderId = await paidOrder(paid, buyer);
  await query(`insert into performer_records (data) values ($1)`, [{ creatorId: String(seller.id), status: 'active', documentLocation: 'offline' }]);

  const res = await adminSave({ creatorId: seller.id, fields: { status: 'banned' } });
  check('manual ban saved', res.statusCode === 200, JSON.stringify(res.body));
  const p = await listings.getListingById(paid.id);
  const u = await listings.getListingById(unpaid.id);
  check('paid listing taken off sale and cannot be relisted', p.status === 'removed' && p.moderationRemoved === true);
  check('paid listing keeps its files (no mediaDeletedAt)', !p.mediaDeletedAt && p.media.length === 1, JSON.stringify(p));
  check('unpaid listing loses its files', !!u.mediaDeletedAt && u.moderationRemoved === true);
  const d = await delivery(orderId, buyer);
  check('the buyer still gets their files', d.statusCode === 200 && d.body.removed === false && d.body.items.length === 1, JSON.stringify(d.body));
  check('the media route still serves the buyer', await mediaServed(p.media[0].src, buyer));
  check('...and nobody else', !(await mediaServed(p.media[0].src, await mkFan())));
}

section('Content takedown / NCII ban still deletes everything, and delivery says so');
{
  await reset();
  const { creator: seller } = await mkCreatorUser();
  const buyer = await mkFan();
  const l = await mkListing(seller.id);
  const orderId = await paidOrder(l, buyer);
  await quiet(() => listings.removeListingsForCreator(seller.id, { moderation: true }));
  const after = await listings.getListingById(l.id);
  check('keepPaid off: even a paid listing loses its files', !!after.mediaDeletedAt);
  const d = await delivery(orderId, buyer);
  check('delivery reports a moderation removal', d.body.removed === true && d.body.removedReason === 'moderation' && d.body.items.length === 0, JSON.stringify(d.body));
  check('media route cuts the buyer off', !(await mediaServed(l.media[0].src, buyer)));
}

section('Deleting a creator keeps what buyers paid for');
{
  await reset();
  const { creator: seller } = await mkCreatorUser();
  const buyer = await mkFan();
  const paid = await mkListing(seller.id, { title: 'Bought' });
  const unpaid = await mkListing(seller.id, { title: 'Not bought' });
  const orderId = await paidOrder(paid, buyer);
  await quiet(() => creators.deleteCreator(seller.id, { force: true }));
  const p = await listings.getListingById(paid.id);
  const u = await listings.getListingById(unpaid.id);
  check('paid listing off sale but files kept', p.status === 'removed' && !p.mediaDeletedAt && !p.moderationRemoved);
  check('unpaid listing files deleted', !!u.mediaDeletedAt);
  const d = await delivery(orderId, buyer);
  check('delivery still delivers after the seller is gone', d.body.removed === false && d.body.items.length === 1, JSON.stringify(d.body));
  check('media route serves the buyer with no seller record left', await mediaServed(p.media[0].src, buyer));
  const unpaidOrder = await paidOrder(u, buyer);
  const d2 = await delivery(unpaidOrder, buyer);
  check('a deleted-seller listing without kept files reports creator_deleted, not moderation',
    d2.body.removed === true && d2.body.removedReason === 'creator_deleted', JSON.stringify(d2.body));
}

section('Owner removes one item from a listing');
{
  await reset();
  const { creator: seller } = await mkCreatorUser();
  const lone = await mkListing(seller.id, {}, 2);
  const out = await quiet(() => listings.removeListingMediaForOwner(lone.id, seller.id, lone.media[0].src));
  check('unsold: item dropped, nothing retained', out.retained === false && out.listing.media.length === 1 && !(out.listing.retainedMedia || []).length);

  const bought = await mkListing(seller.id, {}, 2);
  const early = await mkFan();
  const earlyOrder = await paidOrder(bought, early, new Date(Date.now() - 60_000).toISOString());
  const pulledSrc = bought.media[0].src;
  const out2 = await listings.removeListingMediaForOwner(bought.id, seller.id, pulledSrc);
  check('bought: item leaves the listing but is retained', out2.retained === true && out2.listing.media.length === 1 && out2.listing.retainedMedia[0].src === pulledSrc);
  check('retained items never reach the public projection', !('retainedMedia' in status.toPublicListing(out2.listing)) && status.toPublicListing(out2.listing).mediaCount === 1);
  const late = await mkFan();
  const lateOrder = await paidOrder(bought, late, new Date(Date.now() + 60_000).toISOString());
  const dEarly = await delivery(earlyOrder, early);
  const dLate = await delivery(lateOrder, late);
  check('a buyer from before the removal still receives it', dEarly.body.items.some((i) => i.src === pulledSrc) && dEarly.body.items.length === 2);
  check('a buyer after the removal does not', !dLate.body.items.some((i) => i.src === pulledSrc) && dLate.body.items.length === 1);
  check('media route: early buyer served the retained file', await mediaServed(pulledSrc, early));
  check('media route: later buyer refused the retained file', !(await mediaServed(pulledSrc, late)));

  let code = null;
  try { await listings.removeListingMediaForOwner(bought.id, seller.id, pulledSrc); } catch (e) { code = e.code; }
  check('removing an item that is gone answers MEDIA_ITEM_GONE', code === listings.MEDIA_ITEM_GONE);
  const { creator: other } = await mkCreatorUser();
  let notOwner = null;
  try { await listings.removeListingMediaForOwner(bought.id, other.id, out2.listing.media[0].src); } catch (e) { notOwner = e.message; }
  check("another creator cannot remove from someone else's listing", notOwner === 'Listing not found');
  await query(`update listings set data = data || '{"status":"sold"}'::jsonb where id = $1`, [String(bought.id)]);
  code = null;
  try { await listings.removeListingMediaForOwner(bought.id, seller.id, out2.listing.media[0].src); } catch (e) { code = e.code; }
  check('a sold listing cannot be edited', code === listings.LISTING_NOT_EDITABLE);
}

section('Checkout refuses empty digital listings and demo listings; demo creators cannot be paid');
{
  await reset();
  const { creator: seller, user: sellerUser } = await mkCreatorUser();
  const buyer = await mkFan();
  await credits.creditAccount({ userId: buyer.id, cents: 10_000, type: 'deposit' });
  const item = (l) => ({ listingId: l.id, creatorId: seller.id, creatorUserId: sellerUser.id, priceCents: 500, kind: 'digital', unlimited: true, title: l.title });

  const empty = await mkListing(seller.id, { title: 'Nothing attached' }, 0);
  let code = null;
  try { await orders.createOrdersFromCredits({ buyerId: buyer.id, items: [item(empty)], ageConfirmed: true, tosAccepted: true }); } catch (e) { code = e.code; }
  check('a digital listing with no files is refused on the locked row', code === 'LISTING_UNAVAILABLE');
  check('...and nothing was charged', (await credits.getBalanceCents(buyer.id)) === 10_000);
  const physical = await listings.createListing(seller.id, { title: 'Shirt', priceCents: 500, kind: 'physical', shippingCents: 0, unlimited: true });
  check('a physical listing needs no files', status.listingHasDeliverable(physical) === true && status.listingHasDeliverable(empty) === false);

  const demoListing = await mkListing(seller.id, { title: 'Demo item' });
  await query(`update listings set data = data || '{"demo":true}'::jsonb where id = $1`, [String(demoListing.id)]);
  code = null;
  try { await orders.createOrdersFromCredits({ buyerId: buyer.id, items: [item(demoListing)], ageConfirmed: true, tosAccepted: true }); } catch (e) { code = e.code; }
  check('a listing marked demo is refused', code === 'LISTING_UNAVAILABLE');

  const { user: demoUser, creator: demoCreator } = await mkCreatorUser({ demo: true });
  check('isDemoCreator covers demo as well as seed', status.isDemoCreator(demoCreator) && status.isDemoCreator({ seed: true }) && !status.isDemoCreator({}));
  code = null;
  try { await credits.transferWithFee({ fromUserId: buyer.id, toUserId: demoUser.id, cents: 500, feeBps: 1000, type: 'tip' }); } catch (e) { code = e.code; }
  check('a demo-flagged creator (no seed flag) cannot be paid', code === credits.RECIPIENT_UNAVAILABLE);
  check('...and reads as unable to cash out', credits.canReceiveStanding(await credits.accountStanding(demoUser.id)) === false);
}

section('Founding slots: banned founders free a slot; the cap is atomic');
{
  await reset();
  check('countFounding skips banned founders',
    founding.countFounding([{ founding: true }, { founding: true, status: 'banned' }, { founding: false }]) === 1);
  // 99 existing founders, then two concurrent grants for the last slot.
  await query(
    `insert into creators (id, data)
       select (1000 + g)::text, jsonb_build_object('name', 'F' || g, 'founding', true, 'status', 'active') from generate_series(1, 99) g`,
  );
  const a = await creators.createCreator({ name: 'A', handle: '@slota', status: 'active' });
  const b = await creators.createCreator({ name: 'B', handle: '@slotb', status: 'active' });
  const results = await Promise.allSettled([
    creators.updateCreatorProfile(a.id, { founding: true, foundingSince: new Date().toISOString() }, { foundingSlot: 'require' }),
    creators.updateCreatorProfile(b.id, { founding: true, foundingSince: new Date().toISOString() }, { foundingSlot: 'require' }),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled').length;
  const full = results.filter((r) => r.status === 'rejected' && r.reason.code === creators.FOUNDING_SLOTS_FULL).length;
  check('exactly one of two racing grants gets slot 100', won === 1 && full === 1, JSON.stringify(results.map((r) => r.status)));
  const { rows } = await query(`select count(*)::int as n from creators where (data->>'founding')::boolean`);
  check('never more than 100 founders', rows[0].n === 100, String(rows[0].n));
  const c = await creators.createCreator({ name: 'C', handle: '@slotc', status: 'active' });
  const tried = await creators.updateCreatorProfile(c.id, { founding: true, foundingSince: 'x', bio: 'kept' }, { foundingSlot: 'try' });
  check("'try' saves everything else and drops the grant when full", tried.bio === 'kept' && !tried.founding && !tried.foundingSince);
  await query(`update creators set data = data || '{"status":"banned"}'::jsonb where id = '1001'`);
  const again = await creators.updateCreatorProfile(c.id, { founding: true, foundingSince: new Date().toISOString() }, { foundingSlot: 'require' });
  check("a banned founder's slot can be granted to someone else", again.founding === true);
}

section('Hand-granted Founding on a pending applicant starts its clock at approval');
{
  await reset();
  const p = await creators.createCreator({ name: 'Pending P', handle: '@pendingp', status: 'pending' });
  const grant = await adminSave({ creatorId: p.id, fields: { founding: true } });
  check('grant saved on a pending applicant', grant.statusCode === 200, JSON.stringify(grant.body));
  check('slot reserved but the window has not started', grant.body.creator.founding === true && !grant.body.creator.foundingSince, JSON.stringify(grant.body.creator));
  check('the waiver reads as pending, not active', founding.feeWaiverPending(grant.body.creator) && !founding.feeWaiverActive(grant.body.creator));
  // A stamp left by a grant made before this rule must move to approval too.
  await creators.updateCreatorProfile(p.id, { foundingSince: '2026-01-01T00:00:00.000Z' });
  await query(`insert into performer_records (data) values ($1)`, [{ creatorId: String(p.id), status: 'active', documentLocation: 'offline' }]);
  const before = Date.now();
  const approve = await adminSave({ creatorId: p.id, fields: { status: 'active', handle: '@pendingp', founding: true } });
  check('approval saved', approve.statusCode === 200, JSON.stringify(approve.body));
  const since = Date.parse(approve.body.creator.foundingSince);
  check('the window starts at approval', since >= before, approve.body.creator.foundingSince);
  const resave = await adminSave({ creatorId: p.id, fields: { status: 'active', founding: true, bio: 'later edit' } });
  check('a later save never restarts it', resave.body.creator.foundingSince === approve.body.creator.foundingSince);
  const ban = await adminSave({ creatorId: p.id, fields: { status: 'banned', founding: true } });
  check('a hand ban revokes Founding even when the panel echoes the box', ban.body.creator.founding === false && !!ban.body.creator.foundingRevokedAt, JSON.stringify(ban.body.creator));
}

section('Admin avatar reset goes through setCreatorAvatar');
{
  await reset();
  const c = await creators.createCreator({ name: 'Av', handle: '@av', status: 'active', img: '/images/x.jpg' });
  const res = await adminSave({ creatorId: c.id, fields: { img: '/images/avatar-placeholder.png' } });
  check('avatar changed through the profile API', res.statusCode === 200 && res.body.creator.img === '/images/avatar-placeholder.png', JSON.stringify(res.body));
}

section('Orphaned upload sweep');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const orphan = media.newMediaPathname({ purpose: 'gallery', creatorId: creator.id, contentType: 'image/jpeg' });
  const used = media.newMediaPathname({ purpose: 'gallery', creatorId: creator.id, contentType: 'image/jpeg' });
  const fresh = media.newMediaPathname({ purpose: 'gallery', creatorId: creator.id, contentType: 'image/jpeg' });
  const takenDown = await mkListing(creator.id);
  for (const p of [orphan, used, fresh]) await media.recordPendingMediaPath(p, 'token');
  const takenDownPath = takenDown.media[0].src.replace('/api/media/', '');
  await media.recordPendingMediaPath(takenDownPath, 'delete_failed');
  await creators.addGalleryItem(creator.id, { type: 'image', src: media.mediaSrc(used) }, []);
  await query(`update listings set data = data || jsonb_build_object('mediaDeletedAt', now()::text) where id = $1`, [String(takenDown.id)]);
  await query(`update media_uploads set created_at = now() - interval '2 hours' where pathname <> $1`, [fresh]);
  const deleted = [];
  const summary = await media.sweepOrphanedMedia({ deleteFile: async (p) => { deleted.push(p); } });
  check('unreferenced, old upload deleted', deleted.includes(orphan));
  check('a failed deletion of taken-down media is retried', deleted.includes(takenDownPath));
  check('finalized upload kept', !deleted.includes(used));
  check('recent upload left for later', !deleted.includes(fresh));
  check('summary counts', summary.checked === 3 && summary.deleted === 2 && summary.kept === 1, JSON.stringify(summary));
  const { rows } = await query('select pathname from media_uploads');
  check('only the recent row remains', rows.length === 1 && rows[0].pathname === fresh);
  await query(`update media_uploads set created_at = now() - interval '2 hours'`);
  const failing = await quiet(() => media.sweepOrphanedMedia({ deleteFile: async () => { throw new Error('boom'); } }));
  const { rows: again } = await query('select pathname, reason from media_uploads');
  check('a failed sweep deletion is recorded for retry', failing.failed === 1 && again.length === 1 && again[0].reason === 'delete_failed');
}

section('chain-verify: deposits sum every transfer, payouts need an exact amount');
{
  const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
  const token = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  const us = '0x1111111111111111111111111111111111111111';
  const fan = '0x2222222222222222222222222222222222222222';
  const stranger = '0x3333333333333333333333333333333333333333';
  const log = (from, to, value, address = token) => ({
    address,
    topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  });
  const base = { tokenAddress: token, payoutAddress: us };
  const two = chain.matchTransfers({ ...base, logs: [log(fan, us, 50n), log(fan, us, 50n)], expectedFrom: fan, minAmount: 1n });
  check('a batched deposit counts BOTH transfers', two.counted === 100n);
  const mixed = chain.matchTransfers({ ...base, logs: [log(fan, us, 50n), log(stranger, us, 900n)], expectedFrom: fan, minAmount: 1n });
  check("another sender's transfer is never counted", mixed.counted === 50n);
  const wrongFrom = chain.matchTransfers({ ...base, logs: [log(stranger, us, 900n)], expectedFrom: fan, minAmount: 1n });
  check('only a stranger paying is a sender mismatch', wrongFrom.counted === null && wrongFrom.sawSenderMismatch === true);
  const otherToken = chain.matchTransfers({ ...base, logs: [log(fan, us, 50n, stranger)], expectedFrom: fan, minAmount: 1n });
  check('other tokens are ignored', otherToken.counted === null);
  const over = chain.matchTransfers({ ...base, logs: [log(stranger, us, 10000n)], exactAmount: 4000n });
  check('a payout needs the EXACT amount (overpayment refused)', over.counted === null);
  const exact = chain.matchTransfers({ ...base, logs: [log(stranger, us, 10000n), log(stranger, us, 4000n)], exactAmount: 4000n });
  check('the exact payout transfer is found among others', exact.counted === 4000n);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
