// The AI "house" model roster (lib/house-roster.js): install, resume, labels
// on the data, and -- the money path -- a house sale is 100% platform revenue:
// the fan is debited and no user is credited. Real Postgres, not mocks.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test \
//   node --import ./test-register.mjs lib/b1roster.test.mjs
//
// Every section starts from a truncated database, so this refuses to run
// against anything but a local scratch database.

import { query, closePool } from './db.js';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
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

process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';

const roster = await import('./house-roster.js');
const data = await import('../data/house-roster.js');
const credits = await import('./credits-store.js');
const ordersStore = await import('./orders-store.js');
const usersStore = await import('./users-store.js');
const creatorsStore = await import('./creators-store.js');
const status = await import('./creator-status.js');
const { FEES } = await import('./fees.js');
const { screenPublicText } = await import('./prohibited-terms.js');

async function reset() {
  await query(
    `truncate creators, users, listings, orders, credit_balances, credit_ledger, payout_requests,
       checkout_idempotency, used_payment_tx, notifications, media_uploads restart identity`,
  );
  await query('delete from app_meta');
}

// Test doubles for the image reader and the Blob uploader: the install is
// exercised end to end against the database without files or storage.
const uploads = [];
const fakeRead = async (slug, n) => Buffer.from(`jpeg ${slug} ${n}`);
const fakeUpload = async (pathname) => { uploads.push(pathname); };
const install = (opts = {}) => roster.installHouseRoster({
  readImage: fakeRead,
  uploadImage: fakeUpload,
  requireBlob: false,
  requireProfileImages: false,
  timeBudgetMs: 600_000,
  ...opts,
});

let userSeq = 0;
async function mkUser(role = 'fan', extra = {}) {
  userSeq += 1;
  return usersStore.createUser({ email: `b1u${userSeq}@test.local`, password: 'password123', role, ...extra });
}
async function mkCreatorUser() {
  userSeq += 1;
  const creator = await creatorsStore.createCreator({ name: `C${userSeq}`, handle: `@b1c${userSeq}`, status: 'active', locked: false });
  const user = await usersStore.createUser({ email: `b1c${userSeq}@test.local`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}

async function houseListings() {
  const { rows } = await query(`select id, data from listings where data->>'houseSlug' is not null order by id`);
  return rows.map((r) => ({ ...r.data, id: String(r.id) }));
}
async function houseCreators() {
  const { rows } = await query(`select id, data from creators where coalesce((data->>'house')::boolean, false) order by id`);
  return rows.map((r) => ({ ...r.data, id: String(r.id) }));
}
function itemFor(listing, creatorUserId = null) {
  return {
    listingId: listing.id,
    creatorId: listing.creatorId,
    creatorUserId,
    priceCents: listing.priceCents,
    kind: 'digital',
    unlimited: true,
    title: listing.title,
  };
}
const net = (cents) => cents - Math.round((cents * FEES.MARKETPLACE_BPS) / 10_000);

section('roster text: every bio, handle, tag, title and description passes the public screens');
{
  const hits = [];
  for (const m of data.HOUSE_MODELS) {
    const entries = [
      ['name', m.name],
      ['handle', m.handle],
      ['bio', data.houseBio(m)],
      ...m.tags.map((t) => ['tag', t]),
      ...data.HOUSE_LISTINGS.flatMap((p) => [['title', data.houseListingTitle(m, p)], ['description', data.houseListingDescription(m, p)]]),
    ];
    for (const [context, text] of entries) {
      const r = screenPublicText(text, { context });
      if (r) hits.push(`${m.slug} ${context}: ${text} -> ${r.kind}`);
    }
    if (!/AI model by OnlyOne/.test(data.houseBio(m))) hits.push(`${m.slug} bio lacks the AI statement`);
  }
  check('no screen hits and every bio states it is an AI model', hits.length === 0, hits.join(' | '));
  check('8 models, 5 listings each, prices 500..2500', data.HOUSE_MODELS.length === 8
    && data.HOUSE_LISTINGS.length === 5
    && data.HOUSE_LISTINGS.every((p) => p.priceCents >= 500 && p.priceCents <= 2500));
}

section('install needs no payee; a legacy payeeEmail is ignored and a leftover payee row is cleared');
{
  await reset();
  await query(`insert into app_meta (key, value) values ('house_payee_user_id', '"123"'::jsonb)`);
  const out = await install({ payeeEmail: 'nobody@test.local' });
  check('install completes', out.done === true);
  check('status carries no payee', !('payee' in out.status));
  check('leftover payee row cleared', (await query(`select 1 from app_meta where key = 'house_payee_user_id'`)).rowCount === 0);
  check('no login was created', (await usersStore.getUsers()).length === 0);
}

section('a partial install leaves incomplete listings OFF sale; resuming completes and activates them');
{
  await reset();
  const out = await install({ timeBudgetMs: -1 });
  check('first call reports done: false', out.done === false);
  const partial = await houseListings();
  check('the listing it started is not on sale', partial.length >= 1 && partial.every((l) => l.status !== 'active'), JSON.stringify(partial.map((l) => l.status)));
  check('its off-sale flags stay private', !('houseIncomplete' in status.toPublicListing(partial[0])) && !('houseRemoved' in status.toPublicListing(partial[0])));

  await install();

  const listings = await houseListings();
  check('resume: 40 listings (8 x 5)', listings.length === 40, listings.length);
  check('resume: every listing on sale', listings.every((l) => l.status === 'active'));
  check('resume: every listing holds exactly its plan\'s images', listings.every((l) => {
    const plan = data.HOUSE_LISTINGS.find((p) => p.key === l.houseKey);
    const got = (l.media || []).map((m) => m.houseImage).sort((a, b) => a - b);
    return plan && JSON.stringify(got) === JSON.stringify(plan.images);
  }));
  check('every listing and media item is marked AI-generated', listings.every((l) => l.aiGenerated === true && (l.media || []).every((m) => m.aiGenerated === true)));
  const creators = await houseCreators();
  check('8 house creators, active, house + aiModel', creators.length === 8 && creators.every((c) => c.status === 'active' && c.house === true && c.aiModel === true));
  check('house creators never get a login', (await Promise.all(creators.map((c) => usersStore.findUserByCreatorId(c.id)))).every((u) => !u));
  check('the install creates no login at all', (await usersStore.getUsers()).length === 0);
  check('public projection labels the creator AI', status.isAiModelCreator(status.toPublicCreator(creators[0])) && status.toPublicCreator(creators[0]).house === true);

  const before = uploads.length;
  const again = await install();
  check('re-running uploads nothing and duplicates nothing', again.done === true && again.uploaded === 0 && uploads.length === before
    && (await houseListings()).length === 40 && (await houseCreators()).length === 8);
  check('status reports complete', again.status.complete === true);
}

section('an on-sale house listing missing an image is taken back off sale by the next install');
{
  const [l] = await houseListings();
  await query(`update listings set data = jsonb_set(data, '{media}', '[]'::jsonb) where id = $1`, [l.id]);
  // Upsert alone (no image pass) must deactivate it.
  const model = data.HOUSE_MODELS.find((m) => m.slug === l.houseSlug);
  const plan = data.HOUSE_LISTINGS.find((p) => p.key === l.houseKey);
  const after = await roster.upsertHouseListing(model, plan, l.creatorId);
  check('deactivated when its images are gone', after.status === 'removed' && after.houseIncomplete === true);
  check('activate refuses while incomplete', (await roster.activateHouseListing(l.id, plan)) === false);
  await install();
  const { rows } = await query('select data from listings where id = $1', [l.id]);
  check('install re-attaches and re-activates it', rows[0].data.status === 'active' && rows[0].data.media.length === plan.images.length);
}

section('a house purchase debits the fan, credits nobody, and records the whole price as platform revenue');
let houseListing;
{
  houseListing = (await houseListings()).find((l) => l.houseKey === 'bundle-all');
  const bystander = await mkCreatorUser();
  const buyer = await mkUser('fan');
  await credits.creditAccount({ userId: buyer.id, cents: 10_000, type: 'deposit' });
  const balancesBefore = (await query('select coalesce(sum(balance_cents), 0)::bigint as s from credit_balances')).rows[0].s;
  // Whatever creatorUserId the caller sends is ignored for a house seller.
  const orders = await ordersStore.createOrdersFromCredits({
    buyerId: buyer.id, items: [itemFor(houseListing, bystander.user.id)], ageConfirmed: true, tosAccepted: true, idempotencyKey: 'house-k1',
  });
  check('order placed', orders.length === 1);
  check('buyer charged the list price', (await credits.getBalanceCents(buyer.id)) === 10_000 - houseListing.priceCents);
  check('the sent creatorUserId was not paid', (await credits.getBalanceCents(bystander.user.id)) === 0);
  const balancesAfter = (await query('select coalesce(sum(balance_cents), 0)::bigint as s from credit_balances')).rows[0].s;
  check('no balance anywhere rose: the whole price left user balances', Number(balancesBefore) - Number(balancesAfter) === houseListing.priceCents, `${balancesBefore} -> ${balancesAfter}`);
  const { rows: led } = await query(`select user_id, type, amount_cents, meta from credit_ledger where type like 'marketplace%' order by id`);
  check('exactly one marketplace ledger row (the fan debit), no earn row', led.length === 1 && led[0].type === 'marketplace_charge' && String(led[0].user_id) === String(buyer.id), JSON.stringify(led));
  const m = led[0].meta;
  check('debit row references the listing and marks the house sale as platform revenue',
    Number(led[0].amount_cents) === -houseListing.priceCents && String(m.listingId) === String(houseListing.id)
      && m.houseSale === true && String(m.houseCreatorId) === String(houseListing.creatorId)
      && m.platformRevenueCents === houseListing.priceCents && m.feeCents === houseListing.priceCents && m.feeBps === 10_000, JSON.stringify(m));
  const { rows } = await query('select data from orders order by id desc limit 1');
  const o = rows[0].data;
  check('order records the house sale as platform revenue, with no paid user', o.houseSale === true && o.platformRevenueCents === houseListing.priceCents
    && o.creatorNetCents === 0 && o.feeBps === 10_000 && !('paidToUserId' in o), JSON.stringify(o));
  check('no sale notification written for anyone', (await query(`select 1 from notifications where type = 'sale'`)).rowCount === 0);
  check('buyer view carries no house/revenue fields', !('houseSale' in ordersStore.toBuyerOrder(o)) && !('platformRevenueCents' in ordersStore.toBuyerOrder(o)));
  const summaries = await ordersStore.getOrderSummariesForAdmin({ buyerId: buyer.id });
  check('admin summary works with no seller login and flags the house sale', summaries.length === 1 && summaries[0].houseSale === true && summaries[0].seller.hasLogin === false, JSON.stringify(summaries[0]?.seller));

  let dup = null;
  try {
    await ordersStore.createOrdersFromCredits({ buyerId: buyer.id, items: [itemFor(houseListing)], ageConfirmed: true, tosAccepted: true, idempotencyKey: 'house-k1' });
  } catch (e) { dup = e.code; }
  check('same idempotency key is refused as DUPLICATE_CHECKOUT', dup === 'DUPLICATE_CHECKOUT', dup);
  check('and charged nothing more', (await credits.getBalanceCents(buyer.id)) === 10_000 - houseListing.priceCents);

  let owned = null;
  try {
    await ordersStore.createOrdersFromCredits({ buyerId: buyer.id, items: [itemFor(houseListing)], ageConfirmed: true, tosAccepted: true, idempotencyKey: 'house-k2' });
  } catch (e) { owned = e.code; }
  check('buying the same digital house listing again is ALREADY_OWNED', owned === ordersStore.ALREADY_OWNED, owned);
}

section('a one-of-a-kind house listing sells once; the loser is not charged');
{
  const l = (await houseListings()).find((x) => x.houseKey !== 'bundle-all');
  await query(`update listings set data = data || '{"unlimited": false}'::jsonb where id = $1`, [l.id]);
  const a = await mkUser('fan');
  const b = await mkUser('fan');
  for (const u of [a, b]) await credits.creditAccount({ userId: u.id, cents: 10_000, type: 'deposit' });
  const item = { ...itemFor(l), unlimited: false };
  const results = await Promise.allSettled([a, b].map((u) => ordersStore.createOrdersFromCredits({ buyerId: u.id, items: [item], ageConfirmed: true, tosAccepted: true })));
  const won = results.filter((r) => r.status === 'fulfilled').length;
  const bal = [await credits.getBalanceCents(a.id), await credits.getBalanceCents(b.id)].sort((x, y) => x - y);
  check('exactly one buyer wins', won === 1, JSON.stringify(results.map((r) => r.status === 'rejected' ? r.reason.code : 'ok')));
  check('only the winner is charged', bal[0] === 10_000 - l.priceCents && bal[1] === 10_000, JSON.stringify(bal));
  const { rows } = await query('select data from listings where id = $1', [l.id]);
  check('listing marked sold', rows[0].data.status === 'sold');
}

section('transferWithFee refuses to pay anyone for a house sale');
{
  const other = await mkCreatorUser();
  const buyer = await mkUser('fan');
  await credits.creditAccount({ userId: buyer.id, cents: 5_000, type: 'deposit' });
  let code = null;
  try {
    await credits.transferWithFee({ fromUserId: buyer.id, toUserId: other.user.id, cents: 500, feeBps: FEES.MARKETPLACE_BPS, type: 'marketplace', sellerCreatorId: houseListing.creatorId });
  } catch (err) { code = err.code; }
  check('refused with RECIPIENT_UNAVAILABLE', code === credits.RECIPIENT_UNAVAILABLE, code);
  check('nothing moved', (await credits.getBalanceCents(buyer.id)) === 5_000 && (await credits.getBalanceCents(other.user.id)) === 0);
  check('a house profile never gains an owner login', !(await usersStore.findUserByCreatorId(houseListing.creatorId)));
}

section('a mixed cart: the real creator is paid their net, the house item is platform revenue');
{
  const { creator, user } = await mkCreatorUser();
  const { rows: ownRows } = await query('insert into listings (data) values ($1) returning id', [JSON.stringify({
    creatorId: String(creator.id), title: 'Real listing', description: 'x', priceCents: 1000, unlimited: true, kind: 'digital',
    status: 'active', media: [{ type: 'image', src: '/images/x.jpg' }], createdAt: new Date().toISOString(),
  })]);
  const own = ownRows[0];
  {
    const buyer = await mkUser('fan');
    await credits.creditAccount({ userId: buyer.id, cents: 20_000, type: 'deposit' });
    const hl = (await houseListings()).find((x) => x.status === 'active' && x.unlimited !== false);
    await ordersStore.createOrdersFromCredits({
      buyerId: buyer.id,
      items: [itemFor(hl), { listingId: String(own.id), creatorId: String(creator.id), creatorUserId: user.id, priceCents: 1000, kind: 'digital', unlimited: true, title: 'Real listing' }],
      ageConfirmed: true, tosAccepted: true,
    });
    check('buyer charged both', (await credits.getBalanceCents(buyer.id)) === 20_000 - hl.priceCents - 1000);
    check('real creator gets the net of the 15% fee only', (await credits.getBalanceCents(user.id)) === net(1000));
    check('real creator notified, house sale not', (await query(`select user_id from notifications where type = 'sale'`)).rows.map((r) => String(r.user_id)).join() === String(user.id));
  }
}

section('remove hides the models and unlists their listings; buying is refused; orders survive');
{
  const ordersBefore = (await query('select count(*)::int as n from orders')).rows[0].n;
  const out = await roster.removeHouseRoster();
  check('8 hidden, 40 unlisted', out.hiddenCreators === 8 && out.unlistedListings >= 39, JSON.stringify(out));
  const c = (await houseCreators())[0];
  check('hidden model is not publicly visible and cannot sell', !status.isPubliclyVisible(c) && !credits.canSellAsHouse(c));
  const buyer = await mkUser('fan');
  await credits.creditAccount({ userId: buyer.id, cents: 10_000, type: 'deposit' });
  let code = null;
  try {
    await ordersStore.createOrdersFromCredits({ buyerId: buyer.id, items: [itemFor(houseListing)], ageConfirmed: true, tosAccepted: true });
  } catch (e) { code = e.code; }
  check('purchase refused', code === 'LISTING_UNAVAILABLE', code);
  check('buyer not charged', (await credits.getBalanceCents(buyer.id)) === 10_000);
  // chargeHouseSale itself refuses a hidden model even if called directly.
  let code2 = null;
  try {
    await credits.chargeHouseSale({ fromUserId: buyer.id, cents: 500, sellerCreatorId: houseListing.creatorId, type: 'marketplace' });
  } catch (e) { code2 = e.code; }
  check('chargeHouseSale refuses a hidden model', code2 === credits.RECIPIENT_UNAVAILABLE, code2);
  check('still not charged', (await credits.getBalanceCents(buyer.id)) === 10_000);
  check('no order deleted', (await query('select count(*)::int as n from orders')).rows[0].n === ordersBefore);
  const back = await install();
  check('installing again restores them', back.status.hidden === false && (await houseListings()).filter((l) => l.status !== 'sold').every((l) => l.status === 'active'));
}

section('an incomplete house listing cannot be bought');
{
  const l = (await houseListings()).find((x) => x.status === 'active');
  const model = data.HOUSE_MODELS.find((m) => m.slug === l.houseSlug);
  const plan = data.HOUSE_LISTINGS.find((p) => p.key === l.houseKey);
  await query(`update listings set data = jsonb_set(data, '{media}', '[]'::jsonb) where id = $1`, [l.id]);
  await roster.upsertHouseListing(model, plan, l.creatorId);
  const buyer = await mkUser('fan');
  await credits.creditAccount({ userId: buyer.id, cents: 10_000, type: 'deposit' });
  let code = null;
  try {
    await ordersStore.createOrdersFromCredits({ buyerId: buyer.id, items: [itemFor(l)], ageConfirmed: true, tosAccepted: true });
  } catch (e) { code = e.code; }
  check('refused', code === 'LISTING_UNAVAILABLE', code);
  check('not charged', (await credits.getBalanceCents(buyer.id)) === 10_000);
  await install();
}

section('a house model marked demo cannot sell');
{
  const l = (await houseListings()).find((x) => x.status === 'active');
  await query(`update creators set data = data || '{"demo": true}'::jsonb where id = $1`, [l.creatorId]);
  const buyer = await mkUser('fan');
  await credits.creditAccount({ userId: buyer.id, cents: 10_000, type: 'deposit' });
  let code = null;
  try {
    await ordersStore.createOrdersFromCredits({ buyerId: buyer.id, items: [itemFor(l)], ageConfirmed: true, tosAccepted: true });
  } catch (e) { code = e.code; }
  check('refused', code === 'LISTING_UNAVAILABLE' || code === credits.RECIPIENT_UNAVAILABLE, code);
  check('not charged', (await credits.getBalanceCents(buyer.id)) === 10_000);
  await query(`update creators set data = data || '{"demo": false}'::jsonb where id = $1`, [l.creatorId]);
}

section('a moderation-removed house listing is never reactivated by the install');
{
  const [l] = await houseListings();
  await query(`update listings set data = data || '{"status":"removed","moderationRemoved":true}'::jsonb where id = $1`, [l.id]);
  await install();
  const { rows } = await query('select data from listings where id = $1', [l.id]);
  check('stays removed', rows[0].data.status === 'removed');
}

section('house images stay behind the age gate (proxy.js), sale images are not under public/');
{
  // Same resolve hook as lib/age-gate.test.mjs: bare Node cannot resolve the
  // extensionless 'next/server' that proxy.js imports.
  const { register, createRequire } = await import('node:module');
  const hook = `export async function resolve(s, c, n) { return n(s === 'next/server' ? 'next/server.js' : s, c); }`;
  register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);
  const { NextRequest } = createRequire(import.meta.url)('next/server.js');
  const { proxy } = await import('../proxy.js');
  const run = async (path, headers = {}) => proxy(new NextRequest(`https://www.joinonlyone.com${path}`, { headers: { host: 'www.joinonlyone.com', ...headers } }));
  const rewrittenTo = (res) => res.headers.get('x-middleware-rewrite') || '';
  for (const m of data.HOUSE_MODELS.slice(0, 2)) {
    for (const src of [data.houseAvatarSrc(m.slug), data.houseCoverSrc(m.slug)]) {
      check(`${src} gated from a blocked state (TX)`, rewrittenTo(await run(src, { 'x-vercel-ip-country': 'US', 'x-vercel-ip-country-region': 'TX' })).endsWith('/blocked-region'));
      check(`${src} gated outside the US`, rewrittenTo(await run(src, { 'x-vercel-ip-country': 'GB' })).endsWith('/blocked-region'));
    }
  }
  check('sale images live outside public/', !roster.saleImageFile('nova-reyes', 1).includes(`${'/'}public${'/'}`));
}

section('public images: avatar, cover and two free previews per model; gallery = cover + free previews');
{
  for (const m of data.HOUSE_MODELS) {
    const srcs = data.housePublicImageSrcs(m.slug);
    check(`${m.slug}: 4 public images, all under /images/house/${m.slug}/`, srcs.length === 4 && srcs.every((s) => s.startsWith(`/images/house/${m.slug}/`)));
    const g = data.houseGallery(m.slug);
    check(`${m.slug}: gallery is cover + free-1 + free-2, all aiGenerated`,
      JSON.stringify(g.map((x) => x.src)) === JSON.stringify([data.houseCoverSrc(m.slug), data.houseFreeSrc(m.slug, 1), data.houseFreeSrc(m.slug, 2)])
        && g.every((x) => x.type === 'image' && x.aiGenerated === true));
    check(`${m.slug}: no sale image is public`, srcs.every((s) => !/sale-/.test(s)));
  }
  await reset();
  await install();
  const { rows } = await query(`select data from creators where coalesce((data->>'house')::boolean, false)`);
  check('installed creators carry the 3-image gallery', rows.length === data.HOUSE_MODELS.length
    && rows.every((r) => Array.isArray(r.data.gallery) && r.data.gallery.length === 3 && r.data.gallery.every((x) => x.aiGenerated === true)));
  // The deployment check: whatever is on disk, the report must agree with it.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const onDisk = data.HOUSE_MODELS.every((m) => data.housePublicImageSrcs(m.slug).every((src) => fs.existsSync(path.join(process.cwd(), 'public', src))));
  check('profileImagesDeployed() matches the files on disk (incl. free previews)', roster.profileImagesDeployed() === onDisk);
  check('the default install refuses while any public image is missing', onDisk || await roster.installHouseRoster({ readImage: fakeRead, uploadImage: fakeUpload, requireBlob: false, timeBudgetMs: 1 }).then(() => false, (e) => e.code === roster.HOUSE_ERRORS.IMAGES_MISSING));
  if (process.env.EXPECT_HOUSE_IMAGES === '1') check('houseImagesDeployed() is true (all 80 files present)', roster.houseImagesDeployed());
}

await closePool();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
