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

// Test doubles for the Blob uploader (the owner's sale-photo uploads) and the
// Blob copier (install: master -> each listing's own copy): the flow is
// exercised end to end against the database without storage.
const uploads = [];
const copies = [];
const fakeUpload = async (pathname) => { uploads.push(pathname); };
const fakeCopy = async (from, to) => { copies.push({ from, to }); };
const jpeg = (tag = '') => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.from(`jpeg ${tag}`)]);
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.from([0, 0, 2, 0]), Buffer.from('isomiso2avc1mp41 ....mp4 body')]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('....png body')]);
const saveSlot = (slug, n, opts = {}) => roster.saveHouseSaleImage({ slug, n, bytes: jpeg(`${slug} ${n}`), contentType: 'image/jpeg', uploadImage: fakeUpload, ...opts });
async function registerModel(slug) {
  for (let n = 1; n <= data.HOUSE_SALE_IMAGE_COUNT; n += 1) await saveSlot(slug, n);
}
async function registerAll() {
  for (const m of data.HOUSE_MODELS) await registerModel(m.slug);
}
const install = (opts = {}) => roster.installHouseRoster({
  copyImage: fakeCopy,
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
  check('19 models, 5 photo + 4 video listings each, prices 500..2500', data.HOUSE_MODELS.length === 19
    && data.HOUSE_LISTINGS.filter((p) => !p.clip).length === 5
    && data.HOUSE_LISTINGS.filter((p) => p.clip).length === 4
    && data.HOUSE_LISTINGS.every((p) => p.priceCents >= 500 && p.priceCents <= 2500));
  check('video plans hold only clip slots, photo plans only photo slots', data.HOUSE_LISTINGS.every((p) => p.images.every((n) => data.isHouseClipSlot(n) === !!p.clip)));
}

section('install needs no payee; a legacy payeeEmail is ignored and a leftover payee row is cleared');
{
  await reset();
  await registerAll();
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
  await registerAll();
  const out = await install({ timeBudgetMs: -1 });
  check('first call reports done: false', out.done === false);
  const partial = await houseListings();
  check('the listing it started is not on sale', partial.length >= 1 && partial.every((l) => l.status !== 'active'), JSON.stringify(partial.map((l) => l.status)));
  check('its off-sale flags stay private', !('houseIncomplete' in status.toPublicListing(partial[0])) && !('houseRemoved' in status.toPublicListing(partial[0])));

  await install();

  const listings = await houseListings();
  check('resume: 5 photo listings per model (no clips uploaded)', listings.length === data.HOUSE_MODELS.length * 5, listings.length);
  check('resume: every listing on sale', listings.every((l) => l.status === 'active'));
  check('resume: every listing holds exactly its plan\'s images', listings.every((l) => {
    const plan = data.HOUSE_LISTINGS.find((p) => p.key === l.houseKey);
    const got = (l.media || []).map((m) => m.houseImage).sort((a, b) => a - b);
    return plan && JSON.stringify(got) === JSON.stringify(plan.images);
  }));
  check('every listing and media item is marked AI-generated', listings.every((l) => l.aiGenerated === true && (l.media || []).every((m) => m.aiGenerated === true)));
  const creators = await houseCreators();
  check('every house creator installed, active, house + aiModel', creators.length === data.HOUSE_MODELS.length && creators.every((c) => c.status === 'active' && c.house === true && c.aiModel === true));
  check('house creators never get a login', (await Promise.all(creators.map((c) => usersStore.findUserByCreatorId(c.id)))).every((u) => !u));
  check('the install creates no login at all', (await usersStore.getUsers()).length === 0);
  check('public projection labels the creator AI', status.isAiModelCreator(status.toPublicCreator(creators[0])) && status.toPublicCreator(creators[0]).house === true);

  const before = copies.length;
  const again = await install();
  check('re-running copies nothing and duplicates nothing', again.done === true && again.uploaded === 0 && copies.length === before
    && (await houseListings()).length === data.HOUSE_MODELS.length * 5 && (await houseCreators()).length === data.HOUSE_MODELS.length);
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
  check('all hidden, all unlisted', out.hiddenCreators === data.HOUSE_MODELS.length && out.unlistedListings >= data.HOUSE_MODELS.length * 5 - 1, JSON.stringify(out));
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
  const reg = await roster.getHouseSaleImageRegistry();
  const masters = Object.values(reg).flatMap((slots) => Object.values(slots).map((x) => x.pathname));
  check('sale-image masters are private Blob paths, never public/ files', masters.length > 0 && masters.every((p) => /^house-sale\//.test(p) && !p.includes('public')));
  const mediaLib = await import('./media.js');
  check('/api/media never serves a master (not a media pathname)', masters.every((p) => mediaLib.parseMediaPathname(p) === null));
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
  await registerAll();
  await install();
  const { rows } = await query(`select data from creators where coalesce((data->>'house')::boolean, false)`);
  check('installed creators carry the 3-image gallery', rows.length === data.HOUSE_MODELS.length
    && rows.every((r) => Array.isArray(r.data.gallery) && r.data.gallery.length === 3 && r.data.gallery.every((x) => x.aiGenerated === true)));
  // The deployment check: whatever is on disk, the report must agree with it.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const onDisk = data.HOUSE_MODELS.every((m) => data.housePublicImageSrcs(m.slug).every((src) => fs.existsSync(path.join(process.cwd(), 'public', src))));
  check('profileImagesDeployed() matches the files on disk (incl. free previews)', roster.profileImagesDeployed() === onDisk);
  check('the default install refuses while any public image is missing', onDisk || await roster.installHouseRoster({ copyImage: fakeCopy, requireBlob: false, timeBudgetMs: 1 }).then(() => false, (e) => e.code === roster.HOUSE_ERRORS.IMAGES_MISSING));
  if (process.env.EXPECT_HOUSE_IMAGES === '1') check('profileImagesDeployed() is true (every model's 4 public files present)', roster.profileImagesDeployed());
}

section('video clips: clip listings wait for their clips, then sell as video');
{
  await reset();
  await registerAll();
  for (const n of [7, 8, 9]) await saveSlot('nova-reyes', n, { bytes: mp4(), contentType: 'video/mp4' });
  await saveSlot('kira-sato', 7, { bytes: mp4(), contentType: 'video/mp4' });
  await install();
  const all = await houseListings();
  const nova = all.filter((l) => l.houseSlug === 'nova-reyes');
  const kira = all.filter((l) => l.houseSlug === 'kira-sato');
  check('nova: 5 photo + 4 video listings', nova.length === 9, nova.length);
  check('kira: only Video 1 of the clips (others not uploaded)', kira.filter((l) => /^clip/.test(l.houseKey)).map((l) => l.houseKey).join() === 'clip-1');
  check('other models: no video listings', all.filter((l) => !['nova-reyes', 'kira-sato'].includes(l.houseSlug)).every((l) => !/^clip/.test(l.houseKey)));
  const bundle = nova.find((l) => l.houseKey === 'clips-all');
  check('3-video bundle on sale with 3 video items', bundle && bundle.status === 'active' && bundle.media.length === 3 && bundle.media.every((m) => m.type === 'video' && /\.mp4$/.test(m.src)));
  check('video listing text passes the public screens', nova.filter((l) => /^clip/.test(l.houseKey)).every((l) => !screenPublicText(l.title) && !screenPublicText(l.description)));
  const st = await roster.getHouseRosterStatus();
  const ns = st.models.find((m) => m.slug === 'nova-reyes');
  check('status: nine slots, three of them clips', ns.slots.length === 9 && ns.slots.filter((x) => x.clip).length === 3);
  check('status: complete counts only uploadable plans', st.complete === true);
}

section('sale-image slots: validation');
{
  await reset();
  const code = async (fn) => { try { await fn(); return null; } catch (e) { return e.code; } };
  const B = roster.HOUSE_ERRORS.BAD_SLOT;
  check('unknown slug refused', (await code(() => saveSlot('nobody', 1))) === B);
  check('n = 0 refused', (await code(() => saveSlot('nova-reyes', 0))) === B);
  check('n = 10 refused', (await code(() => saveSlot('nova-reyes', 10))) === B);
  check('a photo in a video slot refused', (await code(() => saveSlot('nova-reyes', 7))) === roster.HOUSE_ERRORS.BAD_IMAGE);
  check('an MP4 in a photo slot refused', (await code(() => saveSlot('nova-reyes', 1, { bytes: mp4(), contentType: 'video/mp4' }))) === roster.HOUSE_ERRORS.BAD_IMAGE);
  check('a JPEG declared as MP4 refused', (await code(() => saveSlot('nova-reyes', 7, { contentType: 'video/mp4' }))) === roster.HOUSE_ERRORS.BAD_IMAGE);
  check('an MP4 in a video slot accepted', (await code(() => saveSlot('kira-sato', 7, { bytes: mp4(), contentType: 'video/mp4' }))) === null);
  check("n = '1.5' refused", (await code(() => saveSlot('nova-reyes', '1.5'))) === B);
  check('non-string slug refused', (await code(() => saveSlot({}, 1))) === B);
  check('gif refused', (await code(() => saveSlot('nova-reyes', 1, { contentType: 'image/gif' }))) === roster.HOUSE_ERRORS.BAD_IMAGE);
  check('svg refused', (await code(() => saveSlot('nova-reyes', 1, { contentType: 'image/svg+xml' }))) === roster.HOUSE_ERRORS.BAD_IMAGE);
  check('PNG bytes declared as JPEG refused', (await code(() => saveSlot('nova-reyes', 1, { bytes: png() }))) === roster.HOUSE_ERRORS.BAD_IMAGE);
  check('HTML bytes declared as JPEG refused', (await code(() => saveSlot('nova-reyes', 1, { bytes: Buffer.from('<html><script>x</script></html>') }))) === roster.HOUSE_ERRORS.BAD_IMAGE);
  check('empty refused', (await code(() => saveSlot('nova-reyes', 1, { bytes: Buffer.alloc(0) }))) === roster.HOUSE_ERRORS.BAD_IMAGE);
  check('over the cap refused', (await code(() => saveSlot('nova-reyes', 1, { bytes: Buffer.concat([jpeg(), Buffer.alloc(roster.HOUSE_SALE_IMAGE_MAX_BYTES)]) }))) === roster.HOUSE_ERRORS.IMAGE_TOO_LARGE);
  const upBefore = uploads.length;
  check('a refused upload uploads nothing and records nothing', uploads.length === upBefore
    && Object.keys((await roster.getHouseSaleImageRegistry())['nova-reyes']).length === 0);
  const ok = await roster.saveHouseSaleImage({ slug: 'nova-reyes', n: '2', bytes: png(), contentType: 'image/png', uploadImage: fakeUpload });
  const reg = await roster.getHouseSaleImageRegistry();
  check('a PNG in slot 2 is accepted and recorded', ok.n === 2 && ok.replaced === false && reg['nova-reyes'][2]?.contentType === 'image/png' && /\.png$/.test(reg['nova-reyes'][2].pathname));
  check('the registry ignores a forged row pointing outside house-sale/', await (async () => {
    await query(`insert into app_meta (key, value) values ('house_sale_image:nova-reyes:3', $1::jsonb)`, [JSON.stringify({ slug: 'nova-reyes', n: 3, pathname: 'listings/1/2/x.jpg', contentType: 'image/jpeg' })]);
    return !(await roster.getHouseSaleImageRegistry())['nova-reyes'][3];
  })());
}

section('per-model install: only a complete model is installed and activated');
{
  await reset();
  await registerModel('kira-sato');
  for (let n = 1; n <= 5; n += 1) await saveSlot('dante-cruz', n); // one photo short
  const out = await install();
  check('only the ready model is installed', JSON.stringify(out.installed) === JSON.stringify(['kira-sato']), JSON.stringify(out.installed));
  check('the model one photo short is skipped, naming photo 6', out.skipped.some((x) => x.slug === 'dante-cruz' && JSON.stringify(x.missingSlots) === '[6]'));
  const cs = await houseCreators();
  check('exactly one house creator exists, active', cs.length === 1 && cs[0].houseSlug === 'kira-sato' && cs[0].status === 'active');
  const ls = await houseListings();
  check('its 5 listings are all on sale', ls.length === 5 && ls.every((l) => l.status === 'active'));
  const st = out.status.models.find((m) => m.slug === 'dante-cruz');
  check('status shows dante-cruz not ready with 5 of 6 slots filled', st.ready === false && st.slots.filter((x) => x.filled).length === 5 && st.slots.every((x) => !('pathname' in x)));
  let code = null;
  try { await install({ slug: 'dante-cruz' }); } catch (e) { code = e.code; }
  check('installing the incomplete model by name is refused', code === roster.HOUSE_ERRORS.IMAGES_MISSING, code);
  check('and changed nothing', (await houseCreators()).length === 1 && (await houseListings()).length === 5);
  await saveSlot('dante-cruz', 6);
  const two = await install({ slug: 'dante-cruz' });
  check('once complete it installs alone', JSON.stringify(two.installed) === JSON.stringify(['dante-cruz']) && (await houseCreators()).length === 2
    && (await houseListings()).filter((l) => l.houseSlug === 'dante-cruz').every((l) => l.status === 'active'));
  let bad = null;
  try { await install({ slug: 'nobody' }); } catch (e) { bad = e.code; }
  check('an unknown slug is refused', bad === roster.HOUSE_ERRORS.BAD_SLOT, bad);
}

section('replacing a slot: listings move to the new file; buyers keep the old one; non-buyers get nothing');
{
  const { default: mediaRoute } = await import('../pages/api/media/[...path].js');
  const { createSessionToken } = await import('./session.js');
  const mediaLib = await import('./media.js');
  const fakeRes = () => ({
    statusCode: 200, headers: {}, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json() { this.headersSent = true; return this; },
    end() { this.headersSent = true; },
  });
  // BLOB_READ_WRITE_TOKEN is unset: an ENTITLED request gets past the checks
  // and fails in sendMedia (not 404); an unentitled one is a 404.
  const fetchAs = async (src, user) => {
    const pathname = mediaLib.pathnameFromMediaSrc(src);
    const req = { method: 'GET', query: { path: pathname.split('/') }, headers: user ? { cookie: `oa_session=${encodeURIComponent(createSessionToken(user.id, 0))}` } : {}, socket: {} };
    const res = fakeRes();
    const e = console.error; const w = console.warn;
    console.error = () => {}; console.warn = () => {};
    try { await mediaRoute(req, res); } finally { console.error = e; console.warn = w; }
    return res.statusCode;
  };
  const served = (c) => c !== 404;

  const set1 = (await houseListings()).find((l) => l.houseSlug === 'kira-sato' && l.houseKey === 'set-1');
  const set1Other = (await houseListings()).find((l) => l.houseSlug === 'dante-cruz' && l.houseKey === 'set-1');
  const buyer = await mkUser('fan');
  const stranger = await mkUser('fan');
  await credits.creditAccount({ userId: buyer.id, cents: 10_000, type: 'deposit' });
  await ordersStore.createOrdersFromCredits({ buyerId: buyer.id, items: [itemFor(set1)], ageConfirmed: true, tosAccepted: true });
  const oldItem = set1.media.find((m) => m.houseImage === 1);
  check('buyer of a house listing is served its media', served(await fetchAs(oldItem.src, buyer)));
  check('a non-buyer is not', (await fetchAs(oldItem.src, stranger)) === 404);
  check('an anonymous visitor is not', (await fetchAs(oldItem.src, null)) === 404);
  const otherItem = set1Other.media.find((m) => m.houseImage === 1);
  check("the buyer is not served another model's listing media", (await fetchAs(otherItem.src, buyer)) === 404);

  const regBefore = (await roster.getHouseSaleImageRegistry())['kira-sato'][1].pathname;
  await new Promise((r) => setTimeout(r, 5));
  const re = await saveSlot('kira-sato', 1);
  const regAfter = await roster.getHouseSaleImageRegistry();
  check('re-upload replaces the slot with a new master', re.replaced === true && regAfter['kira-sato'][1].pathname !== regBefore);
  const { rows: metaRows } = await query(`select value from app_meta where key = 'house_sale_image:kira-sato:1'`);
  check('the old master is kept on record, not deleted', (metaRows[0].value.previous || []).some((x) => x.pathname === regBefore));
  check('status reports copies to update before the sync', (await roster.getHouseRosterStatus()).models.find((m) => m.slug === 'kira-sato').staleImages === 3);

  const synced = await install({ slug: 'kira-sato' });
  check('sync copies image 1 into the three listings that sell it', synced.uploaded === 3, synced.uploaded);
  const after = (await houseListings()).filter((l) => l.houseSlug === 'kira-sato');
  check('every listing selling photo 1 now points at the new master, still on sale', after.filter((l) => data.HOUSE_LISTINGS.find((p) => p.key === l.houseKey).images.includes(1))
    .every((l) => l.status === 'active' && l.media.find((m) => m.houseImage === 1).houseSource === regAfter['kira-sato'][1].pathname && l.media.filter((m) => m.houseImage === 1).length === 1));
  const set1After = after.find((l) => l.houseKey === 'set-1');
  const retained = (set1After.retainedMedia || []).find((m) => m.src === oldItem.src);
  check('the bought listing keeps the old copy in retainedMedia', !!retained && !!retained.removedAt);
  check('the buyer is still served the old copy they bought', served(await fetchAs(oldItem.src, buyer)));
  check('and the new copy', served(await fetchAs(set1After.media.find((m) => m.houseImage === 1).src, buyer)));
  check('a non-buyer gets neither', (await fetchAs(oldItem.src, stranger)) === 404 && (await fetchAs(set1After.media.find((m) => m.houseImage === 1).src, stranger)) === 404);
  const unpaid = after.find((l) => l.houseKey === 'bundle-1-2');
  check('an unbought listing does not keep the old copy', !(unpaid.retainedMedia || []).length);
  const late = await mkUser('fan');
  await credits.creditAccount({ userId: late.id, cents: 10_000, type: 'deposit' });
  await ordersStore.createOrdersFromCredits({ buyerId: late.id, items: [itemFor(set1After)], ageConfirmed: true, tosAccepted: true });
  check('a buyer after the swap gets the new copy, not the retired one', (await fetchAs(oldItem.src, late)) === 404 && served(await fetchAs(set1After.media.find((m) => m.houseImage === 1).src, late)));
  const again = await install({ slug: 'kira-sato' });
  check('a second sync copies nothing', again.uploaded === 0 && (await roster.getHouseRosterStatus()).models.find((m) => m.slug === 'kira-sato').staleImages === 0);
}

section('POST /api/admin/house-sale-image: admin key, slot and storage checks come first');
{
  process.env.ADMIN_UPLOAD_KEY = 'b5-test-admin-key';
  const { default: route } = await import('../pages/api/admin/house-sale-image.js');
  const call = async ({ key, query: q, type = 'image/jpeg', method = 'POST' }) => {
    const res = {
      statusCode: 200, headers: {}, body: null, headersSent: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; this.headersSent = true; return this; },
      end() { this.headersSent = true; },
    };
    const req = { method, query: q, headers: { 'content-type': type, ...(key ? { 'x-admin-key': key } : {}) }, socket: {}, on() {}, resume() {} };
    const e = console.error; console.error = () => {};
    try { await route(req, res); } finally { console.error = e; }
    return res;
  };
  check('no admin key: refused', [401, 403].includes((await call({ query: { slug: 'nova-reyes', n: '1' } })).statusCode));
  check('wrong admin key: refused', [401, 403].includes((await call({ key: 'nope', query: { slug: 'nova-reyes', n: '1' } })).statusCode));
  const bad = await call({ key: 'b5-test-admin-key', query: { slug: 'nobody', n: '1' } });
  check('bad slug: 400 house_bad_slot', bad.statusCode === 400 && bad.body.code === roster.HOUSE_ERRORS.BAD_SLOT);
  const badN = await call({ key: 'b5-test-admin-key', query: { slug: 'nova-reyes', n: '10' } });
  check('bad n: 400', badN.statusCode === 400);
  const noStore = await call({ key: 'b5-test-admin-key', query: { slug: 'nova-reyes', n: '1' } });
  check('storage unconfigured: 503 before the body is read', noStore.statusCode === 503 && noStore.body.code === roster.HOUSE_ERRORS.BLOB_UNCONFIGURED);
  const cross = await call({ key: 'b5-test-admin-key', query: { slug: 'nova-reyes', n: '1' }, type: 'text/plain' });
  check('a cross-site-postable content type is refused', cross.statusCode === 403);
}

await closePool();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
