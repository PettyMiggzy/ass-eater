// Regression tests for the round-5 backend fixes (package R5B), run against a
// real scratch Postgres (it truncates tables), never mocks:
//  - media#0: a finalize error only ever deletes the caller's own unfinalized,
//    unreferenced, unpreserved, unheld upload -- never a paid or preserved file;
//  - media#1: moving preserved files to evidence/ is claim-safe and never
//    marks a moved file missing; the export finds a file wherever it is;
//  - media#2 / social#0: reports copy their target at FILING time, and a
//    possible-minor listing report puts its files on hold (not deleted, still
//    served) until the report is resolved;
//  - social#1 / admin-ui#1: resolving a report or violation twice is a 409;
//    dismissing a serious report needs a reason; dismissed reports reopen;
//  - dashboard#0 / legal-journeys#0: self-deletion keeps reported content on
//    the report and is refused while suspended or under a serious report;
//  - accounts#0..#6: profile echo exemption, filter terms, founding stamps,
//    creator deletion cleanup, creator email at signup, "hololive";
//  - admin-ui#0: the specific-item takedown endpoint and the 'removed' rule.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r5b.test.mjs

import crypto from 'crypto';
import { BlobNotFoundError } from '@vercel/blob';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
delete process.env.NCII_ALERT_WEBHOOK_URL;
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.BRIDGE_SECRET = 'test-bridge-secret-r5b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r5b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { query, withTransaction, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const preservation = await import('./media-preservation.js');
const blobCleanup = await import('./blob-cleanup.js');
const ncii = await import('./ncii-reports-store.js');
const messages = await import('./messages-store.js');
const reportsStore = await import('./reports-store.js');
const violations = await import('./violations-store.js');
const wall = await import('./wall-store.js');
const credits = await import('./credits-store.js');
const takedown = await import('./content-takedown.js');
const { screenPublicText } = await import('./prohibited-terms.js');
const { createSessionToken } = await import('./session.js');
const { default: wallReportRoute } = await import('../pages/api/wall/report.js');
const { default: messageReportRoute } = await import('../pages/api/messages/report.js');
const { default: listingReportRoute } = await import('../pages/api/marketplace/report.js');
const { default: reportsRoute } = await import('../pages/api/admin/reports.js');
const { default: reportsResolveRoute } = await import('../pages/api/admin/reports-resolve.js');
const { default: violationsResolveRoute } = await import('../pages/api/admin/violations-resolve.js');
const { default: deleteAccountRoute } = await import('../pages/api/auth/delete-account.js');
const { default: meProfileRoute } = await import('../pages/api/me/profile.js');
const { default: adminProfileRoute } = await import('../pages/api/admin/profile.js');
const { default: signupRoute } = await import('../pages/api/auth/signup.js');
const { default: marketplaceUploadRoute } = await import('../pages/api/marketplace/upload.js');
const { default: contentTakedownRoute } = await import('../pages/api/admin/content-takedown.js');
const { default: nciiResolveRoute } = await import('../pages/api/admin/ncii-reports-resolve.js');
const { default: galleryDeleteRoute } = await import('../pages/api/admin/gallery-delete.js');

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
    end(b) { this.headersSent = true; if (b) { try { this.body = JSON.parse(b); } catch { this.body = b; } } },
    destroy() {},
    on() {}, once() {}, emit() {}, write() { return true; },
  };
}
let ipN = 0;
async function call(route, { method = 'POST', body, query: q = {}, admin = false, user = null } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = { 'x-forwarded-for': `10.55.${Math.floor(ipN / 250)}.${ipN % 250}` };
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  if (user) headers.cookie = `oa_session=${createSessionToken(user.id, user.sessionVersion || 0)}`;
  await quiet(() => route({ method, body, query: q, headers, socket: { remoteAddress: headers['x-forwarded-for'] } }, res));
  return res;
}
async function reset() {
  await query(`truncate creators, users, listings, orders, credit_balances, credit_ledger, payout_requests, checkout_idempotency,
    used_payment_tx, ncii_reports, media_uploads, performer_records, media_preservations, media_holds, moderation_actions,
    server_standing_pushes, conversations, reports, violations, wall_posts, favorites, notifications restart identity`);
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
let n = 0;
async function mkCreatorUser(fields = {}) {
  n++;
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r5bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r5b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan(extra = {}) {
  n++;
  const u = await users.createUser({ email: `f${n}@r5b.test`, password: 'password123', role: 'fan' });
  if (Object.keys(extra).length) {
    await query('update users set data = data || $2::jsonb where id = $1', [u.id, JSON.stringify(extra)]);
    return users.findUserById(u.id);
  }
  return u;
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
const galleryFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'gallery', creatorId, contentType: 'image/jpeg' }));
const strip = (src) => src.replace('/api/media/', '');
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}
async function paidOrder(listing, buyerId) {
  await query('insert into orders (data) values ($1)', [{
    listingId: String(listing.id), creatorId: String(listing.creatorId), buyerId: String(buyerId), kind: 'digital',
    status: 'fulfilled', createdAt: new Date().toISOString(),
  }]);
}
const getListing = async (id) => (await query('select data from listings where id = $1', [String(id)])).rows[0].data;
const reportRow = async (id) => (await query('select data from reports where id = $1', [String(id)])).rows[0].data;
const tokenRow = (p) => query(`insert into media_uploads (pathname, reason) values ($1, 'token') on conflict (pathname) do update set reason = 'token'`, [p]);

// ---------------------------------------------------------------------------
await reset();

section('media#0: finalize error deletes only an unfinalized, unreferenced, unguarded upload');
{
  const { creator, user } = await mkCreatorUser();
  const l = await mkListing(creator.id);
  const fan = await mkFan();
  await paidOrder(l, fan.id);
  const paidPath = strip(l.media[0].src);
  await tokenRow(paidPath); // still inside its first hour: the token row is there too
  const deleted = [];
  const deleteFile = async (p) => { deleted.push(p); };
  check('a file a listing references is kept', (await media.deleteUnfinalizedUpload(paidPath, { deleteFile })) === 'kept' && !deleted.length);

  const g = strip(galleryFile(creator.id));
  await tokenRow(g);
  await preservation.preserveMedia([media.mediaSrc(g)], { reportId: 'ncii:1', reason: 'test' });
  check('a preserved file is kept', (await media.deleteUnfinalizedUpload(g, { deleteFile })) === 'kept' && !deleted.length);

  const h = strip(galleryFile(creator.id));
  await tokenRow(h);
  await preservation.holdMediaForReport([media.mediaSrc(h)], 'report:9');
  check('a held file is kept', (await media.deleteUnfinalizedUpload(h, { deleteFile })) === 'kept' && !deleted.length);

  const noToken = strip(galleryFile(creator.id));
  check('a file with no upload-token row is kept', (await media.deleteUnfinalizedUpload(noToken, { deleteFile })) === 'kept' && !deleted.length);

  const fresh = strip(galleryFile(creator.id));
  await tokenRow(fresh);
  const out = await media.deleteUnfinalizedUpload(fresh, { deleteFile });
  check('a fresh unreferenced upload IS deleted', out === 'deleted' && deleted.includes(fresh), out);
  check('...and its token row is gone', !(await query('select 1 from media_uploads where pathname = $1', [fresh])).rows.length);

  const notFound = strip(galleryFile(creator.id));
  await tokenRow(notFound);
  const nf = await media.deleteUnfinalizedUpload(notFound, { deleteFile: async () => { throw new BlobNotFoundError(); } });
  check('an upload that never arrived counts as deleted', nf === 'deleted');

  // Route level: a bad attestation on a PAID listing file leaves everything in place.
  const res = await call(marketplaceUploadRoute, { user, body: { listingId: String(l.id), pathname: paidPath } });
  check('the finalize answers the attestation error', res.statusCode === 400, JSON.stringify(res.body));
  const after = await getListing(l.id);
  check('...the paid file is still on the listing', after.media.some((m) => m.src === l.media[0].src) && !after.mediaDeletedAt);
  check('...and its token row was not consumed', (await query(`select reason from media_uploads where pathname = $1`, [paidPath])).rows[0]?.reason === 'token');
}

section('media#1: moving to evidence is claim-safe and never marks a moved file missing');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const src = galleryFile(creator.id);
  const p = strip(src);
  await preservation.preserveMedia([src], { reportId: 'ncii:4', reason: 'test' });
  const store = new Set([p]);
  const renameFile = async (from, to) => {
    await new Promise((r) => setTimeout(r, 20));
    if (!store.has(from)) throw new BlobNotFoundError();
    store.delete(from); store.add(to);
  };
  const headFile = async (x) => { if (!store.has(x)) throw new BlobNotFoundError(); return { size: 1 }; };
  const [a, b] = await Promise.all([
    preservation.movePreservedToEvidence({ renameFile, headFile }),
    preservation.movePreservedToEvidence({ renameFile, headFile }),
  ]);
  const row = (await query('select evidence_pathname, missing_at from media_preservations where pathname = $1', [p])).rows[0];
  check('two concurrent moves move it exactly once', a.moved + b.moved === 1 && a.missing + b.missing === 0, JSON.stringify([a, b]));
  check('...recorded as moved, not missing', row.evidence_pathname === preservation.evidencePathnameFor('ncii:4', p) && row.missing_at === null, JSON.stringify(row));

  // A rename that succeeded but whose bookkeeping never committed.
  const src2 = galleryFile(creator.id);
  const p2 = strip(src2);
  await preservation.preserveMedia([src2], { reportId: 'ncii:4', reason: 'test' });
  store.add(preservation.evidencePathnameFor('ncii:4', p2)); // already at the target, not at the source
  const c = await preservation.movePreservedToEvidence({ renameFile, headFile });
  const row2 = (await query('select evidence_pathname, missing_at from media_preservations where pathname = $1', [p2])).rows[0];
  check('a file already at its evidence path is recorded as moved', c.moved === 1 && row2.evidence_pathname && !row2.missing_at, JSON.stringify([c, row2]));

  // Truly gone -> missing.
  const src3 = galleryFile(creator.id);
  await preservation.preserveMedia([src3], { reportId: 'ncii:4', reason: 'test' });
  const d = await preservation.movePreservedToEvidence({ renameFile, headFile });
  check('a file in neither place is marked missing', d.missing === 1);

  // Export falls back to the evidence path even for a row wrongly marked missing.
  const src4 = galleryFile(creator.id);
  const p4 = strip(src4);
  await preservation.preserveMedia([src4], { reportId: 'ncii:4', reason: 'test' });
  await query('update media_preservations set missing_at = now() where pathname = $1', [p4]);
  const target4 = preservation.evidencePathnameFor('ncii:4', p4);
  const getFile = async (x) => (x === target4
    ? { statusCode: 200, stream: new ReadableStream({ start(ctl) { ctl.enqueue(new Uint8Array([1])); ctl.close(); } }), headers: new Headers() }
    : { statusCode: 404 });
  const res = fakeRes();
  await quiet(() => preservation.sendPreservedMedia(res, p4, { getFile }));
  const row4 = (await query('select evidence_pathname, missing_at, export_count from media_preservations where pathname = $1', [p4])).rows[0];
  check('the export finds the file at its evidence path', res.statusCode === 200, String(res.statusCode));
  check('...and corrects the row', row4.evidence_pathname === target4 && row4.missing_at === null && row4.export_count === 1, JSON.stringify(row4));
}

section('media#2 + social#0: reports copy their target at filing; possible-minor listing files are held');
{
  await reset();
  const { creator, user: seller } = await mkCreatorUser();
  const reporter = await mkFan();
  const l = await mkListing(creator.id);
  const heldSrc = l.media[0].src;
  const rep = await call(listingReportRoute, { user: reporter, body: { listingId: String(l.id), reason: 'looks under 18', category: 'minor' } });
  check('the report files', rep.statusCode === 200, JSON.stringify(rep.body));
  check('the reporter is not shown the stored copy', rep.body.report && !('reportedContent' in rep.body.report) && !('heldMedia' in rep.body.report));
  const stored = await reportRow(rep.body.report.id);
  check('the listing text and files are copied onto the report', stored.reportedContent?.title === 'Set' && stored.reportedContent.media[0].src === heldSrc, JSON.stringify(stored));
  check('the files are on hold', (await preservation.heldPathsForReport(`report:${rep.body.report.id}`)).includes(strip(heldSrc)));

  // The seller removes the reported file: it leaves the listing but is NOT deleted.
  const del = await quiet(() => listings.removeListingMediaForOwner(l.id, creator.id, heldSrc));
  check('the seller can still edit the listing', del.listing.media.length === 0);
  check('...the held file stays on the sweep list, not deleted',
    (await query(`select reason from media_uploads where pathname = $1`, [strip(heldSrc)])).rows[0]?.reason === 'delete_pending');
  const swept = [];
  await media.sweepOrphanedMedia({ deleteFile: async (x) => { swept.push(x); } });
  check('the sweep skips a held file', !swept.includes(strip(heldSrc)));
  check('a hold does not stop serving (not treated as preserved by the /api/media gate)', (await preservation.isMediaPreserved(strip(heldSrc))) === false);

  // remove_content preserves the HELD file (no longer on the listing).
  const resolved = await call(reportsResolveRoute, { admin: true, body: { id: rep.body.report.id, action: 'remove_content' } });
  check('remove_content succeeds', resolved.statusCode === 200 && resolved.body.content === 'removed', JSON.stringify(resolved.body));
  const kept = (await query('select report_id from media_preservations where pathname = $1', [strip(heldSrc)])).rows[0];
  check('the file removed by the seller was preserved as evidence', kept?.report_id === `report:${rep.body.report.id}`, JSON.stringify(kept));
  check('the hold was released (superseded)', (await preservation.heldPathsForReport(`report:${rep.body.report.id}`)).length === 0);

  // Dismissing a held report releases the hold, and the sweep may then delete.
  const l2 = await mkListing(creator.id);
  const rep2 = await call(listingReportRoute, { user: reporter, body: { listingId: String(l2.id), reason: 'x', category: 'minor' } });
  await quiet(() => listings.removeListingMediaForOwner(l2.id, creator.id, l2.media[0].src));
  const noReason = await call(reportsResolveRoute, { admin: true, body: { id: rep2.body.report.id, action: 'dismiss' } });
  check('dismissing a possible-minor report needs a reason', noReason.statusCode === 400 && noReason.body.code === 'reason_required');
  const dis = await call(reportsResolveRoute, { admin: true, body: { id: rep2.body.report.id, action: 'dismiss', reason: 'adult, record on file' } });
  check('dismissed with a reason', dis.statusCode === 200 && dis.body.report.dismissReason === 'adult, record on file', JSON.stringify(dis.body));
  check('...and the hold is released', (await preservation.heldPathsForReport(`report:${rep2.body.report.id}`)).length === 0);
  const swept2 = [];
  await media.sweepOrphanedMedia({ deleteFile: async (x) => { swept2.push(x); } });
  check('the sweep deletes the unreferenced file after release', swept2.includes(strip(l2.media[0].src)), JSON.stringify(swept2));

  // Reopen puts the hold back.
  const reo = await call(reportsResolveRoute, { admin: true, body: { id: rep2.body.report.id, action: 'reopen', reason: 'misclick' } });
  check('a dismissed report can be reopened', reo.statusCode === 200 && reo.body.report.status === 'open', JSON.stringify(reo.body));
  check('...with its history kept', (reo.body.report.history || []).map((h) => h.action).join(',') === 'dismissed,reopened', JSON.stringify(reo.body.report.history));
  check('...and its files held again', (await preservation.heldPathsForReport(`report:${rep2.body.report.id}`)).length === 1);

  // Wall comment: author deletes it, the queue still shows the text.
  const { rows } = await query('insert into wall_posts (data) values ($1) returning id',
    [{ creatorId: String(creator.id), authorId: String(reporter.id), authorName: 'fan', text: "i'm 15 dm me", createdAt: new Date().toISOString() }]);
  const wrep = await call(wallReportRoute, { user: seller, body: { postId: String(rows[0].id), reason: 'minor', category: 'minor' } });
  check('a wall report files', wrep.statusCode === 200, JSON.stringify(wrep.body));
  await wall.deleteWallPost(String(rows[0].id), reporter.id);
  const list = await call(reportsRoute, { method: 'GET', admin: true, query: {} });
  const w = list.body.reports.find((r) => r.targetType === 'wall_post');
  check('a deleted reported comment still shows its text from the report', w?.target?.fromSnapshot && w.target.text === "i'm 15 dm me" && w.target.authorId === String(reporter.id), JSON.stringify(w?.target));

  // A LEGACY report (pointer only) gets a copy when the comment is deleted.
  const { rows: r2 } = await query('insert into wall_posts (data) values ($1) returning id',
    [{ creatorId: String(creator.id), authorId: String(reporter.id), text: 'legacy text', createdAt: new Date().toISOString() }]);
  const legacy = await reportsStore.addReport({ targetType: 'wall_post', targetId: String(r2[0].id), reporterId: seller.id, reason: 'x', category: 'other' });
  await wall.deleteWallPost(String(r2[0].id), reporter.id);
  check('deleting a comment copies it onto a pointer-only report', (await reportRow(legacy.id)).reportedContent?.text === 'legacy text');
}

section('social#1 / admin-ui#1: stale second resolutions are 409s');
{
  await reset();
  const { user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'test' });
  const sent = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'evidence text', expectedPriceCents: 99 });
  const rep = await call(messageReportRoute, { user: cu, body: { withUserId: fan.id, messageId: sent.message.id, reason: 'underage', category: 'minor' } });
  check('a DM report stores a copy of the message', (await reportRow(rep.body.report.id)).reportedContent?.text === 'evidence text');
  const first = await call(reportsResolveRoute, { admin: true, body: { id: rep.body.report.id, action: 'remove_content' } });
  const second = await call(reportsResolveRoute, { admin: true, body: { id: rep.body.report.id, action: 'dismiss', reason: 'stale tab' } });
  check('the first resolution wins', first.statusCode === 200);
  check('a second, stale one is 409', second.statusCode === 409 && second.body.code === 'already_resolved', JSON.stringify(second.body));
  const row = await reportRow(rep.body.report.id);
  check('...and did not overwrite it', row.status === 'actioned' && !row.dismissReason && !row.resolving, JSON.stringify(row));
  const noReopen = await call(reportsResolveRoute, { admin: true, body: { id: rep.body.report.id, action: 'reopen', reason: 'x' } });
  check('an actioned report cannot be reopened', noReopen.statusCode === 409 && noReopen.body.code === 'not_reopenable');

  // Concurrent: exactly one wins.
  const sent2 = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'two', expectedPriceCents: 99 });
  const rep2 = await call(messageReportRoute, { user: cu, body: { withUserId: fan.id, messageId: sent2.message.id, reason: 'x' } });
  const both = await Promise.all([
    call(reportsResolveRoute, { admin: true, body: { id: rep2.body.report.id, action: 'remove_content' } }),
    call(reportsResolveRoute, { admin: true, body: { id: rep2.body.report.id, action: 'dismiss' } }),
  ]);
  check('two concurrent resolutions: one 200, one 409', both.map((r) => r.statusCode).sort().join(',') === '200,409', both.map((r) => r.statusCode).join(','));

  const v = await violations.addViolation({ userId: 'u1', context: 'bio', reasons: ['venmo'], snippet: 'x' });
  const v1 = await call(violationsResolveRoute, { admin: true, body: { id: String(v.id), action: 'confirmed' } });
  const v2 = await call(violationsResolveRoute, { admin: true, body: { id: String(v.id), action: 'dismiss' } });
  check('violations: the second resolution is 409', v1.statusCode === 200 && v2.statusCode === 409, `${v1.statusCode}/${v2.statusCode}`);
  check('...and the first stands', (await query('select data from violations where id = $1', [v.id])).rows[0].data.status === 'confirmed');
}

section('dashboard#0 / legal-journeys#0: self-deletion');
{
  await reset();
  const { user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'test' });
  const sent = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'bad dm', expectedPriceCents: 99 });
  // A pointer-only (older) report, then a serious one.
  const legacy = await reportsStore.addReport({ targetType: 'message', targetId: sent.message.id, conversationId: (await messages.getConversationBetween(fan.id, cu.id)).id, reporterId: cu.id, reason: 'x', category: 'other' });
  const rep = await call(messageReportRoute, { user: cu, body: { withUserId: fan.id, messageId: sent.message.id, reason: 'little sister', category: 'minor' } });
  const res = await call(deleteAccountRoute, { user: fan, body: { password: 'password123', acknowledgeForfeit: true, expectedForfeitCents: await credits.getBalanceCents(fan.id), expectedDigitalPurchases: 0 } });
  check('refused while a possible-minor report against their message is open', res.statusCode === 409 && res.body.code === 'account_under_review', JSON.stringify(res.body));
  check('...nothing was deleted', !!(await users.findUserById(fan.id)));
  await call(reportsResolveRoute, { admin: true, body: { id: rep.body.report.id, action: 'dismiss', reason: 'checked' } });
  const ok = await call(deleteAccountRoute, { user: fan, body: { password: 'password123', acknowledgeForfeit: true, expectedForfeitCents: await credits.getBalanceCents(fan.id), expectedDigitalPurchases: 0 } });
  check('allowed once no serious report is open', ok.statusCode === 200, JSON.stringify(ok.body));
  check('the pointer-only report kept a copy of the deleted message', (await reportRow(legacy.id)).reportedContent?.text === 'bad dm', JSON.stringify(await reportRow(legacy.id)));
  const list = await call(reportsRoute, { method: 'GET', admin: true, query: { status: 'all' } });
  const shown = list.body.reports.find((r) => String(r.id) === String(legacy.id));
  check('the queue shows it from the copy', shown?.target?.fromSnapshot && shown.target.text === 'bad dm' && shown.target.senderId === String(fan.id), JSON.stringify(shown?.target));

  const suspended = await mkFan({ moderationStatus: 'suspended', moderationUntil: new Date(Date.now() + 864e5).toISOString() });
  const s = await call(deleteAccountRoute, { user: suspended, body: { password: 'password123' } });
  check('a suspended account cannot self-delete', s.statusCode === 409 && s.body.code === 'account_under_review', JSON.stringify(s.body));
  let threw = null;
  try { await users.deleteFanAccount(suspended.id, { selfService: true }); } catch (e) { threw = e; }
  check('...enforced in the store too', threw?.code === users.ACCOUNT_UNDER_REVIEW);
  const adminDel = await users.deleteFanAccount(suspended.id, { strict: true });
  check('the admin path can still delete a moderated account', adminDel?.deletedUserId === String(suspended.id));
}

section('accounts#4: deleting a creator removes what their login wrote');
{
  await reset();
  const { creator, user: cu } = await mkCreatorUser();
  const fan = await mkFan();
  const { creator: other } = await mkCreatorUser();
  await query('insert into wall_posts (data) values ($1), ($2), ($3)', [
    { creatorId: String(other.id), authorId: String(cu.id), text: 'creator comment elsewhere', createdAt: new Date().toISOString() },
    { creatorId: String(creator.id), authorId: String(fan.id), text: 'fan comment on the creator wall', createdAt: new Date().toISOString() },
    { creatorId: String(other.id), authorId: String(fan.id), text: 'unrelated', createdAt: new Date().toISOString() },
  ]);
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'test' });
  await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hi', expectedPriceCents: 99 });
  const reply = await messages.sendDirectMessage({ sender: cu, recipientId: fan.id, text: 'creator reply' });
  const rep = await reportsStore.addReport({ targetType: 'message', targetId: reply.message.id, conversationId: (await messages.getConversationBetween(fan.id, cu.id)).id, reporterId: fan.id, reason: 'x', category: 'other' });
  await query(`insert into favorites (fan_id, creator_id) values ($1, $2)`, [String(cu.id), String(other.id)]);
  await query(`insert into notifications (user_id, type, message) values ($1, 'sale', 'x')`, [String(cu.id)]).catch(() => {});
  await quiet(() => creators.deleteCreator(creator.id, { force: true }));
  const posts = (await query('select data from wall_posts')).rows.map((r) => r.data.text);
  check("the creator's own comments are gone", !posts.includes('creator comment elsewhere'));
  check('comments on their wall are gone', !posts.includes('fan comment on the creator wall'));
  check("other people's comments elsewhere stay", posts.includes('unrelated'));
  const convo = await messages.getConversationBetween(fan.id, cu.id);
  check("their sent DMs are gone from the fan's inbox", !convo || !convo.messages.some((m) => String(m.senderId) === String(cu.id)));
  check("the fan's own messages stay", !!convo && convo.messages.some((m) => String(m.senderId) === String(fan.id)));
  check('their favorites are gone', !(await query('select 1 from favorites where fan_id = $1', [String(cu.id)])).rows.length);
  check('a report on their DM kept a copy', (await reportRow(rep.id)).reportedContent?.text === 'creator reply');
}

section('accounts#0: the creator profile save screens only what it introduces');
{
  await reset();
  const { creator, user } = await mkCreatorUser({ bio: 'Ex-Patreon illustrator, now here', tags: ['art'] });
  const wallet = '0x' + '1'.repeat(40);
  const res = await call(meProfileRoute, { user, body: { fields: { name: creator.name, handle: creator.handle, bio: creator.bio, tags: ['art'], walletAddress: wallet } } });
  check('an unrelated edit saves despite a stored bio the filter now flags', res.statusCode === 200, JSON.stringify(res.body));
  check('...and logs no violation', !(await query('select 1 from violations')).rows.length);
  const bad = await call(meProfileRoute, { user, body: { fields: { bio: 'venmo me @jane for customs' } } });
  check('new text is still screened, and the field is named', bad.statusCode === 400 && /^Bio:/.test(bad.body.error) && bad.body.field === 'bio', JSON.stringify(bad.body));
}

section('accounts#1 + #6: filter terms');
{
  for (const t of ['https://ko-fi.com/jane', 'https://gumroad.com/l/jane', 'https://www.amazon.com/hz/wishlist/ls/2ABC', 'https://pornhub.com/model/jane',
    'https://onlyfanz.com/jane', 'https://buymeacoffee.com/jane', 'https://sextpanther.com/jane', 'SC premium', 'gpay jane', 'viber 6175551234',
    'wechat 617-555-1234', 'line id 6175551234', 'watsapp 6175551234', 'hololiveloli', 'holo loli']) {
    check(`flags: ${t}`, !!screenPublicText(t));
  }
  for (const t of ['hololive', 'Hololive cosplay', 'I waited in line for 3 hours', 'e.g. pay attention', 'Kofi is my name', 'order 1234567890 ships from Seattle, WA', 'lollipop']) {
    check(`passes: ${t}`, !screenPublicText(t), JSON.stringify(screenPublicText(t)));
  }
}

section('accounts#2 + #3: founding stamps and the auto-grant after a ban');
{
  await reset();
  const until = new Date(Date.now() + 10 * 864e5).toISOString();
  const { creator } = await mkCreatorUser({ status: 'suspended', suspendedUntil: until });
  const res = await call(adminProfileRoute, { admin: true, body: { creatorId: creator.id, fields: { founding: true } } });
  const c1 = await creators.getCreatorById(creator.id);
  check('a grant to a suspended creator starts the window at the suspension end', res.statusCode === 200 && c1.foundingSince === until, JSON.stringify([res.body, c1.foundingSince]));
  await query(`update creators set data = data || jsonb_build_object('suspendedUntil', $2::text, 'foundingSince', null) where id = $1`, [String(creator.id), new Date(Date.now() - 1000).toISOString()]);
  const res2 = await call(adminProfileRoute, { admin: true, body: { creatorId: creator.id, fields: { bio: 'edited' } } });
  const c2 = await creators.getCreatorById(creator.id);
  check('a founding creator with no start is stamped on the next save once active', res2.statusCode === 200 && Math.abs(Date.parse(c2.foundingSince) - Date.now()) < 60000, JSON.stringify([res2.body, c2.foundingSince]));

  const QUAL = {
    name: 'Jane Real', handle: '@janereal', bio: 'A real, finished bio that is comfortably over forty characters long.',
    img: '/images/demo_female_avatar.jpg', tags: ['cosplay'], gallery: [{ src: '/images/a.jpg' }, { src: '/images/b.jpg' }, { src: '/images/c.jpg' }],
  };
  const b = await creators.createCreator({ ...QUAL, status: 'active' });
  await query('insert into performer_records (data) values ($1)', [{ creatorId: String(b.id), status: 'active', aliases: [], documentLocation: 'offline' }]);
  const banned = await call(adminProfileRoute, { admin: true, body: { creatorId: b.id, fields: { status: 'banned' } } });
  check('a manual ban is marked', banned.statusCode === 200 && !!(await creators.getCreatorById(b.id)).bannedAt, JSON.stringify(banned.body));
  await call(adminProfileRoute, { admin: true, body: { creatorId: b.id, fields: { status: 'pending' } } });
  const react = await call(adminProfileRoute, { admin: true, body: { creatorId: b.id, fields: { status: 'active' } } });
  const cb = await creators.getCreatorById(b.id);
  check('banned -> pending -> active is not a fresh approval (no auto Founding)', react.statusCode === 200 && cb.status === 'active' && !cb.founding, JSON.stringify([react.body, cb.founding]));

  const fresh = await creators.createCreator({ ...QUAL, handle: '@fresh', status: 'pending' });
  await query('insert into performer_records (data) values ($1)', [{ creatorId: String(fresh.id), status: 'active', aliases: [], documentLocation: 'offline' }]);
  const appr = await call(adminProfileRoute, { admin: true, body: { creatorId: fresh.id, fields: { status: 'active' } } });
  const cf = await creators.getCreatorById(fresh.id);
  check('a genuine first approval still auto-grants and records approvedAt', appr.statusCode === 200 && cf.founding === true && !!cf.approvedAt, JSON.stringify([appr.body, cf]));
}

section('accounts#5: a creator must sign up with an email address');
{
  await reset();
  const bad = await call(signupRoute, { body: { role: 'creator', email: 'janedoe', password: 'secret1', displayName: 'Jane', handle: 'jane', acceptedTerms: true } });
  check('a creator username is refused', bad.statusCode === 400 && /email/i.test(bad.body.error), JSON.stringify(bad.body));
  const fan = await call(signupRoute, { body: { role: 'fan', email: 'quietfan', password: 'secret1', acceptedTerms: true } });
  check('a fan may still use a username', fan.statusCode === 200, JSON.stringify(fan.body));
}

section('admin-ui#0: specific-item takedown, attributed to a TAKE IT DOWN request');
{
  await reset();
  const { creator, user: cu } = await mkCreatorUser();
  const buyer = await mkFan();
  const l = await mkListing(creator.id);
  await paidOrder(l, buyer.id);
  const r = await ncii.addNciiReport({ category: 'self', contentLocation: `listing ${l.id}`, description: 'mine', consentStatement: true });

  const early = await call(nciiResolveRoute, { admin: true, body: { id: String(r.id), action: 'removed' } });
  check("'removed' is refused with nothing on file", early.statusCode === 409 && early.body.code === 'takedown_required', JSON.stringify(early.body));
  check('...and nothing changed', (await query('select data from ncii_reports where id = $1', [r.id])).rows[0].data.status === 'open');

  const bad = await call(contentTakedownRoute, { admin: true, body: { type: 'listing', listingId: 'x' } });
  check('a bad target is 400', bad.statusCode === 400);
  const unknown = await call(contentTakedownRoute, { admin: true, body: { type: 'listing', listingId: String(l.id), nciiReportId: '9999' } });
  check('an unknown request removes nothing', unknown.statusCode === 404 && !(await getListing(l.id)).mediaDeletedAt);

  const td = await call(contentTakedownRoute, { admin: true, body: { type: 'listing', listingId: String(l.id), nciiReportId: String(r.id) } });
  check('the listing is taken down', td.statusCode === 200 && td.body.result === 'removed', JSON.stringify(td.body));
  const after = await getListing(l.id);
  check('...including a PAID listing\'s files (no keepPaid)', after.status === 'removed' && !!after.mediaDeletedAt && after.moderationRemoved === true);
  const stored = (await query('select data from ncii_reports where id = $1', [r.id])).rows[0].data;
  check('the takedown is recorded on the request', stored.takedowns?.length === 1 && stored.takedowns[0].snapshot?.title === 'Set', JSON.stringify(stored.takedowns));
  check('...and in the audit trail', (await query('select 1 from moderation_actions')).rows.length === 1);
  const done = await call(nciiResolveRoute, { admin: true, body: { id: String(r.id), action: 'removed' } });
  check("'removed' now resolves", done.statusCode === 200 && done.body.report.removalBasis === 'takedown', JSON.stringify(done.body));

  // A possible-minor request quarantines the listing's files first.
  const l2 = await mkListing(creator.id);
  const minor = await ncii.addNciiReport({ category: 'minor', contentLocation: 'x', description: 'x', goodFaithStatement: true });
  const td2 = await call(contentTakedownRoute, { admin: true, body: { type: 'listing', listingId: String(l2.id), nciiReportId: String(minor.id) } });
  const pres = (await query('select report_id from media_preservations where pathname = $1', [strip(l2.media[0].src)])).rows[0];
  check('possible-minor: the files are preserved, not deleted', td2.statusCode === 200 && td2.body.preserved === 1 && pres?.report_id === `ncii:${minor.id}`, JSON.stringify([td2.body, pres]));

  // Message and wall comment.
  const fan = await mkFan();
  await credits.creditAccount({ userId: fan.id, cents: 5000, type: 'test' });
  const sent = await messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'leaked pic of her', expectedPriceCents: 99 });
  const convo = await messages.getConversationBetween(fan.id, cu.id);
  const tm = await call(contentTakedownRoute, { admin: true, body: { type: 'message', conversationId: convo.id, messageId: sent.message.id } });
  check('a DM is taken down with a copy', tm.statusCode === 200 && tm.body.result === 'removed' && tm.body.snapshot?.text === 'leaked pic of her', JSON.stringify(tm.body));
  const again = await call(contentTakedownRoute, { admin: true, body: { type: 'message', conversationId: convo.id, messageId: sent.message.id } });
  check('...again is already_gone', again.statusCode === 200 && again.body.result === 'already_gone');
  const { rows } = await query('insert into wall_posts (data) values ($1) returning id', [{ creatorId: String(creator.id), authorId: String(fan.id), text: 'wall', createdAt: new Date().toISOString() }]);
  const tw = await call(contentTakedownRoute, { admin: true, body: { type: 'wall_post', postId: String(rows[0].id) } });
  check('a wall comment is taken down', tw.statusCode === 200 && tw.body.result === 'removed' && !(await query('select 1 from wall_posts where id = $1', [rows[0].id])).rows.length);
  const trail = await call(contentTakedownRoute, { method: 'GET', admin: true, query: {} });
  check('the audit trail lists every takedown', trail.statusCode === 200 && trail.body.actions.length === 5, JSON.stringify(trail.body.actions?.length));

  // An attributed gallery removal counts as a recorded takedown too.
  const g = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g }, []);
  const r3 = await ncii.addNciiReport({ category: 'self', contentLocation: 'x', description: 'x', consentStatement: true });
  const gd = await call(galleryDeleteRoute, { admin: true, body: { creatorId: String(creator.id), src: g, nciiReportId: String(r3.id) } });
  check('a gallery removal attributed to a request is recorded on it', gd.statusCode === 200 && (await query('select data from ncii_reports where id = $1', [r3.id])).rows[0].data.takedowns?.length === 1, JSON.stringify(gd.body));
  const ack = await ncii.addNciiReport({ category: 'self', contentLocation: 'x', description: 'x', consentStatement: true });
  const acked = await call(nciiResolveRoute, { admin: true, body: { id: String(ack.id), action: 'removed', contentGone: true } });
  check("an explicit 'already gone' acknowledgement is recorded", acked.statusCode === 200 && acked.body.report.removalBasis === 'acknowledged', JSON.stringify(acked.body));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
