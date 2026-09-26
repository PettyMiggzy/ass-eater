// End-to-end tests for the Postgres-backed stores, run against a real
// Postgres (not a mock) so the SQL itself is exercised.
//
// Run with:
//   DATABASE_URL=postgresql://... \
//   node --import ./test-register.mjs lib/stores.test.mjs
//
// Every test starts from a truncated database, so this must only ever be
// pointed at a scratch database. It refuses to run otherwise.

import { query, closePool, withTransaction } from './db.js';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database (…/onlyone_site).');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  PASS', name);
  } else {
    fail++;
    console.log('  FAIL', name, extra);
  }
};
const section = (s) => console.log('\n' + s);

async function reset() {
  await query(
    'truncate creators, users, listings, orders, conversations, wall_posts, favorites, reports, violations, ncii_reports restart identity',
  );
}

const reports = await import('./reports-store.js');
const violations = await import('./violations-store.js');
const ncii = await import('./ncii-reports-store.js');
const favorites = await import('./favorites-store.js');
const wall = await import('./wall-store.js');
const messages = await import('./messages-store.js');

import { creators as seedRoster } from '../data/creators.js';
const seedCount = seedRoster.length;

await reset();
await query("delete from app_meta");

section('reports-store');
{
  const r1 = await reports.addReport({ listingId: 'l1', reason: 'spam', reportedBy: 'u1' });
  const r2 = await reports.addReport({ listingId: 'l2', reason: 'other', reportedBy: 'u2' });
  check('ids are distinct and sequential', r1.id === 1 && r2.id === 2, `${r1.id}/${r2.id}`);
  check('defaults applied', r1.status === 'open' && typeof r1.createdAt === 'string');
  check('payload preserved', r1.listingId === 'l1' && r1.reason === 'spam');
  const all = await reports.getReports();
  check('lists both', all.length === 2);
  const resolved = await reports.updateReportStatus(r1.id, 'resolved', 'admin');
  check('status updated', resolved.status === 'resolved' && resolved.resolvedBy === 'admin');
  check('other fields survive the update', resolved.listingId === 'l1' && resolved.reason === 'spam');
  let threw = null;
  try { await reports.updateReportStatus(9999, 'resolved', 'admin'); } catch (e) { threw = e; }
  check('missing report throws', threw !== null && /not found/i.test(String(threw.message)));
}

section('violations-store');
{
  const v = await violations.addViolation({
    userId: 'u1', context: 'wall_post', reasons: ['cashapp'], snippet: 'x'.repeat(500),
  });
  check('snippet capped at 200', v.snippet.length === 200);
  check('opens as open', v.status === 'open');
  await violations.addViolation({ userId: 'u1', context: 'bio', reasons: ['venmo'], snippet: 'y' });
  await violations.addViolation({ userId: 'u2', context: 'bio', reasons: ['venmo'], snippet: 'z' });
  check('counts only this user, only open', (await violations.countOpenViolationsForUser('u1')) === 2);
  await violations.updateViolationStatus(v.id, 'dismissed', 'admin');
  check('count drops once resolved', (await violations.countOpenViolationsForUser('u1')) === 1);
  check('numeric and string ids both work', (await violations.countOpenViolationsForUser(2)) === 0);
}

section('ncii-reports-store (federal 48-hour queue)');
{
  const n = await ncii.addNciiReport({
    reporterName: 'a'.repeat(300),
    reporterContact: 'b@example.com',
    contentLocation: 'c'.repeat(600),
    description: 'd',
    consentStatement: true,
  });
  check('name capped at 200', n.reporterName.length === 200);
  // Round 3: the old 500 cut silently dropped the tail of a long list of
  // links; 600 is now stored whole (the route refuses anything over the
  // limit with a 400, and the store's cut is only a backstop).
  check('a 600-char location is stored in full', n.contentLocation.length === 600);
  check('consent recorded as boolean', n.consentStatement === true);
  // The bug this replaces: two filings landing together, one silently lost.
  const many = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      ncii.addNciiReport({ reporterName: `r${i}`, reporterContact: 'x', contentLocation: 'y', description: 'z', consentStatement: true }),
    ),
  );
  const stored = await ncii.getNciiReports();
  check('25 simultaneous filings all persist', stored.length === 26, String(stored.length));
  check('every id is unique', new Set(many.map((m) => m.id)).size === 25);
}

section('favorites-store');
{
  // A favorite is written only for an account that exists (round-21 media#2:
  // toggleFavorite takes the fan's users row FOR KEY SHARE).
  for (const id of ['fan1', 'fan2']) await query(`insert into users (id, data) values ($1, '{}'::jsonb) on conflict do nothing`, [id]);
  // ... and (round-22 media#0 / social#0) only for a real, publicly visible
  // creator id.
  for (const [id, status] of [['901', 'active'], ['902', 'active'], ['903', 'pending']]) {
    await query(`insert into creators (id, data) values ($1, $2::jsonb) on conflict do nothing`, [id, JSON.stringify({ id, name: `C${id}`, status })]);
  }
  check('a fan with no account cannot favorite', (await favorites.toggleFavorite('no-such-fan', '901').catch((e) => e))?.code === 'author_account_gone');
  check('starts not favorited', (await favorites.isFavorite('fan1', '901')) === false);
  check('toggle on', (await favorites.toggleFavorite('fan1', '901')).favorited === true);
  check('now favorited', (await favorites.isFavorite('fan1', '901')) === true);
  check('toggle off', (await favorites.toggleFavorite('fan1', '901')).favorited === false);
  check('now not favorited', (await favorites.isFavorite('fan1', '901')) === false);
  await favorites.toggleFavorite('fan1', 901); // a number is a valid id too
  await favorites.toggleFavorite('fan1', '902');
  await favorites.toggleFavorite('fan2', '901');
  const ids = await favorites.getFavoriteCreatorIds('fan1');
  check('lists only this fan', ids.length === 2 && ids.includes('901') && ids.includes('902'), JSON.stringify(ids));
  check('getFavorites returns the old shape', (await favorites.getFavorites()).every((f) => f.fanId && f.creatorId && f.createdAt));
  // Junk ids are refused and never stored.
  for (const bad of [{}, [1, 2], 'x'.repeat(3000), 'c1', '0', '-1', '1.5', '', null, true, '12345678901234567890']) {
    check(`junk id ${JSON.stringify(bad)?.slice(0, 20)} refused`, (await favorites.toggleFavorite('fan1', bad).catch((e) => e))?.code === favorites.FAVORITE_CREATOR_NOT_FOUND);
  }
  check('a nonexistent creator cannot be added', (await favorites.toggleFavorite('fan1', '999999').catch((e) => e))?.code === favorites.FAVORITE_CREATOR_NOT_FOUND);
  check('a hidden (pending) creator cannot be added', (await favorites.toggleFavorite('fan1', '903').catch((e) => e))?.code === favorites.FAVORITE_CREATOR_NOT_FOUND);
  // Removal still works once the creator is gone.
  await query(`delete from creators where id = '902'`);
  check('an existing favorite can be removed after the creator is deleted', (await favorites.toggleFavorite('fan1', '902')).favorited === false);
  check('nothing junk was stored', (await favorites.getFavoriteCreatorIds('fan1')).every((id) => /^[1-9][0-9]*$/.test(id)));
  await query(`delete from creators where id in ('901', '903')`);
}

section('wall-store');
{
  const p1 = await wall.addWallPost({ creatorId: 'c1', authorId: 'u1', authorName: 'Ann', text: '  hello  ' });
  check('text trimmed', p1.text === 'hello');
  check('id assigned', p1.id === 1);
  await wall.addWallPost({ creatorId: 'c1', authorId: 'u2', authorName: 'Bob', text: 'second' });
  await wall.addWallPost({ creatorId: 'c2', authorId: 'u1', authorName: 'Ann', text: 'other wall' });
  const forC1 = await wall.getWallPostsForCreator('c1');
  check('filters by creator', forC1.length === 2);
  check('newest first', new Date(forC1[0].createdAt) >= new Date(forC1[1].createdAt));
  const longName = await wall.addWallPost({ creatorId: 'c1', authorId: 'u1', authorName: 'n'.repeat(200), text: 'x' });
  check('author name capped at 60', longName.authorName.length === 60);
  const longText = await wall.addWallPost({ creatorId: 'c1', authorId: 'u1', authorName: 'A', text: 't'.repeat(900) });
  check('text capped at 500', longText.text.length === 500);
  let threw = null;
  try { await wall.addWallPost({ creatorId: 'c1', authorId: 'u1', authorName: 'A', text: '   ' }); } catch (e) { threw = e; }
  check('empty comment rejected', threw !== null);
  threw = null;
  try { await wall.deleteWallPost(p1.id, 'someone-else'); } catch (e) { threw = e; }
  check('a stranger cannot delete', threw !== null && /not authorized/i.test(String(threw.message)));
  check('the author can delete', (await wall.deleteWallPost(p1.id, 'u1')) === true);
  const p2 = await wall.addWallPost({ creatorId: 'c1', authorId: 'u9', authorName: 'Z', text: 'wall owner test' });
  check('the wall owner can delete someone else\'s', (await wall.deleteWallPost(p2.id, 'c-owner', { isWallOwner: true })) === true);
  threw = null;
  try { await wall.deleteWallPost(99999, 'u1'); } catch (e) { threw = e; }
  check('missing comment throws', threw !== null);
  // round-12 social#1: an id sent as a JSON array must be "not found", never
  // reach the bigint parameter raw (which threw a pg cast error -> 500).
  const p3 = await wall.addWallPost({ creatorId: 'c1', authorId: 'u1', authorName: 'A', text: 'array id test' });
  threw = null;
  try { await wall.deleteWallPost([String(p3.id)], 'u1'); } catch (e) { threw = e; }
  check('an array id is refused as not found, not a cast error', threw !== null && threw.message === 'Comment not found');
  check('a string id still deletes', (await wall.deleteWallPost(String(p3.id), 'u1')) === true);
}

section('messages-store');
{
  const c = await messages.sendMessage('u1', 'u2', 'hi');
  check('conversation id is order-independent', c.id === (await messages.sendMessage('u2', 'u1', 'hey back')).id);
  const convo = await messages.getConversationBetween('u1', 'u2');
  check('both messages stored', convo.messages.length === 2, String(convo.messages.length));
  check('participants recorded', convo.participantIds.length === 2);
  let threw = null;
  try { await messages.sendMessage('u1', 'u1', 'self'); } catch (e) { threw = e; }
  check('cannot message yourself', threw !== null);
  threw = null;
  try { await messages.sendMessage('u1', 'u2', '   '); } catch (e) { threw = e; }
  check('empty message rejected', threw !== null);

  // THE REGRESSION TEST THAT MATTERS: concurrent sends into one conversation.
  // The old whole-file read-modify-write dropped all but the last of these.
  await Promise.all(Array.from({ length: 30 }, (_, i) => messages.sendMessage('u3', 'u4', `msg ${i}`)));
  const busy = await messages.getConversationBetween('u3', 'u4');
  check('30 simultaneous messages all survive', busy.messages.length === 30, String(busy.messages.length));
  check('no duplicate message ids', new Set(busy.messages.map((m) => m.id)).size === 30);

  const forUser = await messages.getConversationsForUser('u1');
  check('finds conversations by participant', forUser.length === 1 && forUser[0].id === convo.id);
  check('a non-participant sees none', (await messages.getConversationsForUser('nobody')).length === 0);
  const longText = await messages.sendMessage('u5', 'u6', 'z'.repeat(5000));
  check('message text capped at 2000', longText.messages[0].text.length === 2000);
}


const listings = await import('./listings-store.js');
const orders = await import('./orders-store.js');
const users = await import('./users-store.js');
const creators = await import('./creators-store.js');

section('listings-store');
{
  const l = await listings.createListing('c1', { title: 'Set A', priceCents: 500, kind: 'digital' });
  check('id is a number', typeof l.id === 'number' && l.id === 1, String(l.id));
  check('defaults applied', l.status === 'active' && l.kind === 'digital' && l.shippingCents === 0);
  const phys = await listings.createListing('c1', { title: 'Poster', priceCents: 900, kind: 'physical', shippingCents: 300, signatureRequired: true });
  check('physical keeps shipping', phys.shippingCents === 300 && phys.signatureRequired === true);
  const upd = await listings.updateListing(l.id, 'c1', { title: 'Set A v2' });
  check('owner can update', upd.title === 'Set A v2');
  check('other fields survive', upd.priceCents === 500);
  let threw = null;
  try { await listings.updateListing(l.id, 'someone-else', { title: 'hijack' }); } catch (e) { threw = e; }
  check('a different creator cannot update', threw !== null);
  // Concurrent media uploads -- the bug that started all of this.
  await Promise.all(Array.from({ length: 20 }, (_, i) => listings.addListingMedia(l.id, { url: `u${i}` }, [])));
  const after = listings.findListing(await listings.getListings(), l.id);
  check('20 simultaneous uploads all kept', after.media.length === 20, String(after.media.length));
  const removed = await listings.markListingRemoved(l.id);
  check('moderation removal works', removed.status === 'removed' && removed.moderationRemoved === true);
  check('removing a missing listing returns null', (await listings.markListingRemoved(99999)) === null);
  let modErr = null;
  try { await listings.updateListing(l.id, 'c1', { status: 'active' }); } catch (e) { modErr = e; }
  check('a moderation removal cannot be self-reactivated', modErr?.code === listings.LISTING_MODERATED);

  const created = await listings.createListing('c1', { title: 'No smuggled media', priceCents: 500, media: [{ src: 'https://evil.example/x.jpg' }] });
  check('createListing ignores caller-supplied media', Array.isArray(created.media) && created.media.length === 0);

  // sold -> removed -> active must not resell a one-of-a-kind item.
  const one = await listings.createListing('c1', { title: 'Only one', priceCents: 500, unlimited: false });
  await withTransaction((client) => listings.claimUniqueListing(one.id, client));
  let soldErr = null;
  try { await listings.updateListing(one.id, 'c1', { status: 'removed' }); } catch (e) { soldErr = e; }
  check('a sold listing cannot be "removed" by its owner', soldErr?.code === listings.LISTING_SOLD);
  soldErr = null;
  try { await listings.updateListing(one.id, 'c1', { status: 'active' }); } catch (e) { soldErr = e; }
  check('a sold listing cannot be reactivated', soldErr?.code === listings.LISTING_SOLD);
  check('it is still sold', (await listings.getListingById(one.id)).status === 'sold');
  check('a non-status edit of a sold listing still works', (await listings.updateListing(one.id, 'c1', { title: 'Only one (typo)' })).title === 'Only one (typo)');

  // Listing media: owner-only, capped, never onto a sold/moderated listing.
  const shop = await listings.createListing('c9', { title: 'Shop', priceCents: 500 });
  const adds = await Promise.allSettled(Array.from({ length: 5 }, (_, i) =>
    listings.addListingMediaForOwner(shop.id, 'c9', { type: 'image', src: `/api/media/listings/c9/${shop.id}/${i}.jpg` }, [], 3)));
  check('racing listing uploads respect the cap', (await listings.getListingById(shop.id)).media.length === 3);
  check('over-cap uploads get the cap code', adds.filter((r) => r.status === 'rejected' && r.reason.code === listings.MEDIA_CAP_EXCEEDED).length === 2);
  let editErr = null;
  try { await listings.addListingMediaForOwner(one.id, 'c1', { type: 'image', src: '/api/media/x.jpg' }, [], 10); } catch (e) { editErr = e; }
  check('no media can be added to a sold listing', editErr?.code === listings.LISTING_NOT_EDITABLE);
  editErr = null;
  try { await listings.addListingMediaForOwner(shop.id, 'someone-else', { type: 'image', src: '/api/media/y.jpg' }, [], 10); } catch (e) { editErr = e; }
  check('another creator cannot add media', editErr !== null && editErr.code === undefined);

  // Public projection never carries a media src.
  const withPreview = await listings.addListingMediaForOwner(shop.id, 'c9', {
    type: 'image', src: `/api/media/listings/c9/${shop.id}/9.jpg`, preview: 'data:image/jpeg;base64,/9j/AAAA', aiGenerated: true,
  }, [], 10);
  const { toPublicListing } = await import('./creator-status.js');
  const publicShop = toPublicListing(withPreview);
  check('public listing has no media srcs', publicShop.media.every((m) => m.src === undefined) && !JSON.stringify(publicShop).includes('/api/media/'));
  check('public listing keeps type/preview/AI label', publicShop.media.length === 4 && publicShop.media[3].preview === 'data:image/jpeg;base64,/9j/AAAA' && publicShop.media[3].aiGenerated === true);
  check('invalid previews are dropped', toPublicListing({ media: [{ type: 'image', src: 'x', preview: 'https://evil/x.png' }] }).media[0].preview === null);

  // A ban takes listings down as a moderation removal (owner cannot relist).
  const tags = listings.findCircumventionInTags('venmo @janedoe, cute');
  check('tag filter catches a payment handle', tags !== null);
  check('tag filter passes ordinary tags', listings.findCircumventionInTags(['feet', 'gym', 'how-it-works']) === null);
  const { sanitizeTags } = await import('./creator-status.js');
  const cleaned = sanitizeTags('cashapp $jane, 555.123.4567, Cosplay , cosplay');
  check('sanitizeTags strips $ @ . and dedupes', JSON.stringify(cleaned) === JSON.stringify(['cashapp jane', '5551234567', 'cosplay']), JSON.stringify(cleaned));
}

section('orders-store');
{
  let threw = null;
  try { await orders.createOrder({ listingId: 1, creatorId: 'c1', buyerId: 'b1', priceCents: 100, kind: 'digital', ageConfirmed: false, tosAccepted: true }); } catch (e) { threw = e; }
  check('refuses without age confirmation', threw !== null);
  const o = await orders.createOrder({
    listingId: 1, creatorId: 'c1', buyerId: 'b1', priceCents: 100, shippingCents: 50, kind: 'physical',
    signatureRequired: true, shippingAddress: { line1: '1 Test St', city: 'Testville' }, ageConfirmed: true, tosAccepted: true,
  });
  check('order created', typeof o.id === 'number');
  check('never echoes the stored address back', o.shippingAddress === undefined);
  check('physical starts pending_shipment', o.status === 'pending_shipment');
  await orders.createOrder({ listingId: 2, creatorId: 'c2', buyerId: 'b2', priceCents: 100, kind: 'digital', ageConfirmed: true, tosAccepted: true });
  const mine = await orders.getOrdersForBuyer('b1');
  check('buyer sees only their own', mine.length === 1 && mine[0].id === o.id);
  check('buyer address decrypts', mine[0].shippingAddress && mine[0].shippingAddress.city === 'Testville');
  const forCreator = await orders.getOrdersForCreator('c1');
  check('creator sees only their physical orders', forCreator.length === 1);
  check('creator gets the address to ship to', forCreator[0].shippingAddress.line1 === '1 Test St');
  check('other creator sees nothing', (await orders.getOrdersForCreator('c2')).length === 0);
  const shipped = await orders.markOrderShipped(o.id, 'c1', { carrier: 'USPS', trackingNumber: 'X1' });
  check('marked shipped', shipped.status === 'shipped' && shipped.carrier === 'USPS');
  check('shipped response hides the address', shipped.shippingAddress === undefined);
  threw = null;
  try { await orders.markOrderShipped(o.id, 'not-the-creator', { carrier: 'X', trackingNumber: 'Y' }); } catch (e) { threw = e; }
  check('a different creator cannot mark it shipped', threw !== null);
}

section('users-store');
{
  const u = await users.createUser({ email: 'Ann@Example.com', password: 'pw123456', role: 'fan' });
  check('user created with uuid id', typeof u.id === 'string' && u.id.length > 20);
  check('session epoch starts at 0', u.sessionVersion === 0);
  let threw = null;
  try { await users.createUser({ email: 'ann@example.com', password: 'x', role: 'fan' }); } catch (e) { threw = e; }
  check('duplicate email rejected case-insensitively', threw !== null && /already exists/i.test(String(threw.message)));
  threw = null;
  try { await users.createUser({ email: '  ann@example.com  ', password: 'x', role: 'fan' }); } catch (e) { threw = e; }
  check('duplicate rejected ignoring whitespace too', threw !== null);
  check('found by differently-cased email', (await users.findUserByEmail('ANN@EXAMPLE.COM'))?.id === u.id);
  check('found by padded email', (await users.findUserByEmail('  ann@example.com '))?.id === u.id);
  check('found by id', (await users.findUserById(u.id))?.id === u.id);
  check('publicUser strips the password hash', users.publicUser(u).passwordHash === undefined);
  check('password verifies', (await users.verifyPassword(u, 'pw123456')) === true);
  check('wrong password fails', (await users.verifyPassword(u, 'nope')) === false);
  check('unknown user still runs a compare and fails', (await users.verifyPassword(null, 'anything')) === false);

  // Concurrent signups for the SAME identifier: exactly one must win.
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => users.createUser({ email: 'race@example.com', password: 'pw', role: 'fan' })),
  );
  check('exactly one of 10 racing signups succeeded', results.filter((r) => r.status === 'fulfilled').length === 1,
        String(results.filter((r) => r.status === 'fulfilled').length));

  const v1 = await users.bumpSessionVersion(u.id, 0);
  check('epoch bumped', v1 === 1);
  threw = null;
  try { await users.bumpSessionVersion(u.id, 0); } catch (e) { threw = e; }
  check('a retired token cannot revoke again', threw !== null && threw.code === users.SESSION_ALREADY_REVOKED);
  threw = null;
  try { await users.bumpSessionVersion('no-such-user', 0); } catch (e) { threw = e; }
  check('missing user throws a different error', threw !== null && threw.code !== users.SESSION_ALREADY_REVOKED);
}

section('creators-store');
{
  const all = await creators.getCreators();
  check('seed roster loaded', all.length === seedCount, `${all.length} vs ${seedCount}`);
  check('seed creators keep their ids', all.some((c) => String(c.id) === '1'));
  const made = await creators.createCreator({ name: 'Real One', handle: '@real' });
  check('new creator gets an id past the seeds', Number(made.id) > seedCount, String(made.id));
  const hijack = await creators.createCreator({ id: '1', name: 'Impostor' });
  check('a caller-supplied id is ignored', String(hijack.id) !== '1');
  check('no duplicate ids', new Set((await creators.getCreators()).map((c) => String(c.id))).size === (await creators.getCreators()).length);

  await creators.updateCreatorProfile(made.id, { bio: 'hello' });
  check('profile updated', (await creators.getCreators()).find((c) => String(c.id) === String(made.id)).bio === 'hello');

  await Promise.all(Array.from({ length: 15 }, (_, i) => creators.addGalleryItem(made.id, { url: `g${i}` }, [])));
  const withGallery = (await creators.getCreators()).find((c) => String(c.id) === String(made.id));
  check('15 simultaneous gallery uploads all kept', withGallery.gallery.length === 15, String(withGallery.gallery.length));
  check('media count matches the gallery', withGallery.media === 15);

  // Deletes are addressed by src now, not position.
  await Promise.all(['/api/media/gallery/x/a.jpg', '/api/media/gallery/x/b.jpg', '/api/media/gallery/x/c.jpg'].map((src) =>
    creators.addGalleryItem(made.id, { type: 'image', src }, [])));
  const afterRemove = await creators.removeGalleryItem(made.id, { src: '/api/media/gallery/x/a.jpg' });
  check('gallery item removed by src', afterRemove.gallery.length === 17 && afterRemove.media === 17
    && !afterRemove.gallery.some((g) => g.src === '/api/media/gallery/x/a.jpg'));
  // A stale view: it thinks 'c' is at index 0. The index does not match that
  // src, so the item is found by src instead of deleting whatever is at 0.
  const staleFirst = afterRemove.gallery[0];
  const afterStale = await creators.removeGalleryItem(made.id, { src: '/api/media/gallery/x/c.jpg', index: 0 });
  check('stale index never deletes a different item', afterStale.gallery.some((g) => g === staleFirst || JSON.stringify(g) === JSON.stringify(staleFirst))
    && !afterStale.gallery.some((g) => g.src === '/api/media/gallery/x/c.jpg'));
  let goneErr = null;
  try { await creators.removeGalleryItem(made.id, { src: '/api/media/gallery/x/a.jpg' }); } catch (e) { goneErr = e; }
  check('deleting an item that is already gone is a conflict, not a random delete', goneErr?.code === creators.GALLERY_ITEM_GONE);
  goneErr = null;
  try { await creators.removeGalleryItem(made.id, { index: 0 }); } catch (e) { goneErr = e; }
  check('an index alone deletes nothing', goneErr?.code === creators.GALLERY_ITEM_GONE);

  // Cap and duplicate finalize, enforced inside the write.
  const capped = await creators.createCreator({ name: 'Capped', handle: '@capped' });
  const capResults = await Promise.allSettled(Array.from({ length: 6 }, (_, i) =>
    creators.addGalleryItem(capped.id, { type: 'image', src: `/api/media/gallery/${capped.id}/${i}.jpg` }, [], 4)));
  const cappedNow = (await creators.getCreators()).find((c) => String(c.id) === String(capped.id));
  check('six racing uploads against a cap of 4 land exactly 4', cappedNow.gallery.length === 4, String(cappedNow.gallery.length));
  check('the rest are refused with the cap code', capResults.filter((r) => r.status === 'rejected' && r.reason.code === creators.GALLERY_CAP_EXCEEDED).length === 2);
  const dupe = await creators.addGalleryItem(capped.id, { type: 'image', src: cappedNow.gallery[0].src }, [], 4);
  check('re-finalizing the same file is a no-op, not a cap error', dupe.gallery.length === 4);

  const priv = { ...made, walletAddress: '0xabc', payoutMethod: 'crypto', contactEmail: 'x@y.com' };
  const pub = creators.toPublicCreator(priv);
  check('private fields stripped', pub.walletAddress === undefined && pub.payoutMethod === undefined && pub.contactEmail === undefined);
  check('public fields kept', pub.name === 'Real One');

  // Moderation history must not ship once a suspension has lapsed.
  const lapsed = creators.toPublicCreator({
    ...made, status: 'suspended', suspendedUntil: new Date(Date.now() - 1000).toISOString(), contentViolationCount: 1,
  });
  check('lapsed suspension reads active publicly', lapsed.status === 'active', String(lapsed.status));
  check('moderation history stripped', lapsed.contentViolationCount === undefined && lapsed.suspendedUntil === undefined);
  const gatedPub = creators.toPublicCreator({
    ...made, locked: true, gateTokens: 1000, video: '/api/media/gallery/x/v.mp4',
    gallery: [{ type: 'video', src: '/api/media/gallery/x/v.mp4', aiGenerated: true }, { type: 'image', src: '/api/media/gallery/x/p.jpg' }],
  });
  check('a token-gated gallery carries no srcs', gatedPub.gallery.length === 2 && gatedPub.gallery.every((g) => g.src === undefined && g.locked === true));
  check('a token-gated gallery keeps type and AI label', gatedPub.gallery[0].type === 'video' && gatedPub.gallery[0].aiGenerated === true);
  check('a token-gated hero video is stripped', gatedPub.video === null);
  const unlocked = creators.toPublicCreator({ ...made, locked: true, gateTokens: 1000, gallery: [{ type: 'image', src: '/api/media/gallery/x/p.jpg' }] }, { viewerMayUnlock: true });
  check('a verified viewer keeps gated srcs', unlocked.gallery[0].src === '/api/media/gallery/x/p.jpg');
  const seedPub = creators.toPublicCreator((await creators.getCreators()).find((c) => c.seed === true));
  check('seed demo media is always labelled AI-generated', seedPub.gallery.length > 0 && seedPub.gallery.every((g) => g.aiGenerated === true));
  check('JSON-serializable (no undefined status)', seedPub.status === null || typeof seedPub.status === 'string');

  const v1 = await creators.applyContentViolation(made.id);
  check('first violation suspends', v1.status === 'suspended' && v1.contentViolationCount === 1);
  check('suspension has an end date', typeof v1.suspendedUntil === 'string');
  check('suspended is not publicly visible', creators.isPubliclyVisible(v1) === false);
  const v2 = await creators.applyContentViolation(made.id);
  check('second violation bans', v2.status === 'banned' && v2.contentViolationCount === 2);
  check('banned is not publicly visible', creators.isPubliclyVisible(v2) === false);
  check('an expired suspension reads as active', creators.effectiveCreatorStatus({ status: 'suspended', suspendedUntil: new Date(Date.now() - 1000).toISOString() }) === 'active');
  check('a live suspension still reads suspended', creators.effectiveCreatorStatus({ status: 'suspended', suspendedUntil: new Date(Date.now() + 100000).toISOString() }) === 'suspended');

  // A failed signup must not strand a pending creator profile with no login
  // account -- see pages/api/auth/signup.js's withTransaction() wrapping.
  // Mimic it here: create a creator, then force createUser to fail (a
  // duplicate email) inside the SAME transaction, and confirm the creator
  // row was rolled back along with the failed user insert.
  await users.createUser({ email: 'taken@example.com', password: 'pw123456', role: 'fan' });
  const beforeCount = (await creators.getCreators()).length;
  let signupErr = null;
  try {
    await withTransaction(async (client) => {
      const pendingCreator = await creators.createCreator({ name: 'Ghost Applicant', handle: '@ghost' }, client);
      await users.createUser({ email: 'taken@example.com', password: 'pw123456', role: 'creator', creatorId: pendingCreator.id }, client);
    });
  } catch (e) {
    signupErr = e;
  }
  check('a signup failure inside the transaction throws', signupErr !== null);
  check('the transaction rolled back -- no ghost creator left behind', (await creators.getCreators()).length === beforeCount, String((await creators.getCreators()).length));

  const toDelete = await creators.createCreator({ name: 'Deletable One', handle: '@deletable1' });
  const linkedUser = await users.createUser({ email: 'deletable1@example.com', password: 'pw123456', role: 'creator', creatorId: toDelete.id });
  const otherUser = await users.createUser({ email: 'unaffected@example.com', password: 'pw123456', role: 'fan' });
  const delResult = await creators.deleteCreator(toDelete.id);
  check('delete reports nothing stranded when nothing was attached', Array.isArray(delResult.stranded) && delResult.stranded.length === 0);
  check('deleting a creator removes their login account too', (await users.findUserById(linkedUser.id)) === null);
  check('an unrelated account survives a creator deletion', (await users.findUserById(otherUser.id)) !== null);

  const toDeleteBulk = await creators.createCreator({ name: 'Deletable Two', handle: '@deletable2' });
  const bulkUser = await users.createUser({ email: 'deletable2@example.com', password: 'pw123456', role: 'creator', creatorId: toDeleteBulk.id });

  // A creator with money attached is refused unless forced, and the forced
  // delete reports exactly what it stranded.
  await query('truncate credit_balances, payout_requests');
  const moneyed = await creators.createCreator({ name: 'Has Money', handle: '@hasmoney' });
  const moneyedUser = await users.createUser({ email: 'hasmoney@example.com', password: 'pw123456', role: 'creator', creatorId: moneyed.id });
  await query('insert into credit_balances (user_id, balance_cents) values ($1, 5000)', [moneyedUser.id]);
  let oblErr = null;
  try { await creators.deleteCreator(moneyed.id); } catch (e) { oblErr = e; }
  check('deleting a creator with a balance is refused', oblErr?.code === creators.CREATOR_HAS_OBLIGATIONS
    && oblErr.obligations?.[0]?.balanceCents === 5000);
  check('the refused creator and login survive', (await users.findUserById(moneyedUser.id)) !== null
    && (await creators.getCreators()).some((c) => String(c.id) === String(moneyed.id)));

  const { creators: remaining, skipped } = await creators.deleteAllCreators(false);
  check('bulk delete skips the creator with money and lists them', skipped.length === 1 && String(skipped[0].creatorId) === String(moneyed.id));
  check('wiping real creators keeps the seeds (and the skipped one)', remaining.length === seedCount + 1, String(remaining.length));
  check('bulk-deleting creators removes their login accounts too', (await users.findUserById(bulkUser.id)) === null);
  const forced = await creators.deleteCreator(moneyed.id, { force: true });
  check('a forced delete reports what it stranded', forced.stranded.length === 1 && forced.stranded[0].balanceCents === 5000);
  const { creators: none } = await creators.deleteAllCreators(true);
  check('wiping everything leaves nothing', none.length === 0, String(none.length));
  check('seeds do NOT silently reappear after a full wipe', (await creators.getCreators()).length === 0);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
