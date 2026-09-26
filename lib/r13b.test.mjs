// Regression tests for the round-13 backend fixes (package R13B), run against a
// real scratch Postgres (it truncates tables). Only @vercel/blob's head() is
// stubbed. Every fix is tested in both directions (the bug, and its nearest
// harmless neighbours):
//  - media#0: a second quarantine of already-moved evidence keeps the
//    'moved_token' row, so the vacated original path is still swept;
//  - accounts#0: glued minor-suggestive handles/usernames ("naughtyteen",
//    "teenqueen", "teeny", "lolilover", "rapeplay") are refused; real names pass;
//  - accounts#1: social handles are screened in name mode (a real-name
//    Instagram passes), website stays in full mode, and a handle outside the
//    platforms' charset is refused;
//  - accounts#3: name mode's sexual-word slice runs on the allowlist-masked text;
//  - accounts#4: "pay attention", "$9 on here and my insta" are not fee-dodging;
//  - social#0: the admin thread lookup is paged; control characters are
//    refused in DMs and wall comments;
//  - social#1: the report queues are served by an index;
//  - legal-journeys#0: the DM price-change refusal names credits correctly;
//  - dashboard#0: correcting a shipped order's tracking keeps its ship date.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --experimental-test-module-mocks --import ./test-register.mjs lib/r13b.test.mjs

import crypto from 'crypto';
import { mock } from 'node:test';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
delete process.env.NCII_ALERT_WEBHOOK_URL;
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.BRIDGE_SECRET = 'test-bridge-secret-r13b';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r13b';
process.env.SIGNUPS_OPEN = 'true';
process.env.PAYMENTS_LIVE_AT = '2020-01-01T00:00:00.000Z';
if (!process.env.RECORDS_ENCRYPTION_KEY) process.env.RECORDS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
if (!process.env.ORDERS_ENCRYPTION_KEY) process.env.ORDERS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const realBlob = await import('@vercel/blob');
mock.module('@vercel/blob', {
  namedExports: { ...realBlob, head: async () => ({ contentType: 'image/jpeg', size: 1024 }) },
});

const { query, withTransaction, closePool, NCII_PRIORITY_SQL, REPORT_PRIORITY_SQL } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const orders = await import('./orders-store.js');
const wall = await import('./wall-store.js');
const messages = await import('./messages-store.js');
const ncii = await import('./ncii-reports-store.js');
const reportsStore = await import('./reports-store.js');
const preservation = await import('./media-preservation.js');
const { encryptShippingAddress } = await import('./crypto.js');
const { screenPublicText } = await import('./prohibited-terms.js');
const { detectPaymentCircumvention } = await import('./payment-circumvention-filter.js');
const { sanitizeSocials, invalidSocialHandles, sanitizeSocialsKeepingLegacy } = await import('./creator-status.js');
const { lookupConversation } = await import('./content-takedown.js');
const { createSessionToken } = await import('./session.js');
const { default: lookupRoute } = await import('../pages/api/admin/content-lookup.js');
const { default: profileRoute } = await import('../pages/api/me/profile.js');
const { default: wallPostRoute } = await import('../pages/api/wall/post.js');

let pass = 0;
let fail = 0;
const failures = [];
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; failures.push(`${name} ${extra}`); console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);
const orig = { error: console.error, warn: console.warn, info: console.info };
const quiet = async (fn) => {
  console.error = () => {}; console.warn = () => {}; console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, orig); }
};
const errOf = async (fn) => { try { await quiet(fn); return null; } catch (e) { return e; } };
function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    send(b) { this.body = b; this.headersSent = true; return this; },
    end(b) { this.headersSent = true; if (b) { try { this.body = JSON.parse(b); } catch { this.body = b; } } },
  };
}
let ipN = 0;
async function call(route, { method = 'POST', body, query: q = {}, admin = false, user = null } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = {};
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  const cookieJar = {};
  if (user) cookieJar.oa_session = createSessionToken(user.id, user.sessionVersion || 0);
  if (Object.keys(cookieJar).length) headers.cookie = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
  const req = { method, body, query: q, headers, cookies: cookieJar, socket: { remoteAddress: `10.97.${Math.floor(ipN / 250)}.${ipN % 250}` } };
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
  const creator = await creators.createCreator({ name: `C${n}`, handle: `@r13bc${n}`, status: 'active', ...fields });
  const user = await users.createUser({ email: `c${n}@r13b.test`, password: 'password123', role: 'creator', creatorId: creator.id });
  return { creator, user };
}
async function mkFan() {
  n++;
  return users.createUser({ email: `f${n}@r13b.test`, password: 'password123', role: 'fan' });
}
const listingFile = (creatorId, listingId) =>
  media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId, listingId, contentType: 'image/jpeg' }));
const pathOf = (src) => src.replace('/api/media/', '');
async function mkListing(creatorId, fields = {}) {
  const l = await listings.createListing(creatorId, { title: 'Set', priceCents: 500, kind: 'digital', unlimited: true, ...fields });
  return listings.addListingMedia(l.id, { type: 'image', src: listingFile(creatorId, l.id) });
}

// ---------------------------------------------------------------------------
section('media#0: re-preserving moved evidence keeps its vacated path on the sweep list');
{
  await reset();
  const { creator } = await mkCreatorUser();
  const l = await mkListing(creator.id);
  const src = l.media[0].src;
  const p = pathOf(src);
  await query(`insert into media_uploads (pathname, reason) values ($1, 'token')`, [p]);
  await preservation.preserveMedia([src], { reportId: 'ncii:1', reason: 'test' });
  check('the first quarantine drops the token row', !(await query('select 1 from media_uploads where pathname = $1', [p])).rows.length);
  const moved = await preservation.movePreservedToEvidence({ renameFile: async () => {}, headFile: async () => ({}) });
  check('the file moves to evidence/', moved.moved === 1, JSON.stringify(moved));
  const before = (await query('select reason from media_uploads where pathname = $1', [p])).rows;
  check('...leaving a moved_token row for its original path', before.length === 1 && before[0].reason === 'moved_token', JSON.stringify(before));
  // The ban that follows a possible-minor resolve quarantines the same srcs again.
  const again = await preservation.preserveMedia([src], { reportId: 'ncii:2', reason: 'ban' });
  check('the second quarantine still reports the file as preserved', again.includes(p), JSON.stringify(again));
  const after = (await query('select reason from media_uploads where pathname = $1', [p])).rows;
  check('...and the moved_token row survives it (the bug deleted it)', after.length === 1 && after[0].reason === 'moved_token', JSON.stringify(after));
  await query(`update media_uploads set created_at = now() - interval '2 hours' where pathname = $1`, [p]);
  const deleted = [];
  await media.sweepOrphanedMedia({ deleteFile: async (x) => { deleted.push(x); } });
  const evidence = (await query('select evidence_pathname from media_preservations where pathname = $1', [p])).rows[0].evidence_pathname;
  check('a later sweep still claims the vacated original path', deleted.includes(p), JSON.stringify(deleted));
  check('...never the evidence copy', !!evidence && !deleted.includes(evidence));
  // Neighbour: a pending-deletion row on a fresh (unmoved) file is still dropped.
  const l2 = await mkListing(creator.id);
  const p2 = pathOf(l2.media[0].src);
  await query(`insert into media_uploads (pathname, reason) values ($1, 'delete_pending')`, [p2]);
  await preservation.preserveMedia([l2.media[0].src], { reportId: 'ncii:3', reason: 'test' });
  check('a delete_pending row is still taken off the sweep list', !(await query('select 1 from media_uploads where pathname = $1', [p2])).rows.length);
}

// ---------------------------------------------------------------------------
section('accounts#0: glued minor-suggestive handles and usernames are refused');
{
  const refused = ['naughtyteen', 'teenqueen', 'sweetteen', 'kinkyteen', 'teenangel', 'shyteen', 'wetteen', 'freshteen',
    'innocentteen', 'prettyteen', 'bustyteen', 'myteen', 'teenlover', 'teendoll', 'teenprincess', 'teenbody', 'teenkitty',
    'teencutie', 'teeny', 'teenie', 'teenies', 'lolilover', 'loliqueen', 'myloli', 'rapeplay', 'ageplaybabe', 'teenass',
    'TeenQueen', 'Naughty.Teen', 'x_teenqueen_x', 't33nqueen', 'teen_queen'];
  for (const h of refused) {
    check(`handle refused: ${h}`, screenPublicText(h, { context: 'handle' })?.kind === 'prohibited', JSON.stringify(screenPublicText(h, { context: 'handle' })));
    check(`username refused: ${h}`, screenPublicText(h, { context: 'username' })?.kind === 'prohibited');
  }
  const names = ['laurapeters', 'kiaraperez', 'paulolima', 'vincestone', 'steen', 'kirsteen', 'teena', 'teenamarie', 'Teena_Marie',
    'jessteen', 'hotsteen', 'christeen', 'justeen', 'mateen', 'rexteen_fan', 'cuteengineer', 'kirsteenangel', 'christeenqueen',
    'amyteenstra', 'essexrapelje', 'paigeplayford', 'sweetpea', 'queenb', 'angelface', 'princesspeach', 'dollface',
    'cutiepie', 'kittycat', 'myriam', 'rapeseedoil', 'therapist', 'canteenqueen', 'youngblood', 'hotelmodel'];
  for (const h of names) {
    check(`handle passes: ${h}`, !screenPublicText(h, { context: 'handle' }), JSON.stringify(screenPublicText(h, { context: 'handle' })));
    check(`username passes: ${h}`, !screenPublicText(h, { context: 'username' }));
  }
  // The same strings as a tag were already refused; still are.
  check('the tag screen still refuses "naughtyteen"', !!screenPublicText('naughtyteen', { context: 'tag' }));
  check('...and a full-text "teeny bikini" is still refused', !!screenPublicText('new teeny bikini set'));
}

// ---------------------------------------------------------------------------
section('accounts#3: name mode\'s sexual-word slice runs on the masked text');
{
  for (const h of ['kirsteendickson', 'justeencummings', 'kirsteensexton', 'mateenhornyak', 'christeencockburn']) {
    check(`real name passes: ${h}`, !screenPublicText(h, { context: 'handle' }), JSON.stringify(screenPublicText(h, { context: 'handle' })));
  }
  for (const h of ['teenslut', 'pornteen', 'teensex', 'incestporn', 'lolisex']) {
    check(`still refused: ${h}`, screenPublicText(h, { context: 'handle' })?.kind === 'prohibited');
  }
}

// ---------------------------------------------------------------------------
section('accounts#1: social handles are judged like names; the charset is enforced');
{
  for (const key of ['twitter', 'instagram', 'tiktok', 'reddit']) {
    for (const h of ['laurapeters', 'kiaraperez', 'clarapearson', 'marapetrova', 'paulolima', 'vincestone']) {
      check(`${key} passes: ${h}`, !screenPublicText(h, { context: `social_${key}` }), JSON.stringify(screenPublicText(h, { context: `social_${key}` })));
    }
    for (const h of ['naughtyteen', 'hotteen', 'teenslut', 'sexyschoolgirl', 'rape_play']) {
      check(`${key} still refused: ${h}`, screenPublicText(h, { context: `social_${key}` })?.kind === 'prohibited');
    }
  }
  check('the website stays in full mode', screenPublicText('https://example.com/teenpics', { context: 'social_website' })?.kind === 'prohibited');
  const soc = sanitizeSocials({
    instagram: 'https://www.instagram.com/jess.xo/?igsh=abc', tiktok: 'tiktok.com/@jess_xo', reddit: 'reddit.com/u/jess-xo',
    twitter: 'jess xo 🌍',
  });
  check('pasted profile URLs are reduced to the bare handle', soc.instagram === 'jess.xo' && soc.tiktok === 'jess_xo' && soc.reddit === 'jess-xo', JSON.stringify(soc));
  check('...and a handle outside the charset is dropped', !('twitter' in soc), JSON.stringify(soc));
  check('invalidSocialHandles names it', invalidSocialHandles({ twitter: 'cash $jane', instagram: 'jess.xo' }).map((b) => b.key).join() === 'twitter');

  await reset();
  const { user } = await mkCreatorUser();
  const ok = await call(profileRoute, { user, body: { fields: { socials: { instagram: 'clarapearson' } } } });
  check('a real-name Instagram saves (was refused as "rape")', ok.statusCode === 200, JSON.stringify(ok.body));
  check('...with no violation logged', !(await query('select 1 from violations')).rows.length);
  const bad = await call(profileRoute, { user, body: { fields: { socials: { instagram: 'jess xo 555 1234' } } } });
  check('a handle with spaces is a 400 naming the field', bad.statusCode === 400 && bad.body.field === 'social_instagram', JSON.stringify(bad.body));
  const minor = await call(profileRoute, { user, body: { fields: { socials: { instagram: 'naughtyteen' } } } });
  check('a minor-suggestive Instagram is still refused', minor.statusCode === 400, JSON.stringify(minor.body));
  const echo = await call(profileRoute, { user, body: { fields: { socials: { instagram: 'clarapearson' }, bio: 'hello there' } } });
  check('an unchanged echo still saves', echo.statusCode === 200, JSON.stringify(echo.body));

  // A handle stored before the charset rule survives an unrelated save that
  // echoes it back verbatim; changing it is judged by the new rule.
  const keep = sanitizeSocialsKeepingLegacy({ instagram: 'jess xo', twitter: 'new one' }, { instagram: 'jess xo', twitter: 'old one' });
  check('a verbatim legacy echo is kept, a changed invalid one is not', keep.instagram === 'jess xo' && !('twitter' in keep), JSON.stringify(keep));
  const { creator: legacyC, user: legacyU } = await mkCreatorUser();
  await query(`update creators set data = jsonb_set(data, '{socials}', $2::jsonb) where id::text = $1`, [String(legacyC.id), JSON.stringify({ instagram: 'jess xo' })]);
  const legacySave = await call(profileRoute, { user: legacyU, body: { fields: { socials: { instagram: 'jess xo' }, bio: 'an unrelated edit here' } } });
  const after = await creators.getCreatorById(legacyC.id);
  check('an unrelated save keeps the stored legacy handle', legacySave.statusCode === 200 && after?.socials?.instagram === 'jess xo',
    `${legacySave.statusCode} ${JSON.stringify(after?.socials)}`);
}

// ---------------------------------------------------------------------------
section('accounts#4: the bridge cue stops at idioms, "here" and a new clause');
{
  for (const t of ['Pay attention to my insta stories', 'pay my rent then post on insta', 'prices from $9 on here and my insta has previews',
    'Sets from $9 on here and my insta has free previews', 'cheaper here and my snap has previews']) {
    check(`passes: ${t}`, !detectPaymentCircumvention(t).flagged, JSON.stringify(detectPaymentCircumvention(t).reasons));
  }
  for (const t of ['pay me on insta', 'cheaper on my snap', 'payment via whatsapp', '$20 on snap', 'cheaper prices on my snap',
    'payment accepted through my telegram', 'customs are cheaper if you message me on telegram', 'cheaper over there on snap',
    'pay for customs on my snap',
    // a joiner followed directly by the app, or by only a contact tail, is still an instruction
    '$20 and snap', 'pay 20 and snap me', '$25 and kik me', 'send $20 and I send on snap', '$20 then telegram',
    '$20, then telegram', 'pay me then snap', 'pay then telegram me', '$30 so telegram', '$20 while on snap',
    'pay me here telegram', 'pay and then snap', 'pay 20 and hit me on snap', '$20 and hit my snap']) {
    check(`still refused: ${t}`, detectPaymentCircumvention(t).flagged);
  }
}

// ---------------------------------------------------------------------------
section('social#0: the thread lookup is paged; control characters are refused');
{
  await reset();
  const all = [];
  for (let i = 1; i <= 250; i++) all.push({ id: `m${i}`, senderId: '1', text: `msg ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
  await query('insert into conversations (id, data) values ($1, $2)', ['conv-r13', { id: 'conv-r13', participantIds: ['1', '2'], messages: all, senders: [] }]);
  const p1 = await lookupConversation({ conversationId: 'conv-r13' });
  check('page one is the newest 100, oldest first', p1.messages.length === 100 && p1.messages[0].id === 'm151' && p1.messages[99].id === 'm250', `${p1.messages.length} ${p1.messages[0]?.id}`);
  check('...with the total and a cursor', p1.messageCount === 250 && p1.hasMore === true && p1.nextBefore === 'm151');
  const p2 = await lookupConversation({ conversationId: 'conv-r13', before: p1.nextBefore });
  const p3 = await lookupConversation({ conversationId: 'conv-r13', before: p2.nextBefore });
  check('paging back reaches the start with no overlap', p2.messages[0].id === 'm51' && p3.messages.length === 50 && p3.messages[0].id === 'm1'
    && p3.hasMore === false && p3.nextBefore === null, `${p2.messages[0]?.id} ${p3.messages.length}`);
  const small = await lookupConversation({ conversationId: 'conv-r13', limit: '5000' });
  check('a limit past 100 is clamped', small.messages.length === 100);
  const unknown = await lookupConversation({ conversationId: 'conv-r13', before: 'nope' });
  check('an unknown cursor is an empty page', unknown.messages.length === 0 && unknown.hasMore === false);
  const r = await call(lookupRoute, { method: 'GET', admin: true, query: { kind: 'messages', conversationId: 'conv-r13', before: 'm11', limit: '5' } });
  check('the route passes before/limit through', r.statusCode === 200 && r.body.conversation.messages.map((m) => m.id).join() === 'm6,m7,m8,m9,m10'
    && r.body.conversation.nextBefore === 'm6', JSON.stringify(r.body).slice(0, 200));

  const { creator, user: cu } = await mkCreatorUser({ dmPriceCents: 500 });
  const fan = await mkFan();
  const ctl = await errOf(() => messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hi\u0001\u0001 there', expectedPriceCents: 500 }));
  check('a DM with a control character is refused as malformed', ctl?.code === messages.DM_ERRORS.MALFORMED, ctl?.code);
  const ctl2 = await errOf(() => messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hi\u0085', expectedPriceCents: 500 }));
  check('...a C1 control too', ctl2?.code === messages.DM_ERRORS.MALFORMED, ctl2?.code);
  const wallErr = await errOf(() => wall.addWallPost({ creatorId: String(creator.id), authorId: String(fan.id), authorName: 'F', text: 'x\u0007y' }));
  check('the wall store refuses a control character', wallErr?.code === 'WALL_CONTROL_CHARS', wallErr?.code);
  const wr = await call(wallPostRoute, { user: fan, body: { creatorId: String(creator.id), text: 'nice\u0002' } });
  check('...and the wall route answers 400', wr.statusCode === 400, JSON.stringify(wr.body));
  const okWall = await call(wallPostRoute, { user: fan, body: { creatorId: String(creator.id), text: 'line one\nline two\ttabbed' } });
  check('a newline and a tab still post', okWall.statusCode === 200, JSON.stringify(okWall.body));

  // legal-journeys#0: the price-change refusal names the price correctly.
  const pc = await errOf(() => messages.sendDirectMessage({ sender: fan, recipientId: cu.id, text: 'hello', expectedPriceCents: 99 }));
  check('legal-journeys#0: price change is refused', pc?.code === messages.DM_ERRORS.PRICE_CHANGED && pc.currentPriceCents === 500, pc?.code);
  check('...and says 5 credits ($5.00), not 500 credits', /5 credits \(\$5\.00\)/.test(pc?.message || '') && !/500 credits/.test(pc?.message || ''), pc?.message);
}

// ---------------------------------------------------------------------------
section('social#1: the report queues are served by an index');
{
  await reset();
  const idx = (await query(`select indexname, indexdef from pg_indexes where indexname in ('ncii_reports_queue_idx', 'reports_queue_idx')`)).rows;
  check('both queue indexes exist', idx.length === 2, JSON.stringify(idx));
  const plan = async (sql, params) => withTransaction(async (c) => {
    await c.query('set local enable_seqscan = off');
    await c.query('set local enable_bitmapscan = off');
    const { rows } = await c.query(`explain ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
  const nPlan = await plan(
    `select id, data from ncii_reports where data->>'status' = $1 and (${NCII_PRIORITY_SQL}, id) > ($2::int, $3::bigint) order by ${NCII_PRIORITY_SQL}, id limit 26`,
    ['open', 0, '5'],
  );
  check('the NCII page uses ncii_reports_queue_idx (the expression matches)', /ncii_reports_queue_idx/.test(nPlan) && !/Sort/.test(nPlan), nPlan);
  const sPlan = await plan(`select count(*) from ncii_reports where data->>'status' = 'open'`, []);
  check('...and so does the badge count', /ncii_reports_queue_idx/.test(sPlan), sPlan);
  const rPlan = await plan(
    `select id, data from reports where data->>'status' = $1 order by ${REPORT_PRIORITY_SQL}, id desc limit 51`,
    ['open'],
  );
  check('the REPORTS page uses reports_queue_idx', /reports_queue_idx/.test(rPlan) && !/Sort/.test(rPlan), rPlan);
  // Neighbour: the stores' paged queries still answer correctly.
  await ncii.addNciiReport({ category: 'third_party', contentLocation: 'a', description: 'x', goodFaithStatement: true });
  const minor = await ncii.addNciiReport({ category: 'minor', contentLocation: 'b', description: 'x', goodFaithStatement: true });
  const page = await ncii.getNciiReportsPage({ status: 'open' });
  check('the NCII page still orders possible-minor first', String(page.reports[0].id) === String(minor.id) && page.reports.length === 2);
  const rp = await reportsStore.getReportsPage({ status: 'open' });
  check('the REPORTS page still answers', Array.isArray(rp.reports));
}

// ---------------------------------------------------------------------------
section('dashboard#0: correcting a shipped order\'s tracking keeps its ship date');
{
  await reset();
  const addr = encryptShippingAddress({ fullName: 'A B', line1: '1 Main St', city: 'X', postalCode: '1', country: 'US' });
  const o = String((await query('insert into orders (data) values ($1::jsonb) returning id',
    [JSON.stringify({ creatorId: '7', buyerId: 'b1', kind: 'physical', status: 'pending_shipment', shippingAddress: addr })])).rows[0].id);
  const first = await orders.markOrderShipped(o, '7', { carrier: 'UPS', trackingNumber: 'WRONG1' });
  check('the first ship stamps shippedAt and no correction time', !!first.shippedAt && !first.trackingUpdatedAt, JSON.stringify(first));
  await query(`update orders set data = data || '{"shippedAt": "2026-01-02T03:04:05.000Z"}'::jsonb where id = $1`, [o]);
  const fixed = await orders.markOrderShipped(o, '7', { carrier: 'USPS', trackingNumber: 'RIGHT1' });
  check('the correction stores the new carrier and tracking', fixed.carrier === 'USPS' && fixed.trackingNumber === 'RIGHT1' && fixed.status === 'shipped');
  check('...keeps the original ship date', fixed.shippedAt === '2026-01-02T03:04:05.000Z', fixed.shippedAt);
  check('...and stamps trackingUpdatedAt', typeof fixed.trackingUpdatedAt === 'string' && fixed.trackingUpdatedAt > fixed.shippedAt, fixed.trackingUpdatedAt);
  const buyerView = (await orders.getOrdersForBuyer('b1'))[0];
  check('the buyer sees the corrected tracking and when it changed', buyerView.trackingNumber === 'RIGHT1' && !!buyerView.trackingUpdatedAt
    && buyerView.shippedAt === '2026-01-02T03:04:05.000Z', JSON.stringify(buyerView));
  const other = await errOf(() => orders.markOrderShipped(o, '8', { carrier: 'UPS', trackingNumber: 'T' }));
  check('another creator still cannot touch it', other?.message === 'Order not found');
}

void withTransaction;
for (const f of failures) console.log('  FAILED:', f);
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
await closePool();
process.exit(fail ? 1 : 0);
