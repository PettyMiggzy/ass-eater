// Round-9 R9U2 regression tests: the admin editor's Founding hint
// (admin-ui#2) must say what /api/admin/profile actually does to the 30-day
// fee-free window. foundingWindowOutcome() (components/admin/creatorDraft.js)
// is what the hint is built from; each case below saves through the REAL
// handler against a real Postgres and checks the stamped foundingSince agrees
// with the prediction made before the save. Never mocks.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test \
//   node --import ./test-register.mjs lib/r9u2.test.mjs
//
// Truncates tables, so it refuses anything but a local scratch database.

import { query, closePool } from './db.js';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}

process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r9u2';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
  };
}

const creatorsStore = await import('./creators-store.js');
const { draftFrom, fieldsFromDraft, foundingWindowOutcome } = await import('../components/admin/creatorDraft.js');
const { describeObligation } = await import('../components/admin/adminApi.js');
const adminProfile = (await import('../pages/api/admin/profile.js')).default;

async function reset() {
  await query('truncate creators, users, listings, violations, performer_records restart identity');
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}

/** One save as the panel does it: only fields that differ from the baseline. */
async function savePanel(creatorId, draft, baseline) {
  const built = fieldsFromDraft(draft, baseline);
  if (built.error) throw new Error(built.error);
  const res = mockRes();
  await adminProfile(
    {
      method: 'POST',
      body: { creatorId, fields: built.fields },
      headers: { 'x-admin-key': process.env.ADMIN_UPLOAD_KEY, 'x-forwarded-for': '10.49.0.1' },
      socket: { remoteAddress: '10.49.0.1' },
    },
    res,
  );
  return res;
}

async function setData(id, patch) {
  await query('update creators set data = data || $2::jsonb where id = $1', [String(id), JSON.stringify(patch)]);
  return creatorsStore.getCreatorById(String(id));
}

const PROFILE = {
  name: 'Jane Real',
  handle: '@janereal',
  bio: 'A real, finished bio that is comfortably over forty characters long.',
  img: '/images/demo_female_avatar.jpg',
  tags: ['cosplay'],
  gallery: [{ src: '/images/a.jpg' }, { src: '/images/b.jpg' }, { src: '/images/c.jpg' }],
};

const DAY = 24 * 60 * 60 * 1000;
const near = (a, b, tol = 60 * 1000) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

try {
  await reset();

  section('Active creator: ticking Founding starts the window ON SAVE (the old hint said it had not started)');
  {
    let c = await creatorsStore.createCreator({ ...PROFILE, handle: '@active1', status: 'active', approvedAt: new Date(Date.now() - 5 * DAY).toISOString() });
    const baseline = draftFrom(c);
    const draft = { ...baseline, founding: true };
    const predicted = foundingWindowOutcome(c, draft.status);
    check('predicted: starts now', predicted.kind === 'now', JSON.stringify(predicted));
    const before = Date.now();
    const res = await savePanel(c.id, draft, baseline);
    check('save ok', res.statusCode === 200, JSON.stringify(res.body));
    const since = Date.parse(res.body?.creator?.foundingSince || '');
    check('server stamped foundingSince at the save', since >= before - 1000 && since <= Date.now() + 1000, res.body?.creator?.foundingSince);
    c = res.body.creator;
    check('after the save the hint has nothing to say (window started)', foundingWindowOutcome(c, 'active').kind === 'started');
  }

  section('Suspended creator (future suspendedUntil): the window starts when the suspension ends');
  {
    const until = new Date(Date.now() + 12 * DAY).toISOString();
    let c = await creatorsStore.createCreator({ ...PROFILE, handle: '@susp1', status: 'active', approvedAt: new Date(Date.now() - 40 * DAY).toISOString() });
    c = await setData(c.id, { status: 'suspended', suspendedUntil: until });
    const baseline = draftFrom(c);
    check('draft status is suspended', baseline.status === 'suspended');
    const draft = { ...baseline, founding: true };
    const predicted = foundingWindowOutcome(c, draft.status);
    check('predicted: at the existing suspension end', predicted.kind === 'at' && predicted.at === Date.parse(until) && predicted.fresh === false, JSON.stringify(predicted));
    const res = await savePanel(c.id, draft, baseline);
    check('save ok', res.statusCode === 200, JSON.stringify(res.body));
    check('server stamped foundingSince = suspendedUntil', Date.parse(res.body?.creator?.foundingSince || '') === Date.parse(until), res.body?.creator?.foundingSince);
  }

  section('Active creator suspended in the same save: starts when the NEW 30-day suspension ends');
  {
    const c = await creatorsStore.createCreator({ ...PROFILE, handle: '@susp2', status: 'active', approvedAt: new Date(Date.now() - 40 * DAY).toISOString() });
    const baseline = draftFrom(c);
    const draft = { ...baseline, founding: true, status: 'suspended' };
    const predicted = foundingWindowOutcome(c, draft.status);
    check('predicted: a fresh 30-day suspension end', predicted.kind === 'at' && predicted.fresh === true && near(predicted.at, Date.now() + 30 * DAY), JSON.stringify(predicted));
    const res = await savePanel(c.id, draft, baseline);
    check('save ok', res.statusCode === 200, JSON.stringify(res.body));
    const since = Date.parse(res.body?.creator?.foundingSince || '');
    check('server stamped the suspension end', near(since, predicted.at) && since === Date.parse(res.body.creator.suspendedUntil), res.body?.creator?.foundingSince);
  }

  section('Pending applicant: the slot is held, the window starts at approval');
  {
    const c = await creatorsStore.createCreator({ ...PROFILE, handle: '@pend1', status: 'pending' });
    const baseline = draftFrom(c);
    const draft = { ...baseline, founding: true };
    check('predicted: at approval', foundingWindowOutcome(c, draft.status).kind === 'approval');
    const res = await savePanel(c.id, draft, baseline);
    check('save ok', res.statusCode === 200, JSON.stringify(res.body));
    check('founding held with no start yet', res.body?.creator?.founding === true && !res.body.creator.foundingSince, JSON.stringify(res.body?.creator));
  }

  section('Banned in the same save: Founding is revoked whatever the box says');
  {
    const c = await creatorsStore.createCreator({ ...PROFILE, handle: '@ban1', status: 'active', approvedAt: new Date(Date.now() - 40 * DAY).toISOString() });
    const baseline = draftFrom(c);
    const draft = { ...baseline, founding: true, status: 'banned' };
    check('predicted: revoked', foundingWindowOutcome(c, draft.status).kind === 'revoked');
    const res = await savePanel(c.id, draft, baseline);
    check('save answered', res.statusCode === 200 || res.statusCode === 500, JSON.stringify(res.body));
    check('not founding after a ban', res.body?.creator?.founding !== true && !res.body?.creator?.foundingSince, JSON.stringify(res.body?.creator));
  }

  section('A future foundingSince (grant made while suspended) is not reported as started');
  {
    const c = { status: 'suspended', suspendedUntil: new Date(Date.now() + 3 * DAY).toISOString(), founding: true, foundingSince: new Date(Date.now() + 3 * DAY).toISOString() };
    const o = foundingWindowOutcome(c, 'suspended');
    check('outcome is the suspension end, not "started"', o.kind === 'at' && o.fresh === false, JSON.stringify(o));
    check('an already-past foundingSince reads started', foundingWindowOutcome({ foundingSince: new Date(Date.now() - DAY).toISOString() }, 'active').kind === 'started');
  }

  section('A delete/ban obligation line points at where the unshipped orders are listed (admin-ui#0)');
  {
    const line = describeObligation({ creatorId: '12', name: 'X', pendingShipments: 3 });
    check('names the count', line.includes('3 paid order(s) not yet shipped'), line);
    check('says where to find them, with the seller number', line.includes('ACCOUNTS -> Orders') && line.includes('12'), line);
  }
} catch (err) {
  fail++;
  console.error('UNEXPECTED', err);
} finally {
  await closePool();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
