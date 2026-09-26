// Regression tests for the round-6 backend fixes (package R6B), run against a
// real scratch Postgres (it truncates tables), never mocks:
//  - media#0: quarantining a listing's files takes the listing off sale in the
//    same commit; checkout refuses a listing with a preserved file (a report
//    hold no longer blocks a sale, round 7);
//    delivery withholds preserved files instead of listing broken ones;
//  - media#1: deleteMediaQuietly deletes under the per-file lock and sees a
//    hold that commits while it waits;
//  - media#2: the orphan sweep re-checks references under the lock, and a
//    finalize of a reaped file is refused;
//  - media#3: marketplace/update refuses a non-object `fields`;
//  - money#1: a deposit for a deleted account is refused without claiming the hash;
//  - accounts#0: prohibited phrases split across tags are refused;
//  - accounts#1: a successful login does not reset the per-IP brake;
//  - accounts#2: active -> pending -> active keeps the founding stamp;
//  - accounts#3: approval refused while the login is banned/suspended;
//  - accounts#4: competing storefront links are flagged;
//  - social#0: gallery/avatar reports hold the file and resolve by preserving it;
//  - social#1: a retried paid DM is answered as delivered after a suspension;
//  - social#2: a DM block stops wall comments;
//  - social#3: an oversized §2257 upload gets a real 413;
//  - legal-journeys#1: a public marketplace URL finds the listing's records;
//  - admin-ui#1/#2: account lookup by login; manual credit needs the login;
//  - dashboard#2/#5: inbox fan labels; shipped orders hide the address;
//  - bridge follow-ups: suspendedUntil on exchange tokens and fan pushes,
//    push stamps taken after the commit.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r6b.test.mjs

import crypto from 'crypto';
import { Readable } from 'stream';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
delete process.env.NCII_ALERT_WEBHOOK_URL;
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.BRIDGE_SECRET = 'test-bridge-secret-r6b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r6b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { query, withTransaction, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const mediaRefs = await import('./media-refs.js');
const preservation = await import('./media-preservation.js');
const blobCleanup = await import('./blob-cleanup.js');
const ncii = await import('./ncii-reports-store.js');
const messages = await import('./messages-store.js');
const reportsStore = await import('./reports-store.js');
const credits = await import('./credits-store.js');
const orders = await import('./orders-store.js');
const deposit = await import('./deposit.js');
const records = await import('./performer-records-store.js');
const bridge = await import('./bridge-token.js');
const outbox = await import('./standing-outbox.js');
const { screenPublicText } = await import('./prohibited-terms.js');
const { createSessionToken } = await import('./session.js');
const { default: preservedMediaRoute } = await import('../pages/api/admin/preserved-media.js');
const { default: deliveryRoute } = await import('../pages/api/marketplace/orders/delivery.js');
const { default: updateListingRoute } = await import('../pages/api/marketplace/update.js');
const { default: meProfileRoute } = await import('../pages/api/me/profile.js');
const { default: adminProfileRoute } = await import('../pages/api/admin/profile.js');
const { default: loginRoute } = await import('../pages/api/auth/login.js');
const { default: reportMediaRoute } = await import('../pages/api/creator/report-media.js');
const { default: reportsResolveRoute } = await import('../pages/api/admin/reports-resolve.js');
const { default: wallPostRoute } = await import('../pages/api/wall/post.js');
const { default: docRoute } = await import('../pages/api/admin/performer-record-document.js');
const { default: userModerationRoute } = await import('../pages/api/admin/user-moderation.js');
const { default: manualCreditRoute } = await import('../pages/api/admin/manual-credit.js');
const { default: conversationsRoute } = await import('../pages/api/messages/conversations.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);
const orig = { error: console.error, warn: console.warn, info: console.info };
const quiet = async (fn) => {
  console.error = () => {}; console.warn = () => {}; console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
};
function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    send(b) { this.body = b; this.headersSent = true; return this; },
    end(b) { this.headersSent = true; if (b) { try { this.body = JSON.parse(b); } catch { this.body = b; } } },
    destroy() {},
    on() {}, once() {}, emit() {}, write() { return true; },
  };
}
let ipN = 0;
async function call(route, { method = 'POST', body, query: q = {}, admin = false, user = null, ip = null, req: extra = null } = {}) {
  ipN++;
  const res = fakeRes();
  const addr = ip || `10.66.${Math.floor(ipN / 250)}.${ipN % 250}`;
  const headers = { 'x-forwarded-for': addr };
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  if (user) headers.cookie = `oa_session=${createSessionToken(user.id, user.sessionVersion || 0)}`;
  const req = extra ? Object.assign(extra, { method, query: q, socket: { remoteAddress: addr } }) : { method, body, query: q, socket: { remoteAddress: addr } };
  req.headers = { ...(req.headers || {}), ...headers };
  await quiet(() => route(req, res));
  return res;
}
async function reset() {
  await query(`truncate creators, users, listings, orders, credit_balances, credit_ledger, payout_requests, checkout_idempotency,
    used_payment_tx, ncii_reports, media_uploads, media_reaped, performer_records, media_preservations, media_holds, moderation_actions,
    server_standing_pushes, conversations, reports, violations, wall_posts, favorites, notifications, login_attempts, wall_blocks restart identity`);
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
let n = 0;
async function mkCreatorUser(fields = {}) {
  n++;
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r6bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r6b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan(email = null) {
  n++;
  return users.createUser({ email: email || `f${n}@r6b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
const galleryFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'gallery', creatorId, contentType: 'image/jpeg' }));
const avatarFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'avatar', creatorId, contentType: 'image/jpeg' }));
const strip = (src) => src.replace('/api/media/', '');
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
const getListing = async (id) => (await query('select data from listings where id = $1', [String(id)])).rows[0].data;
const tokenRow = (p) => query(`insert into media_uploads (pathname, reason) values ($1, 'token') on conflict (pathname) do update set reason = 'token'`, [p]);
const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---------------------------------------------------------------------------
await reset();

section('media#0: quarantine takes listings off sale; checkout and delivery honour it');
{
  const { creator, user: cu } = await mkCreatorUser();
  const onSale = await mkListing(creator.id);
  const sold = await mkListing(creator.id, { unlimited: false });
  await query(`update listings set data = data || '{"status":"sold"}' where id = $1`, [String(sold.id)]);
  const fan = await mkFan();
  await query('insert into orders (data) values ($1)', [{
    listingId: String(onSale.id), creatorId: String(creator.id), buyerId: String(fan.id), kind: 'digital',
    status: 'fulfilled', createdAt: new Date().toISOString(),
  }]);
  const report = await ncii.addNciiReport({ category: 'minor', contentLocation: `/creator/${creator.id}`, description: 'x', goodFaithStatement: true });
  const res = await call(preservedMediaRoute, { admin: true, body: { nciiReportId: String(report.id), creatorId: String(creator.id) } });
  check('quarantine succeeded', res.statusCode === 200 && res.body.preserved.length >= 2, JSON.stringify(res.body));
  const after = await getListing(onSale.id);
  check('the listing whose files were quarantined is off sale', after.status === 'removed' && after.moderationRemoved === true && !after.mediaDeletedAt, JSON.stringify(after));
  check('...and cannot be relisted by its owner', (await errOf(() => listings.updateListing(onSale.id, creator.id, { status: 'active' })))?.code === listings.LISTING_MODERATED);
  check('a sold listing keeps its status', (await getListing(sold.id)).status === 'sold');

  const { rows: ord } = await query('select id from orders limit 1');
  const del = await call(deliveryRoute, { method: 'GET', user: fan, query: { orderId: String(ord[0].id) } });
  check('delivery withholds preserved files', del.statusCode === 200 && del.body.items.length === 0 && del.body.withheld === 1 && del.body.removed === true, JSON.stringify(del.body));

  // Round 7 (R7B media#1, owner decision): a report HOLD is deletion
  // protection only and no longer blocks a sale -- one report must not freeze
  // a listing. A PRESERVATION still does (the backstop on the locked row).
  const other = await mkCreatorUser();
  const held = await mkListing(other.creator.id);
  await preservation.holdMediaForReport(held.media, 'report:77');
  check('listingMediaBlocked ignores a hold', !(await preservation.listingMediaBlocked(held)));
  // Preserve the file WITHOUT going through preserveMedia (which would take
  // the listing off sale), to exercise the locked-row backstop alone.
  await query(`insert into media_preservations (pathname, reason, retain_until) values ($1, 'test', now() + interval '1 day')`, [strip(held.media[0].src)]);
  check('listingMediaBlocked sees a preservation', await preservation.listingMediaBlocked(held));
  const buyer = await mkFan();
  await credits.creditAccount({ userId: buyer.id, cents: 5000, type: 'test' });
  const err = await errOf(() => orders.createOrdersFromCredits({
    buyerId: buyer.id,
    items: [{ listingId: String(held.id), creatorId: String(other.creator.id), creatorUserId: other.user.id, title: 'Set', priceCents: 500, kind: 'digital', shippingCents: 0 }],
    ageConfirmed: true,
    tosAccepted: true,
  }));
  check('checkout refuses a listing with a preserved file', err?.code === 'LISTING_UNAVAILABLE', err && err.message);
  check('...and charged nothing', (await credits.getBalanceCents(buyer.id)) === 5000);
  void cu;
}

section('media#1: deleteMediaQuietly waits on the file lock and sees a hold committed meanwhile');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const src = galleryFile(creator.id);
  const p = strip(src);
  process.env.BLOB_READ_WRITE_TOKEN = 'test-token';
  const deleted = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  // A hold being written right now, holding the lock (not yet committed).
  const holder = withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('media-file:' || $1))`, [p]);
    await client.query('insert into media_holds (pathname, report_id) values ($1, $2)', [p, 'report:5']);
    await gate;
  });
  await new Promise((r) => setTimeout(r, 50));
  const deleting = quiet(() => blobCleanup.deleteMediaQuietly([src], { deleteFile: async (x) => { deleted.push(x); } }));
  await new Promise((r) => setTimeout(r, 100));
  release();
  await holder;
  const out = await deleting;
  check('the file was NOT deleted', !deleted.length && out.held.includes(p), JSON.stringify(out));

  const free = galleryFile(creator.id);
  const out2 = await quiet(() => blobCleanup.deleteMediaQuietly([free], { deleteFile: async (x) => { deleted.push(x); } }));
  check('an unguarded file is deleted', out2.deleted.includes(strip(free)) && deleted.includes(strip(free)));
  check('...and tombstoned', (await query('select 1 from media_reaped where pathname = $1', [strip(free)])).rows.length === 1);
  delete process.env.BLOB_READ_WRITE_TOKEN;
}

section('media#2: sweep re-checks references under the lock; finalize of a reaped file is refused');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const src = galleryFile(creator.id);
  const p = strip(src);
  await tokenRow(p);
  await query(`update media_uploads set created_at = now() - interval '2 hours' where pathname = $1`, [p]);
  let release;
  const gate = new Promise((r) => { release = r; });
  // A finalize in flight: holds the lock and has written the reference.
  const finalizing = withTransaction(async (client) => {
    await mediaRefs.lockMediaForFinalize(client, src);
    await client.query(
      `update creators set data = jsonb_set(data, '{gallery}', coalesce(data->'gallery', '[]'::jsonb) || $2::jsonb) where id = $1`,
      [String(creator.id), JSON.stringify([{ type: 'image', src }])],
    );
    await gate;
  });
  await new Promise((r) => setTimeout(r, 50));
  const deleted = [];
  const sweeping = media.sweepOrphanedMedia({ deleteFile: async (x) => { deleted.push(x); } });
  await new Promise((r) => setTimeout(r, 100));
  release();
  await finalizing;
  const summary = await sweeping;
  check('the sweep did not delete a file finalized while it waited', !deleted.length && summary.kept === 1, JSON.stringify(summary));

  const orphan = galleryFile(creator.id);
  await tokenRow(strip(orphan));
  await query(`update media_uploads set created_at = now() - interval '2 hours' where pathname = $1`, [strip(orphan)]);
  await media.sweepOrphanedMedia({ deleteFile: async (x) => { deleted.push(x); } });
  check('an orphan is reaped', deleted.includes(strip(orphan)));
  const late = await errOf(() => creators.addGalleryItem(creator.id, { type: 'image', src: orphan }, undefined, 50));
  check('a late finalize of the reaped file is refused', late?.code === mediaRefs.MEDIA_UPLOAD_EXPIRED, late && late.message);
  const g = (await creators.getCreatorById(creator.id)).gallery;
  check('...and nothing points at it', !g.some((x) => x.src === orphan));
  const ok = galleryFile(creator.id);
  await tokenRow(strip(ok));
  const c2 = await creators.addGalleryItem(creator.id, { type: 'image', src: ok }, undefined, 50);
  check('a normal finalize still works', c2.gallery.some((x) => x.src === ok));
}

section('media#3: marketplace/update refuses a non-object fields');
{
  await reset();
  const { creator, user } = await mkCreatorUser();
  const l = await mkListing(creator.id);
  const res = await call(updateListingRoute, { user, body: { listingId: String(l.id), fields: 'x' } });
  check('400, not a crash', res.statusCode === 400 && res.body.error === 'Invalid fields', JSON.stringify([res.statusCode, res.body]));
}

section('money#1: a deposit for a deleted account is refused and the hash stays usable');
{
  await reset();
  const fan = await mkFan();
  await users.deleteFanAccount(fan.id, { force: true });
  const tx = '0x' + 'b'.repeat(64);
  const err = await errOf(() => deposit.recordDepositCredit({ userId: fan.id, txHash: tx, grossCents: 5000, feeCents: 100, netCents: 4900 }));
  check('ACCOUNT_GONE', err?.code === deposit.ACCOUNT_GONE, err && err.message);
  check('...the hash is not claimed', !(await query('select 1 from used_payment_tx where tx_hash = $1', [tx])).rows.length);
  check('...and nothing was credited', !(await query('select 1 from credit_balances where user_id = $1', [String(fan.id)])).rows.length);
  const live = await mkFan();
  const ok = await deposit.recordDepositCredit({ userId: live.id, txHash: tx, grossCents: 5000, feeCents: 100, netCents: 4900 });
  check('the same hash credits a live account', ok.creditedCents === 4900);
}

section('accounts#0: prohibited phrases split across tags');
{
  for (const tags of [['barely', 'legal', 'petite'], ['child', 'porn'], ['school', 'girl']]) {
    const hit = listings.findCircumventionInTags(tags);
    check(`joined tags flagged: ${tags.join(',')}`, hit?.kind === 'prohibited', JSON.stringify(hit));
  }
  check('ordinary tags pass', listings.findCircumventionInTags(['fitness', 'gym', 'outdoors']) === null);
  await reset();
  const { user } = await mkCreatorUser();
  const res = await call(meProfileRoute, { user, body: { fields: { tags: 'barely, legal' } } });
  check('profile save refused with the prohibited message', res.statusCode === 400 && /isn't allowed anywhere/.test(res.body.error), JSON.stringify(res.body));
}

section('accounts#1: a successful login does not reset the per-IP brake');
{
  await reset();
  const me = await mkFan('owner@r6b.test');
  void me;
  const ip = '10.99.0.1';
  const statuses = [];
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 4; i++) {
      statuses.push((await call(loginRoute, { ip, body: { email: `victim${round}${i}@r6b.test`, password: 'guess' } })).statusCode);
    }
    statuses.push((await call(loginRoute, { ip, body: { email: 'owner@r6b.test', password: 'password123' } })).statusCode);
  }
  for (let i = 0; i < 4; i++) statuses.push((await call(loginRoute, { ip, body: { email: `victim9${i}@r6b.test`, password: 'guess' } })).statusCode);
  check('successful logins went through', statuses.filter((s) => s === 200).length === 2, statuses.join(','));
  check('the 11th failure from the host is limited', statuses[statuses.length - 1] === 429 && statuses.filter((s) => s === 401).length === 10, statuses.join(','));
}

section('accounts#2/#3: founding stamp kept on re-approval; approval refused for a moderated login');
{
  await reset();
  const { creator } = await mkCreatorUser({ status: 'pending', founding: true });
  await query(`insert into performer_records (data) values ($1)`, [{ creatorId: String(creator.id), status: 'active', documentLocation: 'offline' }]);
  const a1 = await call(adminProfileRoute, { admin: true, body: { creatorId: creator.id, fields: { status: 'active' } } });
  check('first approval', a1.statusCode === 200 && !!a1.body.creator.foundingSince, JSON.stringify(a1.body));
  const past = new Date(Date.now() - 10 * 864e5).toISOString();
  await query(`update creators set data = data || jsonb_build_object('foundingSince', $2::text) where id = $1`, [String(creator.id), past]);
  await call(adminProfileRoute, { admin: true, body: { creatorId: creator.id, fields: { status: 'pending' } } });
  const a2 = await call(adminProfileRoute, { admin: true, body: { creatorId: creator.id, fields: { status: 'active' } } });
  check('re-approval keeps the original founding stamp', a2.statusCode === 200 && a2.body.creator.foundingSince === past, JSON.stringify(a2.body.creator?.foundingSince));

  const second = await mkCreatorUser({ status: 'pending' });
  await query(`insert into performer_records (data) values ($1)`, [{ creatorId: String(second.creator.id), status: 'active', documentLocation: 'offline' }]);
  await users.setUserModeration(second.user.id, { status: 'banned', until: null, reason: 'x', by: 'admin' });
  const refused = await call(adminProfileRoute, { admin: true, body: { creatorId: second.creator.id, fields: { status: 'active' } } });
  check('approval refused while the login is banned', refused.statusCode === 409 && /login account is banned/.test(refused.body.error), JSON.stringify(refused.body));
  check('...and the creator is still pending', (await creators.getCreatorById(second.creator.id)).status === 'pending');
}

section('accounts#4: competing storefront links');
{
  for (const link of ['https://mym.fans/jane', 'https://fanfix.io/jane', 'https://passes.com/jane', 'https://linkin.bio/jane', 'https://fanhouse.app/x', 'https://4based.com/x']) {
    check(`flagged: ${link}`, screenPublicText(link) !== null);
  }
  check('the ordinary word "passes" is not', screenPublicText('free passes for everyone at the show') === null);
}

section('social#0: gallery/avatar reports hold the file; resolving preserves then removes');
{
  await reset();
  const { creator, user: cu } = await mkCreatorUser();
  const g = galleryFile(creator.id);
  const av = avatarFile(creator.id);
  await query(`update creators set data = data || jsonb_build_object('gallery', $2::jsonb, 'img', $3::text) where id = $1`,
    [String(creator.id), JSON.stringify([{ type: 'image', src: g }]), av]);
  const fan = await mkFan();
  const bad = await call(reportMediaRoute, { user: fan, body: { creatorId: String(creator.id), targetType: 'gallery_item', src: galleryFile(creator.id), reason: 'x', category: 'minor' } });
  check('an item not on the profile is refused', bad.statusCode === 404);
  const rep = await call(reportMediaRoute, { user: fan, body: { creatorId: String(creator.id), targetType: 'gallery_item', src: g, reason: 'looks under 18', category: 'minor' } });
  check('a gallery report is filed', rep.statusCode === 200 && !rep.body.report.reportedContent, JSON.stringify(rep.body));
  check('...and its file is on hold', (await preservation.heldPathsForReport(`report:${rep.body.report.id}`)).includes(strip(g)));
  // The creator deletes the item: the reference goes, the held file stays.
  await quiet(() => creators.removeGalleryItem(creator.id, { src: g }));
  check('the creator can remove the item but the held file is not deleted', !(await query('select 1 from media_reaped where pathname = $1', [strip(g)])).rows.length);
  const resolved = await call(reportsResolveRoute, { admin: true, body: { id: String(rep.body.report.id), action: 'remove_content' } });
  check('resolving preserves the held file', resolved.statusCode === 200 && resolved.body.preserved >= 1, JSON.stringify(resolved.body));
  check('...which is now evidence', (await preservation.preservedSubset([strip(g)])).has(strip(g)));

  const rep2 = await call(reportMediaRoute, { user: fan, body: { creatorId: String(creator.id), targetType: 'avatar', src: av, reason: 'x', category: 'minor' } });
  check('an avatar report is filed', rep2.statusCode === 200);
  const r2 = await call(reportsResolveRoute, { admin: true, body: { id: String(rep2.body.report.id), action: 'remove_content' } });
  check('resolving resets the avatar', r2.statusCode === 200 && r2.body.content === 'removed', JSON.stringify(r2.body));
  check('...to the placeholder', (await creators.getCreatorById(creator.id)).img === '/images/avatar-placeholder.png');
  check('...and the photo is preserved', (await preservation.preservedSubset([strip(av)])).has(strip(av)));
  void cu;
}

section('social#1/#2: a retried paid DM survives a suspension; a DM block stops wall comments');
{
  await reset();
  const { creator, user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'test' });
  const first = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hi', clientMessageId: 'k1', expectedPriceCents: 99 });
  await query(`update creators set data = data || jsonb_build_object('status', 'suspended', 'suspendedUntil', $2::text) where id = $1`,
    [String(creator.id), new Date(Date.now() + 864e5).toISOString()]);
  const retry = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hi', clientMessageId: 'k1', expectedPriceCents: 99 });
  check('the retry returns the delivered message', retry.duplicate === true && retry.message.id === first.message.id);
  check('...charged once', (await credits.getBalanceCents(fan.id)) === 5000 - 99);
  await query(`update creators set data = data || '{"status":"active"}' where id = $1`, [String(creator.id)]);
  await messages.setConversationBlocked(cu.id, fan.id, true);
  const post = await call(wallPostRoute, { user: fan, body: { creatorId: String(creator.id), text: 'hello there' } });
  check('a blocked fan cannot comment on the wall', post.statusCode === 403, JSON.stringify(post.body));
  check('...and nobody was notified', !(await query(`select 1 from notifications where data->>'type' = 'wall_comment'`).catch(() => ({ rows: [] }))).rows.length);
}

section('social#3: an oversized §2257 upload gets a real 413');
{
  await reset();
  const declared = await call(docRoute, { admin: true, query: { id: '1' }, req: { headers: { 'content-length': String(5 * 1024 * 1024) }, resume() {} } });
  check('a declared oversize body is refused up front', declared.statusCode === 413, JSON.stringify(declared.body));
  let destroyed = false;
  const stream = Readable.from([Buffer.alloc(3 * 1024 * 1024), Buffer.alloc(3 * 1024 * 1024)]);
  stream.on('close', () => { destroyed = stream.readableEnded === false; });
  const streamed = await call(docRoute, { admin: true, query: { id: '1' }, req: Object.assign(stream, { headers: {} }) });
  check('a streamed oversize body gets the 413 message', streamed.statusCode === 413 && /too large/.test(streamed.body.error), JSON.stringify(streamed.body));
  check('...and the request was drained, not destroyed', !destroyed && stream.readableEnded === true);
}

section('legal-journeys#1: a public marketplace URL finds the listing records');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const other = await mkCreatorUser();
  const l = await mkListing(creator.id);
  const co = await records.createPerformerRecord({ legalName: 'Co Performer', dateOfBirth: '1990-01-01', aliases: ['coperf'], idType: 'passport', idNumber: 'P1', documentLocation: 'offline' });
  const main = await records.createPerformerRecord({ legalName: 'Main Person', dateOfBirth: '1990-01-01', aliases: ['mainp'], idType: 'passport', idNumber: 'P2', documentLocation: 'offline', creatorId: String(creator.id) });
  await query(`update listings set data = jsonb_set(data, '{media,0,performers}', $2::jsonb) where id = $1`, [String(l.id), JSON.stringify({ othersAppear: true, coPerformerRecordIds: [String(co.id)] })]);
  const ids = async (term) => (await records.searchPerformerRecords(term)).map((r) => String(r.id)).sort();
  const want = [String(co.id), String(main.id)].sort().join(',');
  check('/marketplace?creator=&listing= finds creator + co-performer', (await ids(`https://www.joinonlyone.com/marketplace?creator=${creator.id}&listing=${l.id}`)).join(',') === want);
  check('shop root ?listing= finds them too', (await ids(`https://www.shoponeonly.com/?listing=${l.id}`)).join(',') === want);
  check('a wrong ?creator= hint is ignored', (await ids(`/marketplace?creator=${other.creator.id}&listing=${l.id}`)).join(',') === want);
  check('a listing that does not exist finds nothing', (await ids('/marketplace?listing=99999')).length === 0);
}

section('admin-ui#1/#2: lookup by login; manual credit must name the account');
{
  await reset();
  const fan = await mkFan('Jane@Example.com');
  const found = await call(userModerationRoute, { method: 'GET', admin: true, query: { login: '  jane@example.com ' } });
  check('found by email, case-insensitive', found.statusCode === 200 && found.body.user.userId === String(fan.id) && found.body.user.login === 'Jane@Example.com', JSON.stringify(found.body));
  const missing = await call(userModerationRoute, { method: 'GET', admin: true, query: { login: 'nobody' } });
  check('an unknown login is 404', missing.statusCode === 404);
  process.env.NEXT_PUBLIC_MARKETPLACE_PAYOUT_ADDRESS = '0x1111111111111111111111111111111111111111';
  process.env.NEXT_PUBLIC_MARKETPLACE_USDC_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_ID = '4663';
  process.env.MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
  process.env.NEXT_PUBLIC_MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
  const body = { userId: fan.id, txHash: '0x' + 'c'.repeat(64), fromAddress: '0x2222222222222222222222222222222222222222' };
  const noConfirm = await call(manualCreditRoute, { admin: true, body });
  check('no expectedLogin -> 400 with the resolved account', noConfirm.statusCode === 400 && noConfirm.body.code === 'CONFIRM_ACCOUNT' && noConfirm.body.account.login === 'Jane@Example.com', JSON.stringify(noConfirm.body));
  const wrong = await call(manualCreditRoute, { admin: true, body: { ...body, expectedLogin: 'someone@else.com' } });
  check('a mismatched login -> 409', wrong.statusCode === 409 && wrong.body.code === 'ACCOUNT_MISMATCH');
  check('...nothing claimed', !(await query('select 1 from used_payment_tx')).rows.length);
}

section('dashboard#2/#5: inbox names; shipped orders hide the address');
{
  await reset();
  const { creator, user: cu } = await mkCreatorUser();
  const a = await mkFan('alice@x.com');
  const b = await mkFan('bob@y.com');
  for (const f of [a, b]) {
    await credits.creditAccount({ userId: f.id, cents: 1000, type: 'test' });
    await messages.sendDirectMessage({ sender: f, recipientId: cu.id, text: 'hello', expectedPriceCents: 99 });
  }
  const list = await call(conversationsRoute, { method: 'GET', user: cu, query: {} });
  const names = list.body.conversations.map((c) => c.other.name);
  check('fans get distinct stable labels, never an email', names.length === 2 && new Set(names).size === 2 && names.every((x) => /^Fan #[0-9A-F]{6}$/.test(x)), JSON.stringify(names));
  check('the label is stable', users.fanLabelFor(a.id) === users.fanLabelFor(a.id) && names.includes(users.fanLabelFor(a.id)));

  const o = await orders.createOrder({
    listingId: 1, creatorId: String(creator.id), buyerId: a.id, priceCents: 100, kind: 'physical', ageConfirmed: true, tosAccepted: true,
    shippingAddress: { fullName: 'A', line1: '1 St', city: 'C', region: 'R', postalCode: '1', country: 'US' },
  });
  const pending = await orders.getOrdersForCreator(String(creator.id));
  check('a pending order carries the address, never the buyer id', pending[0].shippingAddress?.line1 === '1 St' && pending[0].buyerId === undefined);
  const shipped = await orders.markOrderShipped(o.id, String(creator.id), { carrier: 'UPS', trackingNumber: 'T' });
  check('the ship response has neither', shipped.shippingAddress === undefined && shipped.buyerId === undefined);
  const after = await orders.getOrdersForCreator(String(creator.id));
  check('a shipped order no longer returns the address', after[0].status === 'shipped' && after[0].shippingAddress === null);
}

section('bridge follow-ups');
{
  await reset();
  const until = Date.now() + 5 * 864e5;
  const decode = (t) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
  const fanTok = decode(bridge.mintBridgeToken({ id: 'u1', role: 'fan', email: 'a' }, null, { fanStanding: 'suspended', suspendedUntil: until }));
  check('a suspended fan exchange carries suspendedUntil', fanTok.standing === 'suspended' && fanTok.suspendedUntil === until);
  const crTok = decode(bridge.mintBridgeToken({ id: 'u2', role: 'creator', email: 'a' }, 'suspended', { suspendedUntil: until }));
  check('a suspended creator exchange carries it too', crTok.suspendedUntil === until);
  const activeTok = decode(bridge.mintBridgeToken({ id: 'u3', role: 'fan', email: 'a' }, null, { fanStanding: 'active', suspendedUntil: until }));
  check('an active account does not', activeTok.suspendedUntil === undefined);

  const fan = await mkFan();
  await users.setUserModeration(fan.id, { status: 'suspended', until, reason: 'x', by: 'admin' });
  const { rows } = await query('select * from server_standing_pushes where uid = $1', [String(fan.id)]);
  check('a fan suspension push carries its end', rows[0]?.role === 'FAN' && Number(rows[0]?.suspended_until) === until, JSON.stringify(rows[0]));

  const committedAt = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  const sent = [];
  await outbox.deliverStandingPushes({ uids: [String(fan.id)], fetchImpl: async (_u, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200 }; } });
  check('the delivered stamp is at or after the commit', sent.length === 1 && sent[0].standingAt >= committedAt, JSON.stringify(sent));
  check('...and the delivered row is gone', !(await query('select 1 from server_standing_pushes where uid = $1', [String(fan.id)])).rows.length);
}

await closePool();
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
