// End-to-end tests for the Postgres-backed stores, run against a real
// Postgres (not a mock) so the SQL itself is exercised.
//
// Run with:
//   DATABASE_URL=postgresql://... \
//   node --import ./test-register.mjs lib/stores.test.mjs
//
// Every test starts from a truncated database, so this must only ever be
// pointed at a scratch database. It refuses to run otherwise.

import { query, closePool } from './db.js';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyass_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database (…/onlyass_site).');
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
  check('location capped at 500', n.contentLocation.length === 500);
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
  check('starts not favorited', (await favorites.isFavorite('fan1', 'c1')) === false);
  check('toggle on', (await favorites.toggleFavorite('fan1', 'c1')).favorited === true);
  check('now favorited', (await favorites.isFavorite('fan1', 'c1')) === true);
  check('toggle off', (await favorites.toggleFavorite('fan1', 'c1')).favorited === false);
  check('now not favorited', (await favorites.isFavorite('fan1', 'c1')) === false);
  await favorites.toggleFavorite('fan1', 'c1');
  await favorites.toggleFavorite('fan1', 'c2');
  await favorites.toggleFavorite('fan2', 'c1');
  const ids = await favorites.getFavoriteCreatorIds('fan1');
  check('lists only this fan', ids.length === 2 && ids.includes('c1') && ids.includes('c2'), JSON.stringify(ids));
  check('getFavorites returns the old shape', (await favorites.getFavorites()).every((f) => f.fanId && f.creatorId && f.createdAt));
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
  check('moderation removal works', removed.status === 'removed');
  check('removing a missing listing returns null', (await listings.markListingRemoved(99999)) === null);
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

  const afterRemove = await creators.removeGalleryItem(made.id, 0);
  check('gallery item removed', afterRemove.gallery.length === 14 && afterRemove.media === 14);

  const priv = { ...made, walletAddress: '0xabc', payoutMethod: 'crypto', contactEmail: 'x@y.com' };
  const pub = creators.toPublicCreator(priv);
  check('private fields stripped', pub.walletAddress === undefined && pub.payoutMethod === undefined && pub.contactEmail === undefined);
  check('public fields kept', pub.name === 'Real One');

  const v1 = await creators.applyContentViolation(made.id);
  check('first violation suspends', v1.status === 'suspended' && v1.contentViolationCount === 1);
  check('suspension has an end date', typeof v1.suspendedUntil === 'string');
  check('suspended is not publicly visible', creators.isPubliclyVisible(v1) === false);
  const v2 = await creators.applyContentViolation(made.id);
  check('second violation bans', v2.status === 'banned' && v2.contentViolationCount === 2);
  check('banned is not publicly visible', creators.isPubliclyVisible(v2) === false);
  check('an expired suspension reads as active', creators.effectiveCreatorStatus({ status: 'suspended', suspendedUntil: new Date(Date.now() - 1000).toISOString() }) === 'active');
  check('a live suspension still reads suspended', creators.effectiveCreatorStatus({ status: 'suspended', suspendedUntil: new Date(Date.now() + 100000).toISOString() }) === 'suspended');

  const toDelete = await creators.createCreator({ name: 'Deletable One', handle: '@deletable1' });
  const linkedUser = await users.createUser({ email: 'deletable1@example.com', password: 'pw123456', role: 'creator', creatorId: toDelete.id });
  const otherUser = await users.createUser({ email: 'unaffected@example.com', password: 'pw123456', role: 'fan' });
  await creators.deleteCreator(toDelete.id);
  check('deleting a creator removes their login account too', (await users.findUserById(linkedUser.id)) === null);
  check('an unrelated account survives a creator deletion', (await users.findUserById(otherUser.id)) !== null);

  const toDeleteBulk = await creators.createCreator({ name: 'Deletable Two', handle: '@deletable2' });
  const bulkUser = await users.createUser({ email: 'deletable2@example.com', password: 'pw123456', role: 'creator', creatorId: toDeleteBulk.id });

  const remaining = await creators.deleteAllCreators(false);
  check('wiping real creators keeps the seeds', remaining.length === seedCount, String(remaining.length));
  check('bulk-deleting creators removes their login accounts too', (await users.findUserById(bulkUser.id)) === null);
  const none = await creators.deleteAllCreators(true);
  check('wiping everything leaves nothing', none.length === 0, String(none.length));
  check('seeds do NOT silently reappear after a full wipe', (await creators.getCreators()).length === 0);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
