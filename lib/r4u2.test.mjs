// Regression tests for the round-4 admin fixes (package R4U2), run against the
// REAL route handlers and a real scratch Postgres (it truncates tables),
// never mocks:
//  - admin-ui#0: the creator editor carries tags, location and age, so an
//    approval refused over a stored tag can be fixed from the panel (clear
//    the tag, save again), and an under-18 age is refused before sending;
//  - admin-ui#1: dismissing a takedown request needs a reason (stored, with
//    history), and a dismissed request can be reopened -- but never an open
//    or a 'removed' one;
//  - admin-ui#5 / legal-journeys#1: /api/admin/creators maps each creator to
//    its login account, and an admin-created model has none;
//  - legal-journeys#4: the admin account deletion refuses while a credit
//    balance or an unshipped order exists, lists them, and deletes with force.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r4u2.test.mjs

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
delete process.env.NCII_ALERT_WEBHOOK_URL;
process.env.BRIDGE_SECRET = 'test-bridge-secret-r4u2';
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r4u2';

const { query, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const users = await import('./users-store.js');
const credits = await import('./credits-store.js');
const ncii = await import('./ncii-reports-store.js');
const { draftFrom, fieldsFromDraft, rebaseDraft } = await import('../components/admin/creatorDraft.js');
const { default: profileRoute } = await import('../pages/api/admin/profile.js');
const { default: creatorsRoute } = await import('../pages/api/admin/creators.js');
const { default: createRoute } = await import('../pages/api/admin/create.js');
const { default: nciiResolveRoute } = await import('../pages/api/admin/ncii-reports-resolve.js');
const { default: deleteUserRoute } = await import('../pages/api/admin/delete-user.js');

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
    statusCode: 200, headers: {}, body: null, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; },
  };
}
let ipN = 0;
async function call(route, { method = 'POST', body, query: q = {} } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = { 'x-forwarded-for': `10.45.0.${ipN}`, 'x-admin-key': process.env.ADMIN_UPLOAD_KEY };
  await quiet(() => route({ method, body, query: q, headers, socket: { remoteAddress: `10.45.0.${ipN}` } }, res));
  return res;
}

async function reset() {
  await query(`truncate creators, users, listings, orders, credit_balances, credit_ledger, payout_requests,
    ncii_reports, performer_records, violations, server_standing_pushes, wall_posts, favorites, notifications,
    conversations restart identity`);
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
async function addRecord(creatorId) {
  await query('insert into performer_records (data) values ($1)', [{ creatorId: String(creatorId), status: 'active', aliases: [], documentLocation: 'offline' }]);
}
/** One press of Save in the panel: rebase onto the stored record, send only the diff. */
async function savePanel(creatorId, draft, baseline) {
  const current = await creators.getCreatorById(creatorId);
  const rebased = rebaseDraft(draft, baseline, current);
  if (rebased.conflicts.length) return { conflicts: rebased.conflicts };
  const built = fieldsFromDraft(rebased.draft, rebased.baseline);
  if (built.error) return { error: built.error };
  const res = await call(profileRoute, { body: { creatorId, fields: built.fields } });
  return { res, fields: built.fields };
}

try {
  await reset();

  section('admin-ui#0: tags, location and age are editable from the panel');
  {
    const c = await creators.createCreator({
      name: 'Jane', handle: '@janer4u2', bio: 'bio', status: 'pending', tags: ['cashapp', 'janedoe99'], location: 'Austin',
    });
    await addRecord(c.id);
    const base = draftFrom(c);
    check('the draft carries the stored tags', base.tags === 'cashapp, janedoe99', base.tags);
    check('the draft carries location and a blank age', base.location === 'Austin' && base.age === '');

    // Approval re-screens the stored tags and refuses them.
    let out = await savePanel(c.id, { ...base, status: 'active' }, base);
    check('approval with the stored bad tags is refused', out.res.statusCode === 400 && /Tags field/.test(out.res.body?.error || ''), JSON.stringify(out.res.body));
    check('nothing was saved', (await creators.getCreatorById(c.id)).status === 'pending');

    // The panel can now do what the message says: clear the tags and save.
    out = await savePanel(c.id, { ...base, tags: 'cosplay', status: 'active' }, base);
    check('clearing the bad tags lets the approval through', out.res.statusCode === 200, JSON.stringify(out.res.body));
    const after = await creators.getCreatorById(c.id);
    check('the new tags are stored', JSON.stringify(after.tags) === JSON.stringify(['cosplay']));
    check('the creator is live', after.status === 'active');

    // Location and age edits, and the under-18 refusal before anything is sent.
    const d2 = draftFrom(after);
    check('an under-18 age is refused client-side', /under 18/.test(fieldsFromDraft({ ...d2, age: '17' }, d2).error || ''));
    check('a non-number age is refused client-side', !!fieldsFromDraft({ ...d2, age: 'twenty' }, d2).error);
    out = await savePanel(c.id, { ...d2, age: '25', location: 'Dallas' }, d2);
    check('age and location save', out.res.statusCode === 200 && out.fields.age === '25' && out.fields.location === 'Dallas', JSON.stringify(out));
    const saved = await creators.getCreatorById(c.id);
    check('age stored as 25, location Dallas', saved.age === 25 && saved.location === 'Dallas', JSON.stringify([saved.age, saved.location]));
    // The server also refuses an under-18 age sent directly.
    const direct = await call(profileRoute, { body: { creatorId: c.id, fields: { age: '16' } } });
    check('the server refuses an under-18 age', direct.statusCode === 400);

    // Rebase compares tags as a list: re-spacing is not a change or conflict.
    const d3 = draftFrom(saved);
    check('re-spacing tags is not a change', !Object.keys(fieldsFromDraft({ ...d3, tags: 'cosplay ' }, d3).fields).includes('tags'));
    await creators.updateCreatorProfile(c.id, { tags: ['cosplay', 'gym'] });
    const reb = rebaseDraft({ ...d3, tags: 'lingerie' }, d3, await creators.getCreatorById(c.id));
    check('a tag edit racing a creator edit is a conflict', reb.conflicts.includes('tags'), JSON.stringify(reb.conflicts));
    const clear = fieldsFromDraft({ ...d3, age: '' }, { ...d3, age: '25' });
    check('clearing age sends a blank (stored as none)', clear.fields.age === '');
  }

  section('admin-ui#1: a takedown dismissal needs a reason, and can be reopened');
  {
    const r = await ncii.addNciiReport({ reporterName: 'V', reporterContact: 'v@x.test', contentLocation: '/creator/1', category: 'minor', goodFaithStatement: true });
    let res = await call(nciiResolveRoute, { body: { id: r.id, action: 'dismiss' } });
    check('dismiss without a reason is refused', res.statusCode === 400 && res.body?.code === 'reason_required', JSON.stringify(res.body));
    res = await call(nciiResolveRoute, { body: { id: r.id, action: 'dismiss', reason: '   ' } });
    check('a blank reason is refused', res.statusCode === 400);
    let threw = null;
    try { await ncii.resolveNciiReport(r.id, 'dismiss'); } catch (e) { threw = e; }
    check('the store refuses a reasonless dismissal too', threw?.code === ncii.NCII_REASON_REQUIRED);
    check('the report is still open', (await ncii.getOpenNciiSummary()).open === 1);

    res = await call(nciiResolveRoute, { body: { id: r.id, action: 'dismiss', reason: 'Checked: adult performer with record #3' } });
    check('dismiss with a reason succeeds', res.statusCode === 200, JSON.stringify(res.body));
    check('the reason is stored', res.body?.report?.dismissReason === 'Checked: adult performer with record #3');
    check('the dismissal is in the history', Array.isArray(res.body?.report?.history) && res.body.report.history[0]?.action === 'dismiss');
    check('it left the open queue', (await ncii.getOpenNciiSummary()).open === 0);

    res = await call(nciiResolveRoute, { body: { id: r.id, action: 'reopen' } });
    check('reopen without a reason is refused', res.statusCode === 400);
    res = await call(nciiResolveRoute, { body: { id: r.id, action: 'reopen', reason: 'Misclick' } });
    check('reopen succeeds', res.statusCode === 200 && res.body?.report?.status === 'open', JSON.stringify(res.body));
    check('reopen keeps the history and the earlier reason', res.body.report.history.length === 2
      && res.body.report.history[1].action === 'reopened'
      && res.body.report.history[1].previousReason === 'Checked: adult performer with record #3');
    check('the old dismissal reason is no longer the current one', !res.body.report.dismissReason);
    check('it is back in the open queue', (await ncii.getOpenNciiSummary()).open === 1);
    check('the 48h clock still counts from the filing', res.body.report.createdAt === r.createdAt);

    res = await call(nciiResolveRoute, { body: { id: r.id, action: 'reopen', reason: 'again' } });
    check('an open request cannot be reopened', res.statusCode === 409 && res.body?.code === 'not_reopenable');

    // Since R5B 'removed' needs the removal on file: here the admin confirms the
    // content is already gone.
    res = await call(nciiResolveRoute, { body: { id: r.id, action: 'removed', contentGone: true } });
    check('a removal needs no reason', res.statusCode === 200, JSON.stringify(res.body));
    res = await call(nciiResolveRoute, { body: { id: r.id, action: 'reopen', reason: 'undo' } });
    check("a 'removed' request cannot be reopened", res.statusCode === 409);
    res = await call(nciiResolveRoute, { body: { id: '999999', action: 'reopen', reason: 'x' } });
    check('reopening a missing report is 404', res.statusCode === 404);

    // Two concurrent reopens: exactly one wins.
    const r2 = await ncii.addNciiReport({ reporterName: 'W', reporterContact: 'w@x.test', contentLocation: 'x' });
    await ncii.resolveNciiReport(r2.id, 'dismiss', { reason: 'spam' });
    const both = await Promise.allSettled([
      ncii.reopenNciiReport(r2.id, { reason: 'a' }),
      ncii.reopenNciiReport(r2.id, { reason: 'b' }),
    ]);
    check('concurrent reopens: exactly one succeeds', both.filter((x) => x.status === 'fulfilled').length === 1);
  }

  section('admin-ui#5 / legal-journeys#1: creators carry their login account (admin-only)');
  {
    const signed = await creators.createCreator({ name: 'Signed', handle: '@signedr4u2', status: 'pending' });
    const user = await users.createUser({ email: 'applicant@r4u2.test', password: 'password123', role: 'creator', creatorId: signed.id });
    const made = await call(createRoute, { body: {} });
    check('+ Add Model still works', made.statusCode === 200 && made.body?.creator?.id);
    const res = await call(creatorsRoute, { method: 'GET' });
    check('the roster loads', res.statusCode === 200 && Array.isArray(res.body?.creators));
    const acct = res.body.accounts?.[String(signed.id)];
    check('a signed-up creator shows its login and user id', acct?.login === 'applicant@r4u2.test' && acct?.userId === String(user.id), JSON.stringify(acct));
    check('an admin-created model has no login', !res.body.accounts?.[String(made.body.creator.id)]);
    check('the creator records themselves carry no login', !JSON.stringify(res.body.creators).includes('applicant@r4u2.test'));
    const anon = fakeRes();
    await quiet(() => creatorsRoute({ method: 'GET', headers: {}, query: {}, socket: { remoteAddress: '10.45.1.1' } }, anon));
    check('without the admin key nothing is returned', anon.statusCode === 401 || anon.statusCode === 403, String(anon.statusCode));
  }

  section('legal-journeys#4: admin deletion of a fan account');
  {
    const fan = await users.createUser({ email: 'fan1@r4u2.test', password: 'password123', role: 'fan' });
    await credits.creditAccount({ userId: fan.id, cents: 500, type: 'deposit' });
    let res = await call(deleteUserRoute, { body: { userId: fan.id } });
    check('a deposited balance is refused without force', res.statusCode === 409 && res.body?.obligations?.balanceCents === 500, JSON.stringify(res.body));
    check('the account still exists', !!(await users.findUserById(fan.id)));
    res = await call(deleteUserRoute, { body: { userId: fan.id, force: true } });
    check('force deletes it and reports the forfeit', res.statusCode === 200 && res.body.forfeitedCents === 500, JSON.stringify(res.body));
    check('the login is gone', !(await users.findUserById(fan.id)));
    const { rows: ledger } = await query(`select count(*)::int as n from credit_ledger where user_id = $1`, [String(fan.id)]);
    check('the credit ledger is kept', ledger[0].n >= 2);

    const fan2 = await users.createUser({ email: 'fan2@r4u2.test', password: 'password123', role: 'fan' });
    await query('insert into orders (data) values ($1)', [{ listingId: '1', creatorId: '1', buyerId: String(fan2.id), kind: 'physical', status: 'pending_shipment', createdAt: new Date().toISOString() }]);
    res = await call(deleteUserRoute, { body: { userId: fan2.id } });
    check('an unshipped order is refused without force', res.statusCode === 409 && res.body?.obligations?.unshippedOrders === 1, JSON.stringify(res.body));

    const fan3 = await users.createUser({ email: 'fan3@r4u2.test', password: 'password123', role: 'fan' });
    res = await call(deleteUserRoute, { body: { userId: fan3.id } });
    check('a fan with nothing attached is deleted straight away', res.statusCode === 200);

    // The self-service path is unchanged: it asks the person about the balance itself.
    const fan4 = await users.createUser({ email: 'fan4@r4u2.test', password: 'password123', role: 'fan' });
    await credits.creditAccount({ userId: fan4.id, cents: 100, type: 'deposit' });
    const self = await users.deleteFanAccount(fan4.id);
    check('non-strict deletion still forfeits a deposited balance', self?.forfeitedCents === 100);
  }
} catch (err) {
  fail++;
  console.log('  FAIL (threw)', err);
} finally {
  await closePool();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
