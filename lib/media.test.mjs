// Tests for the private media pipeline: pathname handling, the admin media
// cookie, and -- most importantly -- WHO the media route serves each kind of
// file to. Run against a real scratch Postgres (it truncates tables):
//   DATABASE_URL=postgresql://.../onlyone_..._test node --import ./test-register.mjs lib/media.test.mjs
//
// The route is called in-process with a fake req/res. BLOB_READ_WRITE_TOKEN is
// deliberately unset, so an ENTITLED request reaches sendMedia and fails there
// (500) while an unentitled one is refused before it (404). That split is
// exactly the decision under test; the presign/stream mechanics need a real
// store and are not exercised here.

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-one';

const { query, closePool } = await import('./db.js');
const media = await import('./media.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const { createSessionToken } = await import('./session.js');
const { default: mediaRoute } = await import('../pages/api/media/[...path].js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);

const origError = console.error;
const origWarn = console.warn;

function fakeRes() {
  const res = {
    statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; },
  };
  return res;
}

async function fetchMedia(pathname, { cookie } = {}) {
  const req = { method: 'GET', query: { path: pathname.split('/') }, headers: cookie ? { cookie } : {}, socket: {} };
  const res = fakeRes();
  console.error = () => {};
  console.warn = () => {};
  try { await mediaRoute(req, res); } finally { console.error = origError; console.warn = origWarn; }
  return res.statusCode;
}
// 404 = refused before touching storage; anything else = entitled.
const served = (code) => code !== 404;

section('pathnames');
{
  const p = media.newMediaPathname({ purpose: 'gallery', creatorId: '7', contentType: 'image/jpeg' });
  check('gallery pathname is server-chosen and parseable', /^gallery\/7\/[0-9a-f-]{36}\.jpg$/.test(p) && media.parseMediaPathname(p)?.creatorId === '7');
  const l = media.newMediaPathname({ purpose: 'listing', creatorId: '7', listingId: '12', contentType: 'video/mp4' });
  check('listing pathname carries the listing id', media.parseMediaPathname(l)?.listingId === '12' && l.endsWith('.mp4'));
  check('svg is never given a pathname', media.newMediaPathname({ purpose: 'gallery', creatorId: '7', contentType: 'image/svg+xml' }) === null);
  check('traversal is not parseable', media.parseMediaPathname('gallery/7/../../x.jpg') === null);
  check('foreign prefixes are not parseable', media.parseMediaPathname('content/7/1-name.jpg') === null);
  check('media src round-trips', media.pathnameFromMediaSrc(media.mediaSrc(p)) === p);
}

section('admin media cookie');
{
  const t = media.createAdminMediaToken();
  check('fresh token verifies', media.verifyAdminMediaToken(t));
  check('tampered token fails', !media.verifyAdminMediaToken(t.slice(0, -2) + 'xx'));
  check('expired token fails', !media.verifyAdminMediaToken(media.createAdminMediaToken(Date.now() - 3 * 3600 * 1000)));
  process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-two';
  check('rotating the admin key revokes outstanding cookies', !media.verifyAdminMediaToken(t));
  process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-one';
  const age = await import('./age-verification.js');
  const ageToken = await age.createAgeVerificationToken(age.ageVerificationSecret());
  check('an age-verification token is not an admin media token', !media.verifyAdminMediaToken(ageToken));
}

section('media route entitlement');
{
  await query('truncate creators, users, listings, orders restart identity');
  await query("delete from app_meta");
  const owner = await creators.createCreator({ name: 'Owner', handle: '@owner', status: 'active' });
  const ownerUser = await users.createUser({ email: 'owner@example.com', password: 'pw123456', role: 'creator', creatorId: owner.id });
  const fan = await users.createUser({ email: 'fan@example.com', password: 'pw123456', role: 'fan' });
  const buyer = await users.createUser({ email: 'buyer@example.com', password: 'pw123456', role: 'fan' });
  const cookieFor = (u) => `oa_session=${encodeURIComponent(createSessionToken(u.id, 0))}`;
  const adminCookie = `oa_admin_media=${media.createAdminMediaToken()}`;

  const gPath = media.newMediaPathname({ purpose: 'gallery', creatorId: owner.id, contentType: 'image/jpeg' });
  await creators.addGalleryItem(owner.id, { type: 'image', src: media.mediaSrc(gPath) }, []);
  const orphan = media.newMediaPathname({ purpose: 'gallery', creatorId: owner.id, contentType: 'image/jpeg' });
  const aPath = media.newMediaPathname({ purpose: 'avatar', creatorId: owner.id, contentType: 'image/png' });
  await creators.setCreatorAvatar(owner.id, media.mediaSrc(aPath));

  check('public gallery item served to anyone', served(await fetchMedia(gPath)));
  check('unreferenced upload is not served to the public', !served(await fetchMedia(orphan)));
  check('unreferenced upload is served to its owner', served(await fetchMedia(orphan, { cookie: cookieFor(ownerUser) })));
  check('current avatar served to anyone', served(await fetchMedia(aPath)));

  await creators.updateCreatorProfile(owner.id, { locked: true, gateTokens: 1000 });
  check('token-gated gallery refused to a fan', !served(await fetchMedia(gPath, { cookie: cookieFor(fan) })));
  check('token-gated gallery served to the owner', served(await fetchMedia(gPath, { cookie: cookieFor(ownerUser) })));
  check('token-gated gallery served to an admin cookie', served(await fetchMedia(gPath, { cookie: adminCookie })));
  check('gated avatar still public', served(await fetchMedia(aPath)));
  await creators.updateCreatorProfile(owner.id, { locked: false, gateTokens: 0, status: 'pending' });
  check('pending creator gallery refused to the public', !served(await fetchMedia(gPath)));
  check('pending creator avatar refused to the public', !served(await fetchMedia(aPath)));
  check('pending creator gallery served to the owner', served(await fetchMedia(gPath, { cookie: cookieFor(ownerUser) })));
  await creators.updateCreatorProfile(owner.id, { status: 'active' });

  const listing = await listings.createListing(owner.id, { title: 'Set', priceCents: 500, kind: 'digital' });
  const lPath = media.newMediaPathname({ purpose: 'listing', creatorId: owner.id, listingId: listing.id, contentType: 'image/jpeg' });
  await listings.addListingMediaForOwner(listing.id, owner.id, { type: 'image', src: media.mediaSrc(lPath) }, [], 10);
  check('paid listing media refused to anonymous visitors', !served(await fetchMedia(lPath)));
  check('paid listing media refused to a non-buyer fan', !served(await fetchMedia(lPath, { cookie: cookieFor(fan) })));
  check('paid listing media served to the owner', served(await fetchMedia(lPath, { cookie: cookieFor(ownerUser) })));
  await query('insert into orders (data) values ($1)', [{ listingId: listing.id, creatorId: owner.id, buyerId: buyer.id, kind: 'digital', status: 'fulfilled' }]);
  check('buyerHasDigitalOrder sees the order', await media.buyerHasDigitalOrder(buyer.id, listing.id));
  check('paid listing media served to the buyer', served(await fetchMedia(lPath, { cookie: cookieFor(buyer) })));
  const other = await listings.createListing(owner.id, { title: 'Other', priceCents: 500, kind: 'digital' });
  const oPath = media.newMediaPathname({ purpose: 'listing', creatorId: owner.id, listingId: other.id, contentType: 'image/jpeg' });
  await listings.addListingMediaForOwner(other.id, owner.id, { type: 'image', src: media.mediaSrc(oPath) }, [], 10);
  check("a buyer of one listing cannot open another listing's media", !served(await fetchMedia(oPath, { cookie: cookieFor(buyer) })));
  console.error = () => {};
  await listings.markListingRemoved(listing.id);
  console.error = origError;
  check('moderation removal cuts off even the buyer', !served(await fetchMedia(lPath, { cookie: cookieFor(buyer) })));
  const physical = await query('insert into orders (data) values ($1) returning id', [{ listingId: other.id, creatorId: owner.id, buyerId: fan.id, kind: 'physical', status: 'pending_shipment' }]);
  check('a physical order does not unlock digital media', physical.rows.length === 1 && !served(await fetchMedia(oPath, { cookie: cookieFor(fan) })));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
