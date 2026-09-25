// Regression tests for the admin creator editor's save round-trip
// (admin-dashboard#4), run against the REAL /api/admin/profile handler and a
// real Postgres, never mocks.
//
// The bug: the editor built its draft once, when a creator was selected, and
// never rebuilt it after a save. The server changes coupled fields on save --
// it auto-grants Founding on approval and stamps suspendedUntil on a new
// suspension -- so the next save posted the stale values back: founding:false
// revoked the badge the server had just granted (and wiped foundingSince),
// and suspendedUntil:null restarted the suspension's 30 days on every
// unrelated edit. pages/admin/index.js now rebuilds the draft from the saved
// record with draftFrom() after every save; these tests drive exactly that
// flow (draftFrom -> fieldsFromDraft -> handler -> draftFrom(response)).
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test \
//   node --import ./test-register.mjs lib/admin-draft.test.mjs
//
// Truncates tables, so it refuses anything but a local scratch database.

import { query, closePool } from './db.js';

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}

process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-w2admin';

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
const { draftFrom, fieldsFromDraft, rebaseDraft } = await import('../components/admin/creatorDraft.js');
const adminProfile = (await import('../pages/api/admin/profile.js')).default;

async function reset() {
  await query('truncate creators, users, listings, violations, performer_records restart identity');
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}

/** One press of "Save Profile" in the panel: the draft as posted. */
async function save(creatorId, draft) {
  const built = fieldsFromDraft(draft);
  if (built.error) throw new Error(built.error);
  const res = mockRes();
  await adminProfile(
    {
      method: 'POST',
      body: { creatorId, fields: built.fields },
      headers: { 'x-admin-key': process.env.ADMIN_UPLOAD_KEY, 'x-forwarded-for': '10.44.0.1' },
      socket: { remoteAddress: '10.44.0.1' },
    },
    res,
  );
  return res;
}

/**
 * One press of "Save Profile" as the panel does it now (admin-ui#0): rebase
 * the open draft onto the record as stored NOW, refuse on a conflict, and post
 * only the fields that differ from the rebased baseline.
 */
async function saveLikePanel(creatorId, draft, baseline) {
  const current = await creatorsStore.getCreatorById(creatorId);
  const rebased = rebaseDraft(draft, baseline, current);
  if (rebased.conflicts.length) return { conflicts: rebased.conflicts, res: null, fields: null };
  const built = fieldsFromDraft(rebased.draft, rebased.baseline);
  if (built.error) throw new Error(built.error);
  const res = mockRes();
  await adminProfile(
    {
      method: 'POST',
      body: { creatorId, fields: built.fields },
      headers: { 'x-admin-key': process.env.ADMIN_UPLOAD_KEY, 'x-forwarded-for': '10.44.0.1' },
      socket: { remoteAddress: '10.44.0.1' },
    },
    res,
  );
  return { conflicts: [], res, fields: built.fields };
}

const QUALIFYING = {
  name: 'Jane Real',
  handle: '@janereal',
  bio: 'A real, finished bio that is comfortably over forty characters long.',
  img: '/images/demo_female_avatar.jpg',
  tags: ['cosplay'],
  gallery: [{ src: '/images/a.jpg' }, { src: '/images/b.jpg' }, { src: '/images/c.jpg' }],
};

async function addRecord(creatorId) {
  await query('insert into performer_records (data) values ($1)', [{ creatorId: String(creatorId), status: 'active', aliases: [], documentLocation: 'offline' }]);
}

try {
  await reset();

  section('Approval auto-grants Founding, and the NEXT save keeps it');
  {
    const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'pending' });
    await addRecord(c.id);
    let draft = draftFrom(c);
    check('the draft starts unticked', draft.founding === false);

    let res = await save(c.id, { ...draft, status: 'active' });
    check('approval saves', res.statusCode === 200, JSON.stringify(res.body));
    check('the server auto-granted Founding', res.body?.creator?.founding === true && !!res.body.creator.foundingSince);
    const since = res.body.creator.foundingSince;

    // What the OLD panel would have posted next: its pre-save draft.
    const stale = { ...draft, status: 'active', trending: true };
    check('the stale draft still says founding:false (the bug)', stale.founding === false);

    // What the panel posts now: the draft rebuilt from the saved record.
    draft = draftFrom(res.body.creator);
    check('the resynced draft shows Founding ticked', draft.founding === true);
    res = await save(c.id, { ...draft, trending: true });
    check('an unrelated second save succeeds', res.statusCode === 200, JSON.stringify(res.body));
    const after = await creatorsStore.getCreatorById(c.id);
    check('Founding survives the second save', after.founding === true);
    check('foundingSince is unchanged (the fee window did not restart)', after.foundingSince === since);
    check('no revocation was recorded', !after.foundingRevokedAt);
    check('the unrelated edit landed', after.trending === true);
  }

  section('A suspension keeps its own end date across later saves');
  {
    await reset();
    const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'active' });
    let draft = draftFrom(c);
    let res = await save(c.id, { ...draft, status: 'suspended' });
    check('suspending saves', res.statusCode === 200, JSON.stringify(res.body));
    const until = res.body?.creator?.suspendedUntil;
    check('the server stamped an end date', typeof until === 'string' && Date.parse(until) > Date.now());
    check('the pre-save draft had no end date (the bug)', draft.suspendedUntil === null);

    // Backdate the stored end date so a restarted clock would be visible.
    const backdated = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    await query(`update creators set data = data || jsonb_build_object('suspendedUntil', $2::text) where id = $1`, [String(c.id), backdated]);
    const stored = await creatorsStore.getCreatorById(c.id);

    draft = draftFrom(stored);
    check('the resynced draft carries the stored end date', draft.suspendedUntil === backdated);
    res = await save(c.id, { ...draft, bio: `${QUALIFYING.bio} Edited.` });
    check('an unrelated save while suspended succeeds', res.statusCode === 200, JSON.stringify(res.body));
    const after = await creatorsStore.getCreatorById(c.id);
    check('the suspension still ends on the same date (no fresh 30 days)', after.suspendedUntil === backdated, after.suspendedUntil);
    check('still suspended', creatorsStore.effectiveCreatorStatus(after) === 'suspended');
  }

  section('A stale draft never reverts a wallet/bio/handle the creator changed after the panel loaded (admin-ui#0)');
  {
    await reset();
    const OLD_WALLET = '0x' + 'a'.repeat(40);
    const NEW_WALLET = '0x' + 'b'.repeat(40);
    const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'active', walletAddress: OLD_WALLET });
    // 10:00 -- the admin opens the creator: draft + baseline from that copy.
    const loaded = await creatorsStore.getCreatorById(c.id);
    const baseline = draftFrom(loaded);
    check('the panel loaded the old wallet', baseline.walletAddress === OLD_WALLET);
    // 10:05 -- the creator changes wallet, bio and handle from their dashboard.
    const newBio = `${QUALIFYING.bio} Updated by the creator.`;
    await creatorsStore.updateCreatorProfile(c.id, { walletAddress: NEW_WALLET, bio: newBio, handle: '@janenew' });
    // 10:30 -- the admin only ticks Trending and saves.
    const { conflicts, res, fields } = await saveLikePanel(c.id, { ...baseline, trending: true }, baseline);
    check('no conflict (the admin touched only Trending)', conflicts.length === 0, JSON.stringify(conflicts));
    check('only trending is posted', JSON.stringify(Object.keys(fields || {})) === '["trending"]', JSON.stringify(fields));
    check('the save succeeds', res?.statusCode === 200, JSON.stringify(res?.body));
    const after = await creatorsStore.getCreatorById(c.id);
    check('the creator\'s NEW wallet survives', after.walletAddress === NEW_WALLET, after.walletAddress);
    check('the creator\'s new bio survives', after.bio === newBio);
    check('the creator\'s new handle survives', String(after.handle).toLowerCase().includes('janenew'), after.handle);
    check('the admin\'s edit landed', after.trending === true);

    // Old behaviour, for contrast: posting the whole stale draft writes the old wallet back.
    const staleFields = fieldsFromDraft({ ...baseline, trending: true }).fields;
    check('the full stale draft WOULD carry the old wallet (the bug)', staleFields.walletAddress === OLD_WALLET);
  }

  section('An admin edit to a field the creator ALSO changed since load is stopped, not overwritten');
  {
    await reset();
    const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'active', walletAddress: '0x' + 'a'.repeat(40) });
    const baseline = draftFrom(await creatorsStore.getCreatorById(c.id));
    await creatorsStore.updateCreatorProfile(c.id, { walletAddress: '0x' + 'c'.repeat(40) });
    const { conflicts, res } = await saveLikePanel(c.id, { ...baseline, walletAddress: '0x' + 'd'.repeat(40) }, baseline);
    check('the wallet is reported as a conflict', conflicts.includes('walletAddress'), JSON.stringify(conflicts));
    check('nothing was posted', res === null);
    const after = await creatorsStore.getCreatorById(c.id);
    check('the creator\'s wallet is untouched', after.walletAddress === '0x' + 'c'.repeat(40), after.walletAddress);
  }

  section('An admin edit with no concurrent change is sent alone');
  {
    await reset();
    const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'active' });
    const baseline = draftFrom(await creatorsStore.getCreatorById(c.id));
    const newBio = `${QUALIFYING.bio} Admin fixed a typo.`;
    const { conflicts, res, fields } = await saveLikePanel(c.id, { ...baseline, bio: newBio }, baseline);
    check('no conflict', conflicts.length === 0);
    check('only bio is posted', JSON.stringify(Object.keys(fields || {})) === '["bio"]', JSON.stringify(fields));
    check('saved', res?.statusCode === 200, JSON.stringify(res?.body));
    check('bio updated', (await creatorsStore.getCreatorById(c.id)).bio === newBio);
  }

  section('Draft <-> fields mapping');
  {
    const c = { id: 9, name: 'X', handle: '@x', status: 'pending', dmPriceCents: 250, payoutMethod: 'eth', walletAddress: '0xabc', img: '/api/media/avatars/9/a.jpg' };
    const d = draftFrom(c);
    check('dmPriceCents is edited in dollars', d.dmPrice === '2.50');
    check('pending stays pending in the draft', d.status === 'pending');
    const { fields } = fieldsFromDraft(d);
    check('dollars go back as cents', fields.dmPriceCents === 250);
    check('payoutMethod (ETH) is never sent', !('payoutMethod' in fields));
    check('img is never sent (avatar only changes by upload)', !('img' in fields));
    check('a blank price means the platform floor (null)', fieldsFromDraft({ ...d, dmPrice: '' }).fields.dmPriceCents === null);
    check('"$1.00" is accepted', fieldsFromDraft({ ...d, dmPrice: '$1.00' }).fields.dmPriceCents === 100);
    check('garbage is refused client-side', !!fieldsFromDraft({ ...d, dmPrice: 'abc' }).error);
    check('no dmPriceCents on the record -> blank', draftFrom({ ...c, dmPriceCents: null }).dmPrice === '');
  }

  section('A banned creator: saving again with no edits re-sends the ban, so a failed listing takedown can be retried (admin-ui#0)');
  {
    await reset();
    const listingsStore = await import('./listings-store.js');
    const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'banned' });
    // A listing the earlier (failed) takedown never reached.
    const l = await listingsStore.createListing(c.id, { title: 'Still up', priceCents: 500 });
    const baseline = draftFrom(await creatorsStore.getCreatorById(c.id));
    check('the draft reads banned', baseline.status === 'banned');
    const built = fieldsFromDraft(baseline, baseline);
    check('an unchanged banned draft still posts status: banned', built.fields.status === 'banned', JSON.stringify(built.fields));
    check('...with no suspension date', built.fields.suspendedUntil === null);
    const { res, fields } = await saveLikePanel(c.id, baseline, baseline);
    check('the retry save succeeds', res?.statusCode === 200, JSON.stringify(res?.body));
    check('the retry posted the ban', fields?.status === 'banned');
    const { rows } = await query('select data from listings where id = $1', [l.id]);
    check('the listing the first takedown missed is now removed', rows[0]?.data?.status === 'removed', JSON.stringify(rows[0]?.data?.status));
  }

  section('A banned draft does NOT re-ban a creator reinstated elsewhere since it was opened');
  {
    await reset();
    const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'banned' });
    await addRecord(c.id);
    const baseline = draftFrom(await creatorsStore.getCreatorById(c.id));
    // Another admin tab reinstates them.
    await creatorsStore.updateCreatorProfile(c.id, { status: 'active' });
    const { conflicts, res, fields } = await saveLikePanel(c.id, { ...baseline, trending: true }, baseline);
    check('no conflict (status was not touched here)', conflicts.length === 0, JSON.stringify(conflicts));
    check('status is not posted', !('status' in (fields || {})), JSON.stringify(fields));
    check('saved', res?.statusCode === 200, JSON.stringify(res?.body));
    check('still active', (await creatorsStore.getCreatorById(c.id)).status === 'active');
  }

  section('An active creator with nothing changed posts nothing (diff-only saves unchanged)');
  {
    await reset();
    const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'active' });
    const baseline = draftFrom(await creatorsStore.getCreatorById(c.id));
    check('no fields', Object.keys(fieldsFromDraft(baseline, baseline).fields).length === 0);
  }

  section('A pending applicant cannot be suspended (the panel hides the option; the server refuses it)');
  {
    await reset();
    const c = await creatorsStore.createCreator({ ...QUALIFYING, status: 'pending' });
    const res = await save(c.id, { ...draftFrom(c), status: 'suspended' });
    check('refused with 400', res.statusCode === 400, JSON.stringify(res.body));
    const after = await creatorsStore.getCreatorById(c.id);
    check('still pending', after.status === 'pending');
  }
} finally {
  await closePool();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
