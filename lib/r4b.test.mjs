// Regression tests for the round-4 backend fixes (package R4B), run against a
// real scratch Postgres (it truncates tables), never mocks:
//  - possible-minor takedowns QUARANTINE files (never deleted, never served,
//    never swept) and the report records them;
//  - the sweep retries deletions at once (only upload tokens wait an hour);
//  - HEAD on /api/media answers from metadata, never a GET-signed redirect;
//  - removing a creator's listings: lock first, decide second (an order that
//    commits while the removal waits keeps its files); sold PHYSICAL
//    listings' photos are deleted;
//  - DM blocking (refused before any charge), DM reports, report categories
//    and the reason-length refusal;
//  - manual credit refuses a frozen account unless overridden;
//  - own-view projection hides moderation notes; unapproved creator accounts
//    can be moderated; account + creator standings combine;
//  - fan account deletion and password change;
//  - the durable server/ standing outbox (queue in the same commit, retry on
//    failure, newer replaces older, standingAt/role/suspendedUntil signed);
//  - the co-performer check refuses the creator's own §2257 record;
//  - the checkout duplicate answer carries its code;
//  - referral codes cannot crash the client (emoji straddling the cap).
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r4b.test.mjs

import crypto from 'crypto';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
delete process.env.NCII_ALERT_WEBHOOK_URL;
process.env.BRIDGE_SECRET = 'test-bridge-secret-r4b';
// Nothing listens here: every real delivery attempt fails fast and is retried.
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r4b';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { query, withTransaction, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const credits = await import('./credits-store.js');
const media = await import('./media.js');
const preservation = await import('./media-preservation.js');
const blobCleanup = await import('./blob-cleanup.js');
const ncii = await import('./ncii-reports-store.js');
const messages = await import('./messages-store.js');
const reportsStore = await import('./reports-store.js');
const outbox = await import('./standing-outbox.js');
const serverApi = await import('./server-api.js');
const bridgeToken = await import('./bridge-token.js');
const attestation = await import('./performer-attestation.js');
const referral = await import('./referral.js');
const tos = await import('./tos.js');
const ordersStore = await import('./orders-store.js');
const records = await import('./performer-records-store.js');
const { createSessionToken } = await import('./session.js');
const { default: manualCreditRoute } = await import('../pages/api/admin/manual-credit.js');
const { default: messageReportRoute } = await import('../pages/api/messages/report.js');
const { default: blockRoute } = await import('../pages/api/messages/block.js');
const { default: wallReportRoute } = await import('../pages/api/wall/report.js');
const { default: reportsRoute } = await import('../pages/api/admin/reports.js');
const { default: reportsResolveRoute } = await import('../pages/api/admin/reports-resolve.js');
const { default: userModerationRoute } = await import('../pages/api/admin/user-moderation.js');
const { default: deleteAccountRoute } = await import('../pages/api/auth/delete-account.js');
const { default: changePasswordRoute } = await import('../pages/api/auth/change-password.js');
const { default: meRoute } = await import('../pages/api/auth/me.js');
const { default: cronRoute } = await import('../pages/api/cron/maintenance.js');
const { default: adminGalleryDeleteRoute } = await import('../pages/api/admin/gallery-delete.js');

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
    statusCode: 200, headers: {}, body: null, headersSent: false, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end(b) { this.headersSent = true; this.ended = true; if (b) { try { this.body = JSON.parse(b); } catch { this.body = b; } } },
  };
}
let ipN = 0;
async function call(route, { method = 'POST', body, query: q = {}, admin = false, user = null, headers: extra = {} } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = { 'x-forwarded-for': `10.44.0.${ipN}`, ...extra };
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  if (user) headers.cookie = `oa_session=${createSessionToken(user.id, user.sessionVersion || 0)}`;
  await quiet(() => route({ method, body, query: q, headers, socket: { remoteAddress: `10.44.0.${ipN}` } }, res));
  return res;
}

async function reset() {
  await query(`truncate creators, users, listings, orders, credit_balances, credit_ledger, payout_requests, checkout_idempotency,
    used_payment_tx, ncii_reports, media_uploads, performer_records, media_preservations, server_standing_pushes,
    conversations, reports, violations, wall_posts, favorites, notifications restart identity`);
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
let n = 0;
async function mkCreatorUser(fields = {}) {
  n++;
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r4bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r4b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r4b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
const galleryFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'gallery', creatorId, contentType: 'image/jpeg' }));
const strip = (src) => src.replace('/api/media/', '');
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
async function paidOrder(listing, buyerId, kind = 'digital') {
  await query('insert into orders (data) values ($1)', [{
    listingId: String(listing.id), creatorId: String(listing.creatorId), buyerId: String(buyerId), kind,
    status: kind === 'digital' ? 'fulfilled' : 'pending_shipment', createdAt: new Date().toISOString(),
  }]);
}
const getListing = async (id) => (await query('select data from listings where id = $1', [String(id)])).rows[0].data;

// ---------------------------------------------------------------------------
await reset();

section('legal-journeys#0: a possible-minor takedown quarantines the files instead of deleting them');
{
  const { creator } = await mkCreatorUser();
  const g = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g }, []);
  const l = await mkListing(creator.id);
  const report = await ncii.addNciiReport({ category: 'minor', contentLocation: 'listing', description: 'x', goodFaithStatement: true });
  const out = await quiet(() => ncii.resolveNciiReport(report.id, 'removed', { creatorId: creator.id }));
  check('the creator is banned outright', out.outrightBan === true && out.creator.status === 'banned');
  const rows = (await query('select pathname, report_id, retain_until from media_preservations order by pathname')).rows;
  const preserved = new Set(rows.map((r) => r.pathname));
  check('gallery and listing files are preserved', preserved.has(strip(g)) && preserved.has(strip(l.media[0].src)), JSON.stringify(rows));
  check('linked to the report, retained a year',
    rows.every((r) => r.report_id === `ncii:${report.id}` && new Date(r.retain_until) > new Date(Date.now() + 360 * 864e5)));
  const stored = (await query('select data from ncii_reports where id = $1', [report.id])).rows[0].data;
  check('the report records what was preserved', stored.preservedCount === 2 && stored.preservedMedia.includes(strip(g)), JSON.stringify(stored));
  check('the result says how many', out.preservedCount === 2);
  const pending = (await query('select pathname from media_uploads')).rows.map((r) => r.pathname);
  check('nothing preserved is on the deletion queue', !pending.some((p) => preserved.has(p)), JSON.stringify(pending));
  const listing = await getListing(l.id);
  check('the listing still comes off sale', listing.status === 'removed' && listing.moderationRemoved === true);

  const del = await quiet(() => blobCleanup.deleteMediaQuietly([g]));
  check('deleteMediaQuietly refuses a preserved file', del.preserved.includes(strip(g)) && !del.deleted.length && !del.failed.length, JSON.stringify(del));
  await query(`insert into media_uploads (pathname, reason) values ($1, 'delete_failed')`, [strip(g)]);
  const swept = [];
  const sw = await media.sweepOrphanedMedia({ deleteFile: async (p) => { swept.push(p); } });
  check('the sweep never claims a preserved file', !swept.includes(strip(g)) && sw.checked === 0, JSON.stringify(sw));
  await query('delete from media_uploads');
  await withTransaction((c) => blobCleanup.recordPendingDeletions([g], c));
  check('recordPendingDeletions skips preserved files', (await query('select 1 from media_uploads')).rows.length === 0);

  const res = fakeRes();
  await media.sendMedia({ method: 'GET', headers: {} }, res, strip(g));
  check('sendMedia serves a preserved file to nobody (404)', res.statusCode === 404);
  check('isMediaPreserved: evidence/ prefix is always preserved', await preservation.isMediaPreserved('evidence/ncii-1/x.jpg'));

  const moved = [];
  const mv = await preservation.movePreservedToEvidence({ renameFile: async (from, to) => { moved.push([from, to]); } });
  check('files are moved into the evidence/ prefix', mv.moved === 2 && moved.every(([, to]) => to.startsWith(`evidence/ncii-${report.id}/`)), JSON.stringify(moved));
  const after = (await query('select evidence_pathname from media_preservations')).rows;
  check('...and the new path is recorded', after.every((r) => r.evidence_pathname && r.evidence_pathname.startsWith('evidence/')));
  check('the evidence path is not one /api/media parses', media.parseMediaPathname(after[0].evidence_pathname) === null);

  // A non-minor NCII ban still deletes (queues deletions), preserving nothing.
  await reset();
  const { creator: c2 } = await mkCreatorUser({ contentViolationCount: 1 });
  const l2 = await mkListing(c2.id);
  const r2 = await ncii.addNciiReport({ category: 'self', contentLocation: 'x', description: 'x', consentStatement: true });
  await quiet(() => ncii.resolveNciiReport(r2.id, 'removed', { creatorId: c2.id }));
  check('a self-filed NCII ban preserves nothing', (await query('select 1 from media_preservations')).rows.length === 0);
  check('...and queues the files for deletion', (await query('select pathname from media_uploads')).rows.some((r) => r.pathname === strip(l2.media[0].src)));

  // preserveMediaForReport for one item, then the gallery removal keeps the file.
  const { creator: c3 } = await mkCreatorUser();
  const g3 = galleryFile(c3.id);
  await creators.addGalleryItem(c3.id, { type: 'image', src: g3 }, []);
  const r3 = await ncii.addNciiReport({ category: 'minor', contentLocation: 'x', description: 'x', goodFaithStatement: true });
  const p3 = await quiet(() => ncii.preserveMediaForReport(r3.id, [g3]));
  check('an admin can preserve one item for a report', p3.preserved.length === 1);
  await quiet(() => creators.removeGalleryItem(c3.id, { src: g3 }));
  check('...and removing it afterwards queues no deletion', !(await query('select pathname from media_uploads')).rows.some((r) => r.pathname === strip(g3)));
  let threw = null;
  try { await ncii.preserveMediaForReport(999999, [g3]); } catch (err) { threw = err.code; }
  check('preserving for an unknown report is refused', threw === ncii.NCII_REPORT_NOT_FOUND);
}

section('media#1: deletion rows are retried at once; only upload tokens wait an hour');
{
  await reset();
  const failed = media.newMediaPathname({ purpose: 'gallery', creatorId: '1', contentType: 'image/jpeg' });
  const token = media.newMediaPathname({ purpose: 'gallery', creatorId: '1', contentType: 'image/jpeg' });
  await media.recordPendingMediaPath(failed, 'delete_failed');
  await media.recordPendingMediaPath(token, 'token');
  const counts = await media.pendingDeletionCounts();
  check('outstanding deletions are counted for the admin', counts.deleteFailed === 1 && counts.deletePending === 0, JSON.stringify(counts));
  const deleted = [];
  const sw = await media.sweepOrphanedMedia({ deleteFile: async (p) => { deleted.push(p); } });
  check('a fresh failed deletion is retried straight away', deleted.includes(failed), JSON.stringify(sw));
  check('a fresh upload token is left for later', !deleted.includes(token));
  process.env.CRON_SECRET = 'cron-secret-r4b';
  const bad = await call(cronRoute, { method: 'GET', headers: { authorization: 'Bearer nope' } });
  check('the cron route refuses a wrong secret', bad.statusCode === 401);
  const good = await call(cronRoute, { method: 'GET', headers: { authorization: 'Bearer cron-secret-r4b' } });
  check('the cron route runs with the right secret', good.statusCode === 200 && good.body.ok === true, JSON.stringify(good.body));
  delete process.env.CRON_SECRET;
  const off = await call(cronRoute, { method: 'GET', headers: { authorization: 'Bearer cron-secret-r4b' } });
  check('the cron route refuses to run open without CRON_SECRET', off.statusCode === 503);
}

section('media#4: HEAD answers from metadata and never redirects');
{
  const res = fakeRes();
  let threw = false;
  try {
    await media.sendMedia({ method: 'HEAD', headers: {} }, res, 'gallery/1/00000000-0000-4000-8000-000000000000.jpg');
  } catch {
    threw = true; // no store configured in tests: head() itself fails
  }
  check('HEAD is never answered with a 302', res.statusCode !== 302 && !res.headers.location, JSON.stringify({ code: res.statusCode, threw }));
}

section('media#2/#3: removing a creator\'s listings -- lock first, decide second; sold physical photos go');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const fan = await mkFan();
  const l = await mkListing(creator.id);
  let locked;
  const lockedP = new Promise((r) => { locked = r; });
  let release;
  const gate = new Promise((r) => { release = r; });
  const checkout = withTransaction(async (c) => {
    await c.query('select id from listings where id = $1 for update', [String(l.id)]);
    await c.query('insert into orders (data) values ($1)', [{ listingId: String(l.id), creatorId: String(creator.id), buyerId: String(fan.id), kind: 'digital', status: 'fulfilled', createdAt: new Date().toISOString() }]);
    locked();
    await gate;
  });
  await lockedP;
  const removal = quiet(() => listings.removeListingsForCreator(String(creator.id), { keepPaid: true }));
  await new Promise((r) => setTimeout(r, 150));
  release();
  await checkout;
  const out = await removal;
  const after = await getListing(l.id);
  check('an order committed while the removal waited keeps its files', !after.mediaDeletedAt && out.kept.includes(String(l.id)), JSON.stringify(after));

  const phys = await mkListing(creator.id, { kind: 'physical', unlimited: false, shippingCents: 500 });
  await query(`update listings set data = data || '{"status":"sold"}' where id = $1`, [String(phys.id)]);
  await paidOrder(phys, fan.id, 'physical');
  const out2 = await quiet(() => listings.removeListingsForCreator(String(creator.id), { keepPaid: true }));
  const physAfter = await getListing(phys.id);
  check('a sold physical listing keeps its sold status', physAfter.status === 'sold');
  check('...but its photos are deleted', !!physAfter.mediaDeletedAt && out2.files.some((f) => f.src === phys.media[0].src), JSON.stringify(physAfter));
}

section('social#0: blocking and reporting a DM');
{
  await reset();
  const { creator, user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'test' });
  const price = messages.dmPriceCentsFor(creator);
  const first = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hello', expectedPriceCents: price });
  check('a paid DM goes through', first.chargedCents === price);
  const blocked = await call(blockRoute, { user: cu, body: { userId: fan.id, blocked: true } });
  check('the creator can block the fan', blocked.statusCode === 200 && blocked.body.conversation.blockedByMe === true, JSON.stringify(blocked.body));
  const before = await credits.getBalanceCents(fan.id);
  let code = null;
  try { await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'again', expectedPriceCents: price }); } catch (err) { code = err.code; }
  check('a blocked fan is refused', code === messages.DM_ERRORS.BLOCKED);
  check('...and is not charged', (await credits.getBalanceCents(fan.id)) === before);
  const quote = await messages.quoteDmPrice(fan, cu);
  check('the price quote reports it as not allowed', quote.allowed === false && quote.code === messages.DM_ERRORS.BLOCKED);
  const noConvo = await call(blockRoute, { user: cu, body: { userId: 'nobody', blocked: true } });
  check('blocking someone with no conversation is 404', noConvo.statusCode === 404);
  await call(blockRoute, { user: cu, body: { userId: fan.id, blocked: false } });
  const again = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'thanks', expectedPriceCents: price });
  check('unblocking lets messages through again', again.chargedCents === price);

  const msgId = first.message.id;
  const selfReport = await call(messageReportRoute, { user: fan, body: { withUserId: cu.id, messageId: msgId, reason: 'x' } });
  check("you can't report your own message", selfReport.statusCode === 404);
  const rep = await call(messageReportRoute, { user: cu, body: { withUserId: fan.id, messageId: msgId, reason: 'says they are 16', category: 'minor' } });
  check('a participant can report a DM', rep.statusCode === 200 && rep.body.report.targetType === 'message' && rep.body.report.category === 'minor', JSON.stringify(rep.body));
  const stranger = await mkFan();
  const nope = await call(messageReportRoute, { user: stranger, body: { withUserId: fan.id, messageId: msgId, reason: 'x' } });
  check('a non-participant cannot', nope.statusCode === 404);
  const list = await call(reportsRoute, { method: 'GET', admin: true, query: {} });
  const r = list.body.reports.find((x) => x.targetType === 'message');
  check('the admin queue shows the message text and sender', r && r.target.exists && r.target.text === 'hello' && r.target.senderId === String(fan.id), JSON.stringify(r));
  const resolved = await call(reportsResolveRoute, { admin: true, body: { id: rep.body.report.id, action: 'remove_content' } });
  check('an admin can remove the reported message', resolved.statusCode === 200 && resolved.body.content === 'removed', JSON.stringify(resolved.body));
  const convo = await messages.getConversationBetween(fan.id, cu.id);
  check('...it is gone from the conversation', !convo.messages.some((m) => m.id === msgId));
  const snap = (await query('select data from reports where id = $1', [rep.body.report.id])).rows[0].data.removedContent;
  check('...and a minor report keeps a copy of the text', snap && snap.text === 'hello', JSON.stringify(snap));
}

section('social#1/#2: report categories, priority, and reasons refused rather than cut');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const fan = await mkFan();
  const { rows } = await query('insert into wall_posts (data) values ($1) returning id', [{ creatorId: String(creator.id), authorId: String(fan.id), text: 'hi', createdAt: new Date().toISOString() }]);
  const postId = rows[0].id;
  const long = await call(wallReportRoute, { user: fan, body: { postId, reason: 'x'.repeat(501) } });
  check('a reason over 500 characters is refused with the limit', long.statusCode === 400 && long.body.field === 'reason' && long.body.maxLength === 500, JSON.stringify(long.body));
  const badCat = await call(wallReportRoute, { user: fan, body: { postId, reason: 'x', category: 'spam!!' } });
  check('an unknown category is refused', badCat.statusCode === 400 && badCat.body.field === 'category');
  const other = await call(wallReportRoute, { user: fan, body: { postId, reason: 'spam' } });
  const minor = await call(wallReportRoute, { user: fan, body: { postId, reason: 'looks underage', category: 'minor' } });
  const nc = await call(wallReportRoute, { user: fan, body: { postId, reason: 'not consented', category: 'non_consensual' } });
  check('categories are stored', other.body.report.category === 'other' && minor.body.report.category === 'minor' && nc.body.report.category === 'non_consensual');
  const list = await call(reportsRoute, { method: 'GET', admin: true, query: {} });
  check('minor first, then non-consensual, then the rest',
    list.body.reports.map((r) => r.category).join(',') === 'minor,non_consensual,other', JSON.stringify(list.body.reports.map((r) => r.category)));
  const { reportAlertText } = await import('./alerts.js');
  const text = reportAlertText({ id: 7, category: 'minor', targetType: 'listing', createdAt: new Date().toISOString(), reason: 'SECRET DETAIL' });
  check('the alert names the category and id, never the reason', text.startsWith('POSSIBLE MINOR') && text.includes('#7') && !text.includes('SECRET'));
}

section('money#1: manual credit refuses a frozen account unless overridden');
{
  await reset();
  process.env.NEXT_PUBLIC_MARKETPLACE_PAYOUT_ADDRESS = '0x1111111111111111111111111111111111111111';
  process.env.NEXT_PUBLIC_MARKETPLACE_USDC_ADDRESS = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  process.env.NEXT_PUBLIC_MARKETPLACE_CHAIN_ID = '4663';
  process.env.MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
  process.env.NEXT_PUBLIC_MARKETPLACE_RPC_URL = 'http://127.0.0.1:9';
  const { creator, user } = await mkCreatorUser();
  await query(`update creators set data = data || '{"status":"banned"}' where id = $1`, [String(creator.id)]);
  const res = await call(manualCreditRoute, { admin: true, body: { userId: user.id, txHash: '0x' + 'a'.repeat(64), fromAddress: '0x2222222222222222222222222222222222222222' } });
  check('a banned account is refused with its standing', res.statusCode === 409 && res.body.code === 'ACCOUNT_FROZEN' && res.body.status === 'banned', JSON.stringify([res.statusCode, res.body]));
  check('...and the hash is not claimed', (await query('select 1 from used_payment_tx')).rows.length === 0);
}

section('accounts#5/#6: own view hides moderation notes; unapproved creator accounts can be moderated');
{
  await reset();
  const fan = await mkFan();
  await users.setUserModeration(fan.id, { status: 'suspended', until: Date.now() + 864e5, reason: 'reported by @mia' });
  const me = await call(meRoute, { method: 'GET', user: { ...fan, sessionVersion: 0 } });
  check('/api/auth/me carries the standing but not the note',
    me.body.user && me.body.user.moderationStatus === 'suspended' && !('moderationReason' in me.body.user) && !('moderatedBy' in me.body.user), JSON.stringify(me.body));
  const { creator: pending, user: pu } = await mkCreatorUser({ status: 'pending' });
  const modPending = await call(userModerationRoute, { admin: true, body: { userId: pu.id, action: 'suspend', days: 7 } });
  check('a pending creator account can be suspended at account level', modPending.statusCode === 200 && modPending.body.user.status === 'suspended', JSON.stringify(modPending.body));
  const standing = await credits.accountStanding(pu.id);
  check('...and its credits freeze (standings combine)', standing.effectiveStatus === 'suspended' && credits.isFrozenStanding(standing));
  const { user: au } = await mkCreatorUser();
  const modActive = await call(userModerationRoute, { admin: true, body: { userId: au.id, action: 'suspend' } });
  check('an approved creator is still refused here', modActive.statusCode === 400);
  void pending;
}

section('accounts#7: fan self-deletion and password change');
{
  await reset();
  const { user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 1000, type: 'test' });
  await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hi there', expectedPriceCents: 99 });
  await query('insert into favorites (fan_id, creator_id) values ($1, $2)', [String(fan.id), '1']);
  const wrong = await call(deleteAccountRoute, { user: fan, body: { password: 'nope' } });
  check('a wrong password deletes nothing', wrong.statusCode === 401);
  const needAck = await call(deleteAccountRoute, { user: fan, body: { password: 'password123' } });
  check('a remaining balance needs an explicit acknowledgement', needAck.statusCode === 409 && needAck.body.code === 'BALANCE_FORFEIT' && needAck.body.balanceCents === 901, JSON.stringify(needAck.body));
  const done = await call(deleteAccountRoute, { user: fan, body: { password: 'password123', acknowledgeForfeit: true, expectedForfeitCents: 901, expectedDigitalPurchases: 0 } });
  check('the account is deleted', done.statusCode === 200 && done.body.forfeitedCents === 901 && !(await users.findUserById(fan.id)), JSON.stringify(done.body));
  check('...the session cookie is cleared', String(done.headers['set-cookie'] || '').includes('Max-Age=0'));
  check('...favorites are gone', (await query('select 1 from favorites where fan_id = $1', [String(fan.id)])).rows.length === 0);
  const convo = await messages.getConversationBetween(fan.id, cu.id);
  check('...their messages are gone', !convo || !(convo.messages || []).some((m) => String(m.senderId) === String(fan.id)));
  check('...the ledger records the forfeit', (await query(`select 1 from credit_ledger where user_id = $1 and type = 'account_deleted'`, [String(fan.id)])).rows.length === 1);
  check('...and server/ is told (queued banned FAN)', (await query(`select status, role from server_standing_pushes where uid = $1`, [String(fan.id)])).rows[0]?.role === 'FAN');
  const { user: creatorLogin } = await mkCreatorUser();
  let refused = null;
  try { await users.deleteFanAccount(creatorLogin.id); } catch (err) { refused = err.code; }
  check('a creator account is refused here', refused === users.ACCOUNT_IS_CREATOR);

  const f2 = await mkFan();
  const bad = await call(changePasswordRoute, { user: f2, body: { currentPassword: 'wrong', newPassword: 'newpassword1' } });
  check('a wrong current password is refused', bad.statusCode === 401);
  const ok = await call(changePasswordRoute, { user: f2, body: { currentPassword: 'password123', newPassword: 'newpassword1' } });
  const after = await users.findUserById(f2.id);
  check('the password changes and the session epoch moves', ok.statusCode === 200 && after.sessionVersion === 1 && (await users.verifyPassword(after, 'newpassword1')));
  check('...and this browser gets a fresh cookie', String(ok.headers['set-cookie'] || '').startsWith('oa_session='));
}

section('srv-auth-core#0/#2/#5: durable standing outbox');
{
  await reset();
  const fan = await mkFan();
  const sent = [];
  const okFetch = async (u, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };
  const failFetch = async () => ({ ok: false, status: 404 });
  await quiet(() => users.setUserModeration(fan.id, { status: 'banned' }));
  let row = (await query('select * from server_standing_pushes where uid = $1', [String(fan.id)])).rows[0];
  check('moderating a fan queues its standing in the same commit', row && row.status === 'banned' && row.role === 'FAN', JSON.stringify(row));
  const f1 = await quiet(() => outbox.deliverStandingPushes({ uids: [fan.id], fetchImpl: failFetch }));
  row = (await query('select * from server_standing_pushes where uid = $1', [String(fan.id)])).rows[0];
  check('a failed delivery stays queued with backoff', f1.failed === 1 && row.attempts === 1 && row.last_error === 'http_404' && new Date(row.next_at) > new Date());
  const d1 = await outbox.deliverStandingPushes({ uids: [fan.id], fetchImpl: okFetch });
  check('a 2xx delivery removes it', d1.sent === 1 && (await query('select 1 from server_standing_pushes')).rows.length === 0);
  const claims = JSON.parse(Buffer.from(sent[0].token.split('.')[0], 'base64url').toString('utf8'));
  check('the signed push carries role, standingAt (also in the body)', claims.role === 'FAN' && Number.isFinite(claims.standingAt) && sent[0].standingAt === claims.standingAt, JSON.stringify(claims));

  const { creator, user: cu } = await mkCreatorUser();
  const until = new Date(Date.now() + 5 * 864e5).toISOString();
  await query(`update creators set data = data || jsonb_build_object('status', 'suspended', 'suspendedUntil', $2::text) where id = $1`, [String(creator.id), until]);
  await quiet(() => serverApi.pushCreatorStatus(creator.id));
  const q1 = (await query('select * from server_standing_pushes where uid = $1', [String(cu.id)])).rows[0];
  check('a creator suspension is queued with its end date', q1 && q1.status === 'suspended' && Number(q1.suspended_until) === Date.parse(until), JSON.stringify(q1));
  await query(`update creators set data = data || '{"status":"banned"}' where id = $1`, [String(creator.id)]);
  await quiet(() => serverApi.pushCreatorStatus(creator.id));
  const q2 = (await query('select * from server_standing_pushes where uid = $1', [String(cu.id)])).rows;
  check('a newer decision replaces the undelivered older one', q2.length === 1 && q2[0].status === 'banned' && q2[0].attempts >= 0, JSON.stringify(q2));
  sent.length = 0;
  await outbox.deliverStandingPushes({ fetchImpl: okFetch, limit: 10 });
  await outbox.deliverStandingPushes({ uids: [cu.id], fetchImpl: okFetch });
  const c2 = sent.map((b) => JSON.parse(Buffer.from(b.token.split('.')[0], 'base64url').toString('utf8'))).find((c) => c.uid === String(cu.id));
  check('the delivered push is the latest (banned, CREATOR)', c2 && c2.creatorStatus === 'banned' && c2.role === 'CREATOR', JSON.stringify(sent));

  const del = await quiet(() => creators.deleteCreator(creator.id, { force: true }));
  const q3 = (await query('select status from server_standing_pushes where uid = $1', [String(cu.id)])).rows[0];
  check('deleting a creator queues their login as banned in the same commit', del.removedUserIds.includes(String(cu.id)) && q3?.status === 'banned');

  const t = JSON.parse(Buffer.from(bridgeToken.mintBridgeToken({ id: 'u1', role: 'fan' }, null, { fanStanding: 'suspended', standingAt: 123 }).split('.')[0], 'base64url').toString('utf8'));
  check('a fan exchange token carries its standing and stamp', t.standing === 'suspended' && t.standingAt === 123 && t.creatorStatus === null, JSON.stringify(t));
  const t2 = JSON.parse(Buffer.from(bridgeToken.mintBridgeToken({ id: 'u1', role: 'fan' }, null, { fanStanding: 'weird' }).split('.')[0], 'base64url').toString('utf8'));
  check('an unknown fan standing fails closed', t2.standing === 'banned');
  const saved = process.env.BRIDGE_SECRET;
  delete process.env.BRIDGE_SECRET;
  check('nothing is queued without BRIDGE_SECRET', (await outbox.enqueueStandingPushes([{ uid: 'x', status: 'banned' }])) === 0);
  process.env.BRIDGE_SECRET = saved;
}

section('admin-ui#3: a creator\'s own §2257 record is not a co-performer');
{
  await reset();
  const rec = await records.createPerformerRecord({ legalName: 'Jane Real', dateOfBirth: '1990-01-01', producedAt: '2026-09-01', documentLocation: 'offline', creatorId: '12' });
  await query(`update performer_records set data = data || '{"creatorId":"12","documentLocation":"offline"}' where id = $1`, [rec.id]);
  const own = await attestation.resolvePerformerAttestation({ othersAppear: true, coPerformerRecordIds: [String(rec.id)] }, { admin: true, creatorId: '12' });
  check('refused for the same creator', own.status === 409 && /own/.test(own.error), JSON.stringify(own));
  const other = await attestation.resolvePerformerAttestation({ othersAppear: true, coPerformerRecordIds: [String(rec.id)] }, { admin: true, creatorId: '13' });
  check('accepted for a different creator', other.attestation?.coPerformerRecordIds?.[0] === String(rec.id), JSON.stringify(other));
}

section('money#0 / legal-journeys#3 / accounts#0: small contracts');
{
  check('ToS version bumped for the 2026-09-25 Section 6 change', tos.CURRENT_TOS_VERSION === '2026-09-25' && ordersStore.CURRENT_TOS_VERSION === '2026-09-25');
  const code = referral.normalizeReferralCode('a'.repeat(39) + '\u{1F600}');
  let ok = true;
  try { encodeURIComponent(code); } catch { ok = false; }
  check('an emoji straddling the cap cannot leave a lone surrogate', ok && code === 'a'.repeat(39), JSON.stringify(code));
  check('the @ and case are normalised', referral.normalizeReferralCode('@Jane_Doe') === 'jane_doe');
  check('an array ?ref= does not throw', referral.normalizeReferralCode(['x', 'y']) === 'xy');
  const src = (await import('fs')).readFileSync(new URL('../pages/api/marketplace/orders/create.js', import.meta.url), 'utf8');
  check("the duplicate-checkout answer carries its code", /code: 'DUPLICATE_CHECKOUT'/.test(src));
}

section('accounts#9: display names are trimmed and never blank');
{
  await reset();
  const u = { id: 'x', displayName: '   ', email: 'jane_user' };
  check('a whitespace displayName falls back', (await users.displayNameFor(u)) === 'jane_user');
  const { creator, user } = await mkCreatorUser({ name: '  ' });
  check('a whitespace creator name falls back to Someone', (await users.displayNameFor(user)) === 'Someone');
  void creator;
}

section('R4B fix-up: evidence is never lost to ordering or a stale request');
{
  await reset();
  // A DM's evidence copy is written in the removal's own transaction: a
  // failed copy leaves the message in place.
  const { user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'test' });
  const sent = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'evidence', expectedPriceCents: 99 });
  const convo = await messages.getConversationBetween(fan.id, cu.id);
  let threw = false;
  try {
    await messages.removeConversationMessage(convo.id, sent.message.id, { beforeRemove: async () => { throw new Error('snapshot failed'); } });
  } catch { threw = true; }
  const still = await messages.getConversationBetween(fan.id, cu.id);
  check('a failed evidence copy leaves the message in place', threw && still.messages.some((m) => m.id === sent.message.id));
  const rep = await call(messageReportRoute, { user: cu, body: { withUserId: fan.id, messageId: sent.message.id, reason: 'underage', category: 'minor' } });
  const res1 = await call(reportsResolveRoute, { admin: true, body: { id: rep.body.report.id, action: 'remove_content' } });
  const snap = (await query('select data from reports where id = $1', [rep.body.report.id])).rows[0].data;
  check('the copy and the removal commit together', res1.body.content === 'removed' && snap.removedContent?.text === 'evidence' && snap.status === 'actioned', JSON.stringify(snap));

  // gallery-delete with a stale/wrong src quarantines nothing.
  const { creator } = await mkCreatorUser();
  const g = galleryFile(creator.id);
  const other = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g }, []);
  const r = await ncii.addNciiReport({ category: 'minor', contentLocation: 'x', description: 'x', goodFaithStatement: true });
  const wrong = await call(adminGalleryDeleteRoute, { admin: true, body: { creatorId: String(creator.id), src: other, preserveForNciiReportId: String(r.id) } });
  check('a src not in the gallery is 409', wrong.statusCode === 409);
  check('...and nothing was quarantined', (await query('select 1 from media_preservations')).rows.length === 0);
  const unknown = await call(adminGalleryDeleteRoute, { admin: true, body: { creatorId: String(creator.id), src: g, preserveForNciiReportId: '999999' } });
  const kept = await creators.getCreatorById(creator.id);
  check('an unknown report removes nothing', unknown.statusCode === 404 && kept.gallery.some((i) => i.src === g));
  const right = await call(adminGalleryDeleteRoute, { admin: true, body: { creatorId: String(creator.id), src: g, preserveForNciiReportId: String(r.id) } });
  const gone = await creators.getCreatorById(creator.id);
  check('the real item is preserved and removed together', right.statusCode === 200 && right.body.preserved === true && !gone.gallery.some((i) => i.src === g), JSON.stringify(right.body));
  check('...with no deletion queued for it', !(await query('select pathname from media_uploads')).rows.some((x) => x.pathname === strip(g)));

  // A file preserved after the sweep claimed it is not deleted.
  await reset();
  const a = media.newMediaPathname({ purpose: 'gallery', creatorId: '1', contentType: 'image/jpeg' });
  const b = media.newMediaPathname({ purpose: 'gallery', creatorId: '1', contentType: 'image/jpeg' });
  const c = media.newMediaPathname({ purpose: 'gallery', creatorId: '1', contentType: 'image/jpeg' });
  for (const p of [a, b, c]) {
    await media.recordPendingMediaPath(p, 'delete_pending');
    await new Promise((ok) => setTimeout(ok, 5));
  }
  const deleted = [];
  const sw = await media.sweepOrphanedMedia({
    deleteFile: async (p) => {
      deleted.push(p);
      if (p === a) {
        // b: preservation committed after the claim (row still there);
        // c: preserved the normal way (its media_uploads row goes with it).
        await query(`insert into media_preservations (pathname, reason, preserved_by, retain_until) values ($1, 'x', 'admin', now() + interval '365 days')`, [b]);
        await withTransaction((client) => preservation.preserveMedia([`/api/media/${c}`], { reportId: 'ncii:1', reason: 'x', client }));
      }
    },
  });
  check('files preserved mid-sweep are not deleted', deleted.length === 1 && deleted[0] === a, JSON.stringify([deleted, sw]));
  check('...and are off the queue', (await query('select pathname from media_uploads')).rows.length === 0);

  // Moderation set on a pending applicant can be cleared after approval.
  await reset();
  const { creator: pc, user: pu } = await mkCreatorUser({ status: 'pending' });
  await quiet(() => users.setUserModeration(pu.id, { status: 'suspended', until: Date.now() + 864e5 }));
  await query(`update creators set data = data || '{"status":"active"}'::jsonb where id = $1`, [String(pc.id)]);
  let refusedSuspend = null;
  try { await users.setUserModeration(pu.id, { status: 'banned' }); } catch (err) { refusedSuspend = err.code; }
  check('an approved creator still cannot be banned at account level', refusedSuspend === users.USER_MODERATION_NOT_ALLOWED);
  const cleared = await quiet(() => users.setUserModeration(pu.id, { status: null }));
  check('...but leftover account moderation can be cleared', cleared && cleared.moderationStatus === null, JSON.stringify(cleared));

  // The filter's new names do not flag ordinary chat.
  const { detectPaymentCircumvention } = await import('./payment-circumvention-filter.js');
  for (const t of ['check all my links', 'she is at gmail right now', 'we at yahoo']) {
    check(`not flagged: ${t}`, !detectPaymentCircumvention(t).flagged);
  }
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
