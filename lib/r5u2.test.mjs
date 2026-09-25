// Regression tests for the round-5 admin/copy package (R5U2), run against a
// real scratch Postgres (it truncates tables), never mocks:
//  - legal-journeys#2: self-service account deletion is refused while a
//    physical order hasn't shipped (Privacy section 7), in the route AND in
//    the store's transaction, and the confirmation step names how many
//    digital purchases would become unviewable;
//  - admin-ui#0: a gallery item or profile photo removed "for" a TAKE IT DOWN
//    request filed as a POSSIBLE MINOR is quarantined as evidence even when
//    the admin only attributed the removal (nciiReportId) rather than asking
//    for preservation;
//  - admin-ui#3: a misconfigured PAYOUT_SENDER_ADDRESS answers 503
//    chain_check_unavailable (the panel offers its explicit skip on that code)
//    and records nothing.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r5u2.test.mjs

import crypto from 'crypto';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
delete process.env.NCII_ALERT_WEBHOOK_URL;
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.BRIDGE_SECRET = 'test-bridge-secret-r5u2';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r5u2';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { query, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const ncii = await import('./ncii-reports-store.js');
const credits = await import('./credits-store.js');
const { createSessionToken } = await import('./session.js');
const { default: deleteAccountRoute } = await import('../pages/api/auth/delete-account.js');
const { default: galleryDeleteRoute } = await import('../pages/api/admin/gallery-delete.js');
const { default: avatarRoute } = await import('../pages/api/admin/avatar.js');
const { default: markPaidRoute } = await import('../pages/api/admin/payouts-mark-paid.js');
const { default: contentTakedownRoute } = await import('../pages/api/admin/content-takedown.js');
const { default: nciiResolveRoute } = await import('../pages/api/admin/ncii-reports-resolve.js');

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
  const headers = { 'x-forwarded-for': `10.56.${Math.floor(ipN / 250)}.${ipN % 250}` };
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
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r5u2.test`, password: 'password123', role: 'fan' });
}
async function order(buyerId, { listingId, kind, status }) {
  const { rows } = await query('insert into orders (data) values ($1) returning id', [{
    listingId: String(listingId), creatorId: '1', buyerId: String(buyerId), kind, status, createdAt: new Date().toISOString(),
  }]);
  return String(rows[0].id);
}
const galleryFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'gallery', creatorId, contentType: 'image/jpeg' }));
const avatarFile = (creatorId) => media.mediaSrc(media.newMediaPathname({ purpose: 'avatar', creatorId, contentType: 'image/jpeg' }));
const strip = (src) => src.replace('/api/media/', '');

// ---------------------------------------------------------------------------
await reset();

section('legal-journeys#2: self-deletion vs unshipped orders and digital purchases');
{
  const fan = await mkFan();
  const shipId = await order(fan.id, { listingId: 1, kind: 'physical', status: 'pending_shipment' });
  await order(fan.id, { listingId: 2, kind: 'digital', status: 'fulfilled' });
  await order(fan.id, { listingId: 2, kind: 'digital', status: 'fulfilled' }); // same item twice counts once
  await order(fan.id, { listingId: 3, kind: 'digital', status: 'delivered' });
  await order(fan.id, { listingId: 4, kind: 'digital', status: 'refunded' }); // not viewable anyway

  const impact = await users.getSelfDeleteImpact(fan.id);
  check('impact counts unshipped orders and distinct viewable purchases', impact.unshippedOrders === 1 && impact.digitalPurchases === 2, JSON.stringify(impact));

  const refused = await call(deleteAccountRoute, { user: fan, body: { password: 'password123', acknowledgeForfeit: true } });
  check('the route refuses while an order has not shipped, even acknowledged',
    refused.statusCode === 409 && refused.body.code === 'unshipped_orders' && refused.body.unshippedOrders === 1 && /hasn't shipped/.test(refused.body.error),
    JSON.stringify(refused.body));
  check('...nothing was deleted', !!(await users.findUserById(fan.id)));

  let threw = null;
  try { await users.deleteFanAccount(fan.id, { selfService: true }); } catch (e) { threw = e; }
  check('...enforced inside the store transaction too', threw?.code === users.ACCOUNT_UNSHIPPED_ORDERS && threw.obligations?.unshippedOrders === 1, String(threw?.code));

  await query(`update orders set data = data || '{"status":"shipped"}'::jsonb where id = $1`, [shipId]);
  const ask = await call(deleteAccountRoute, { user: fan, body: { password: 'password123' } });
  check('once shipped, deletion asks to confirm the lost purchases',
    ask.statusCode === 409 && ask.body.code === 'BALANCE_FORFEIT' && ask.body.digitalPurchases === 2 && ask.body.balanceCents === 0 && /2 digital items/.test(ask.body.error),
    JSON.stringify(ask.body));
  check('...and still has not deleted anything', !!(await users.findUserById(fan.id)));
  const ok = await call(deleteAccountRoute, { user: fan, body: { password: 'password123', acknowledgeForfeit: true, expectedForfeitCents: 0, expectedDigitalPurchases: 2 } });
  check('confirmed, the account is deleted', ok.statusCode === 200 && !(await users.findUserById(fan.id)), JSON.stringify(ok.body));

  const rich = await mkFan();
  await credits.creditAccount({ userId: rich.id, cents: 901, type: 'test' });
  const both = await call(deleteAccountRoute, { user: rich, body: { password: 'password123' } });
  check('a balance alone still needs the acknowledgement (credits, not cents, in the message)',
    both.statusCode === 409 && both.body.code === 'BALANCE_FORFEIT' && both.body.balanceCents === 901 && both.body.digitalPurchases === 0 && /9\.01 credits/.test(both.body.error),
    JSON.stringify(both.body));

  const plain = await mkFan();
  const direct = await call(deleteAccountRoute, { user: plain, body: { password: 'password123' } });
  check('nothing to lose: deleted without a confirmation step', direct.statusCode === 200, JSON.stringify(direct.body));

  // The admin path (strict + force) is unaffected by the self-service rule.
  const shipper = await mkFan();
  await order(shipper.id, { listingId: 5, kind: 'physical', status: 'pending_shipment' });
  const adminDel = await users.deleteFanAccount(shipper.id, { strict: true, force: true });
  check('the admin path can still delete with force', adminDel?.deletedUserId === String(shipper.id));
}

section('admin-ui#0: removals attributed to a POSSIBLE MINOR request are quarantined');
{
  await reset();
  const creator = await creators.createCreator({ name: 'G', handle: '@r5u2g', status: 'active' });
  const g1 = galleryFile(creator.id);
  const g2 = galleryFile(creator.id);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g1 }, []);
  await creators.addGalleryItem(creator.id, { type: 'image', src: g2 }, []);
  const minor = await ncii.addNciiReport({ category: 'minor', contentLocation: 'profile', description: 'x', goodFaithStatement: true });
  const self = await ncii.addNciiReport({ category: 'self', contentLocation: 'profile', description: 'x', consentStatement: true });

  const gd = await call(galleryDeleteRoute, { admin: true, body: { creatorId: String(creator.id), src: g1, nciiReportId: String(minor.id) } });
  const pres = (await query('select report_id from media_preservations where pathname = $1', [strip(g1)])).rows[0];
  check('gallery: attributed to a minor request -> quarantined', gd.statusCode === 200 && gd.body.preserved === true && pres?.report_id === `ncii:${minor.id}`, JSON.stringify([gd.body, pres]));
  const stored = (await query('select data from ncii_reports where id = $1', [minor.id])).rows[0].data;
  check('...and recorded on the request', stored.takedowns?.length === 1 && stored.takedowns[0].preserved === 1, JSON.stringify(stored.takedowns));

  const gd2 = await call(galleryDeleteRoute, { admin: true, body: { creatorId: String(creator.id), src: g2, nciiReportId: String(self.id) } });
  const pres2 = (await query('select 1 from media_preservations where pathname = $1', [strip(g2)])).rows;
  check('gallery: attributed to an ordinary request -> deleted, not quarantined', gd2.statusCode === 200 && gd2.body.preserved === false && !pres2.length, JSON.stringify(gd2.body));

  const unknown = await call(galleryDeleteRoute, { admin: true, body: { creatorId: String(creator.id), src: g2, nciiReportId: '9999' } });
  check('gallery: an unknown request removes nothing (404)', unknown.statusCode === 404);

  const av = avatarFile(creator.id);
  await query(`update creators set data = data || jsonb_build_object('img', $2::text) where id = $1`, [String(creator.id), av]);
  const ar = await call(avatarRoute, { admin: true, body: { creatorId: String(creator.id), remove: true, nciiReportId: String(minor.id) } });
  const apres = (await query('select report_id from media_preservations where pathname = $1', [strip(av)])).rows[0];
  check('avatar: attributed to a minor request -> quarantined', ar.statusCode === 200 && ar.body.preserved === true && apres?.report_id === `ncii:${minor.id}`, JSON.stringify([ar.body, apres]));
}

section('admin-ui#0: only a takedown that removed something lets a request be resolved as removed');
{
  await reset();
  const req = await ncii.addNciiReport({ category: 'self', contentLocation: 'listing 999', description: 'x', consentStatement: true });
  // A mistyped listing id: nothing is found, and that is what gets recorded.
  const miss = await call(contentTakedownRoute, { admin: true, body: { type: 'listing', listingId: '999', nciiReportId: String(req.id) } });
  check('takedown of a nonexistent listing records already_gone', miss.statusCode === 200 && miss.body.result === 'already_gone', JSON.stringify(miss.body));
  const refused = await call(nciiResolveRoute, { admin: true, body: { id: String(req.id), action: 'removed' } });
  check('...and does NOT let the request be resolved as removed (409 takedown_required)',
    refused.statusCode === 409 && refused.body.code === 'takedown_required', JSON.stringify(refused.body));
  check('...the request stays open', (await query(`select data->>'status' as s from ncii_reports where id = $1`, [req.id])).rows[0].s === 'open');
  const acked = await call(nciiResolveRoute, { admin: true, body: { id: String(req.id), action: 'removed', contentGone: true } });
  check('an explicit "already gone" acknowledgement resolves it, basis acknowledged',
    acked.statusCode === 200 && acked.body.report?.removalBasis === 'acknowledged', JSON.stringify(acked.body));
}

section('admin-ui#0: an attributed avatar removal is recorded inside its own transaction');
{
  await reset();
  const creator = await creators.createCreator({ name: 'Av', handle: 'av_r5u2', status: 'active' });
  const req = await ncii.addNciiReport({ category: 'self', contentLocation: 'profile photo', description: 'x', consentStatement: true });
  // A seed /images photo taken off display counts as removed (no file to delete).
  await query(`update creators set data = data || jsonb_build_object('img', '/images/demo_female_1.jpg') where id = $1`, [String(creator.id)]);
  const ar = await call(avatarRoute, { admin: true, body: { creatorId: String(creator.id), remove: true, nciiReportId: String(req.id) } });
  const stored = (await query('select data from ncii_reports where id = $1', [req.id])).rows[0].data;
  check('a seed photo taken off display is recorded as removed',
    ar.statusCode === 200 && stored.takedowns?.length === 1 && stored.takedowns[0].result === 'removed' && stored.takedowns[0].target?.src === '/images/demo_female_1.jpg',
    JSON.stringify([ar.body, stored.takedowns]));
  const again = await call(avatarRoute, { admin: true, body: { creatorId: String(creator.id), remove: true, nciiReportId: String(req.id) } });
  const stored2 = (await query('select data from ncii_reports where id = $1', [req.id])).rows[0].data;
  check('removing the placeholder again records already_gone', again.statusCode === 200 && stored2.takedowns?.[1]?.result === 'already_gone', JSON.stringify(stored2.takedowns));

  // The record fails inside the transaction (the request vanishes between the
  // route's existence check and the removal): the photo must stay.
  const av = avatarFile(creator.id);
  await query(`update creators set data = data || jsonb_build_object('img', $2::text) where id = $1`, [String(creator.id), av]);
  const doomed = await ncii.addNciiReport({ category: 'self', contentLocation: 'profile photo', description: 'x', consentStatement: true });
  // setCreatorAvatar's beforeChange is where the route records; a request
  // that vanishes inside it makes the record throw, which must roll the
  // removal back with it.
  const gone = await quiet(() => creators.setCreatorAvatar(String(creator.id), '/images/avatar-placeholder.png', {
    beforeChange: async (client) => {
      await client.query('delete from ncii_reports where id = $1', [String(doomed.id)]);
      await ncii.recordNciiTakedown(String(doomed.id), { type: 'avatar', target: {}, result: 'removed' }, client);
    },
  })).then(() => null, (e) => e);
  const img = (await query(`select data->>'img' as img from creators where id = $1`, [String(creator.id)])).rows[0].img;
  check('a failed record rolls the removal back: the photo is still there', gone?.code === ncii.NCII_REPORT_NOT_FOUND && img === av, JSON.stringify([gone?.code, img]));
}

section('admin-ui#3: a misconfigured payout sender is a distinct 503 code, not a bare 500');
{
  await reset();
  const fan = await mkFan();
  const { rows } = await query(
    `insert into payout_requests (user_id, amount_cents, payout_wallet) values ($1, 500, $2) returning id`,
    [String(fan.id), '0x' + 'a'.repeat(40)],
  );
  const id = String(rows[0].id);
  const hash = '0x' + 'b'.repeat(64);
  process.env.PAYOUT_SENDER_ADDRESS = '0x' + 'c'.repeat(41);
  const res = await call(markPaidRoute, { admin: true, body: { id, txHash: hash } });
  check('invalid PAYOUT_SENDER_ADDRESS -> 503 chain_check_unavailable', res.statusCode === 503 && res.body.code === 'chain_check_unavailable', JSON.stringify(res.body));
  check('...and nothing was recorded', (await query('select status from payout_requests where id = $1', [id])).rows[0].status === 'pending');
  delete process.env.PAYOUT_SENDER_ADDRESS;
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
