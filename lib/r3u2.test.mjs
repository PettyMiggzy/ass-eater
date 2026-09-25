// Regression tests for the round-3 UI+copy package (R3U2), against a real
// scratch Postgres (it truncates tables), never mocks:
//  - /report-content takes third-party and possible-minor reports without the
//    self-attestation (a good-faith statement instead), records the category,
//    and still requires the self-attestation from a 'self' filing;
//  - the waitlist keeps a US state only, and no country;
//  - /api/admin/alerts-status reports whether NCII alerts are configured,
//    admin-key only, and never echoes the webhook URL;
//  - resolving a POSSIBLE MINOR report against a creator bans them outright in
//    the resolve's transaction and takes down paid listings' files too, while
//    an ordinary first report still only suspends;
//  - the NCII alert labels a possible-minor filing, with no reporter data;
//  - the schema's one-off cleanup strips country (and a non-US region) from
//    waitlist rows stored before the change.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/r3u2.test.mjs

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r3u2';
delete process.env.NCII_ALERT_WEBHOOK_URL;

const { query, closePool } = await import('./db.js');
const ncii = await import('./ncii-reports-store.js');
const { default: reportContentRoute } = await import('../pages/api/report-content.js');
const { default: waitlistRoute } = await import('../pages/api/waitlist.js');
const { default: alertsStatusRoute } = await import('../pages/api/admin/alerts-status.js');
const { default: resolveRoute } = await import('../pages/api/admin/ncii-reports-resolve.js');
const alerts = await import('./alerts.js');

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
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() {},
  };
}
let ipN = 0;
async function call(route, { method = 'POST', body, query: q = {}, admin = false, headers: extra = {} } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = { 'x-forwarded-for': `10.77.0.${ipN}`, ...extra };
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  await quiet(() => route({ method, body, query: q, headers, socket: { remoteAddress: `10.77.0.${ipN}` } }, res));
  return res;
}
const latestReport = async () => (await query('select data from ncii_reports order by id desc limit 1')).rows[0]?.data;
const BASE = { reporterName: 'R', reporterContact: 'r@x.co', contentLocation: 'https://joinonlyone.com/creator/4' };

try {
  await query('truncate ncii_reports, waitlist restart identity');
  await query('truncate creators, listings, orders');

  section('Report intake: who is filing (legal-journeys#0)');
  {
    let res = await call(reportContentRoute, { body: { ...BASE, category: 'minor', goodFaithStatement: true } });
    check('a third party can report a possible minor without the self-attestation', res.statusCode === 200, JSON.stringify(res.body));
    let r = await latestReport();
    check('stored as category minor', r?.category === 'minor', JSON.stringify(r));
    check('the self-attestation is NOT recorded as signed', r?.consentStatement === false);
    check('the good-faith statement is recorded', r?.goodFaithStatement === true);

    res = await call(reportContentRoute, { body: { ...BASE, category: 'third_party', goodFaithStatement: true, consentStatement: true } });
    check('third-party report accepted', res.statusCode === 200, JSON.stringify(res.body));
    r = await latestReport();
    check('stored as third_party, self-attestation still false even if sent', r?.category === 'third_party' && r?.consentStatement === false);

    res = await call(reportContentRoute, { body: { ...BASE, category: 'minor' } });
    check('a minor report still needs the good-faith statement', res.statusCode === 400, JSON.stringify(res.body));

    res = await call(reportContentRoute, { body: { ...BASE, category: 'self', goodFaithStatement: true } });
    check('a self report still needs the self-attestation (good-faith alone is not enough)', res.statusCode === 400);

    res = await call(reportContentRoute, { body: { ...BASE, consentStatement: true } });
    check('no category = the original self filing, still accepted', res.statusCode === 200, JSON.stringify(res.body));
    r = await latestReport();
    check('...stored as self with the attestation', r?.category === 'self' && r?.consentStatement === true);

    res = await call(reportContentRoute, { body: { ...BASE, category: 'admin', consentStatement: true } });
    check('an unknown category is refused, not guessed', res.statusCode === 400);
    res = await call(reportContentRoute, { body: { ...BASE, category: { x: 1 }, consentStatement: true } });
    check('a non-string category is refused', res.statusCode === 400);

    const direct = await ncii.addNciiReport({ ...BASE, category: 'bogus', consentStatement: true });
    check('the store normalises an unknown category to self', direct.category === 'self');
  }

  section('Waitlist keeps a US state only (legal-journeys#6)');
  {
    let res = await call(waitlistRoute, {
      body: { email: 'ca@example.com', role: 'fan', source: 'landing' },
      headers: { 'x-vercel-ip-country': 'CA', 'x-vercel-ip-country-region': 'ON' },
    });
    check('a Canadian signup succeeds', res.statusCode === 200, JSON.stringify(res.body));
    let row = (await query(`select data from waitlist where data->>'email' = 'ca@example.com'`)).rows[0]?.data;
    check('no region stored for a non-US visitor', row && row.state === null, JSON.stringify(row));
    check('no country stored', row && row.country === null);

    res = await call(waitlistRoute, {
      body: { email: 'tx@example.com', role: 'creator', source: 'blocked-region' },
      headers: { 'x-vercel-ip-country': 'US', 'x-vercel-ip-country-region': 'TX' },
    });
    row = (await query(`select data from waitlist where data->>'email' = 'tx@example.com'`)).rows[0]?.data;
    check('a US state is kept', res.statusCode === 200 && row?.state === 'TX', JSON.stringify(row));
    check('...and still no country', row?.country === null);
  }

  section('Admin alert status (social#2)');
  {
    let res = await call(alertsStatusRoute, { method: 'GET', admin: true });
    check('unset webhook reads as not configured', res.statusCode === 200 && res.body.nciiWebhookConfigured === false, JSON.stringify(res.body));
    process.env.NCII_ALERT_WEBHOOK_URL = 'https://hooks.example.test/secret-path';
    res = await call(alertsStatusRoute, { method: 'GET', admin: true });
    check('set webhook reads as configured', res.body.nciiWebhookConfigured === true);
    check('the URL itself is never returned', !JSON.stringify(res.body).includes('secret-path'));
    delete process.env.NCII_ALERT_WEBHOOK_URL;
    res = await call(alertsStatusRoute, { method: 'GET', admin: false });
    check('needs the admin key', res.statusCode === 401 || res.statusCode === 403, String(res.statusCode));
  }
  section('Possible-minor report bans outright, paid files included (review: minor ban)');
  {
    const mkCreator = (id, fields = {}) => query('insert into creators (id, data) values ($1, $2)',
      [id, { name: `Creator ${id}`, handle: `@${id}`, status: 'active', ...fields }]);
    const mkListing = async (creatorId, fields = {}) => (await query(
      'insert into listings (data) values ($1) returning id',
      [{ creatorId, title: 't', status: 'active', kind: 'digital', media: [{ src: `/api/media/listings/${creatorId}/x/${Math.random()}.jpg`, type: 'image' }], ...fields }],
    )).rows[0].id;
    await mkCreator('m1', { founding: true, foundingSince: '2026-09-01T00:00:00.000Z' });
    const paid = await mkListing('m1');
    const unpaid = await mkListing('m1');
    await query('insert into orders (data) values ($1)', [{ listingId: String(paid), kind: 'digital', status: 'fulfilled' }]);

    const minor = await ncii.addNciiReport({ ...BASE, category: 'minor', goodFaithStatement: true });
    // The admin's request does not say "ban": the stored category decides.
    const res = await call(resolveRoute, { admin: true, body: { id: minor.id, action: 'removed', creatorId: 'm1' } });
    check('resolve succeeds', res.statusCode === 200, JSON.stringify(res.body));
    check('first violation on a possible-minor report is an outright ban', res.body?.creator?.status === 'banned' && res.body?.outrightBan === true, JSON.stringify(res.body?.creator));
    check('the violation is still counted once', res.body?.creator?.contentViolationCount === 1);
    check('the ban ends founding status', res.body?.creator?.founding === false);
    const rows = (await query('select id, data from listings where id = any($1::bigint[]) order by id', [[paid, unpaid]])).rows;
    const byId = Object.fromEntries(rows.map((r) => [String(r.id), r.data]));
    check('the PAID listing is taken down and its files marked deleted (no keepPaid)',
      byId[paid]?.status === 'removed' && !!byId[paid]?.mediaDeletedAt && byId[paid]?.moderationRemoved === true, JSON.stringify(byId[paid]));
    check('the unpaid listing is taken down too', byId[unpaid]?.status === 'removed' && !!byId[unpaid]?.mediaDeletedAt);

    await mkCreator('m2');
    const self = await ncii.addNciiReport({ ...BASE, consentStatement: true });
    // contentGone: since R5B a 'removed' resolve that only suspends needs the
    // removal on file (a recorded takedown, or this acknowledgement).
    const r2 = await call(resolveRoute, { admin: true, body: { id: self.id, action: 'removed', creatorId: 'm2', contentGone: true } });
    check('an ordinary first report still only suspends', r2.body?.creator?.status === 'suspended' && r2.body?.outrightBan === false, JSON.stringify(r2.body));

    await mkCreator('m3', { status: 'pending' });
    const minor2 = await ncii.addNciiReport({ ...BASE, category: 'minor', goodFaithStatement: true });
    const r3 = await call(resolveRoute, { admin: true, body: { id: minor2.id, action: 'removed', creatorId: 'm3' } });
    check('a pending applicant on a possible-minor report is banned, not left pending', r3.body?.creator?.status === 'banned', JSON.stringify(r3.body));

    const minor3 = await ncii.addNciiReport({ ...BASE, category: 'minor', goodFaithStatement: true });
    const r4 = await call(resolveRoute, { admin: true, body: { id: minor3.id, action: 'removed', contentGone: true } });
    check('unattributed possible-minor resolve bans nobody', r4.statusCode === 200 && !r4.body?.creator && r4.body?.outrightBan === false, JSON.stringify(r4.body));
  }

  section('NCII alert labels a possible-minor filing');
  {
    const at = '2026-09-24T10:00:00.000Z';
    check('minor filing is labelled',
      alerts.nciiAlertText({ id: 3, createdAt: at, category: 'minor' }) === `POSSIBLE MINOR — New TAKE IT DOWN request #3 filed ${at} — 48h clock running. Review in /admin.`);
    check('a self filing keeps the agreed text',
      alerts.nciiAlertText({ id: 3, createdAt: at, category: 'self' }) === `New TAKE IT DOWN request #3 filed ${at} — 48h clock running. Review in /admin.`);
    process.env.NCII_ALERT_WEBHOOK_URL = 'https://hooks.example.test/x';
    let body = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_u, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200 }; };
    try {
      const res = await call(reportContentRoute, { body: { ...BASE, reporterName: 'Secret Person', category: 'minor', goodFaithStatement: true } });
      check('the intake route sends the minor label', res.statusCode === 200 && String(body?.text || '').startsWith('POSSIBLE MINOR'), JSON.stringify(body));
      check('...and no reporter data', !JSON.stringify(body).includes('Secret') && !JSON.stringify(body).includes('r@x.co'));
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.NCII_ALERT_WEBHOOK_URL;
    }
  }

  section('Schema cleanup strips stored location beyond a US state');
  {
    await query('truncate waitlist restart identity');
    await query(`insert into waitlist (data) values ($1), ($2), ($3)`, [
      { email: 'old-ca@example.com', roles: ['fan'], state: 'ON', country: 'CA' },
      { email: 'old-us@example.com', roles: ['fan'], state: 'TX', country: 'US' },
      { email: 'new@example.com', roles: ['fan'], state: 'OH', country: null },
    ]);
    await query(`delete from app_meta where key = 'schema_version'`);
    const fresh = await import('./db.js?reapply');
    await fresh.ensureSchema();
    await fresh.closePool();
    const got = Object.fromEntries((await query('select data from waitlist')).rows.map((r) => [r.data.email, r.data]));
    check('old non-US row loses country and region', got['old-ca@example.com']?.country == null && got['old-ca@example.com']?.state == null, JSON.stringify(got['old-ca@example.com']));
    check('old US row keeps its state, loses country', got['old-us@example.com']?.state === 'TX' && got['old-us@example.com']?.country == null, JSON.stringify(got['old-us@example.com']));
    check('a new row is untouched', got['new@example.com']?.state === 'OH');
  }
} finally {
  await closePool();
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
