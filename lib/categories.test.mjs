// Browse-by-category (package R5CAT): the fixed taxonomy in lib/categories.js,
// the public projection, the three profile write paths and the marketplace
// list API. The pure helpers are tested directly; the routes run against a
// real scratch Postgres (it truncates tables), never mocks.
//
// Run with:
//   DATABASE_URL=postgresql://localhost/..._test node --import ./test-register.mjs lib/categories.test.mjs

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
process.env.SERVER_API_URL = 'http://127.0.0.1:9';
process.env.BRIDGE_SECRET = 'test-bridge-secret-r5cat';
process.env.ADMIN_UPLOAD_KEY = 'test-admin-key-r5cat';

const cats = await import('./categories.js');
const { toPublicCreator } = await import('./creator-status.js');
const { query, closePool } = await import('./db.js');
const creators = await import('./creators-store.js');
const listings = await import('./listings-store.js');
const users = await import('./users-store.js');
const media = await import('./media.js');
const { createSessionToken } = await import('./session.js');
const { draftFrom, fieldsFromDraft, rebaseDraft } = await import('../components/admin/creatorDraft.js');
const { draftFromCreator, profileFieldsFromDraft } = await import('../components/dashboard/helpers.js');
const { creators: seedRoster } = await import('../data/creators.js');
const { default: meProfileRoute } = await import('../pages/api/me/profile.js');
const { default: adminProfileRoute } = await import('../pages/api/admin/profile.js');
const { default: adminCreateRoute } = await import('../pages/api/admin/create.js');
const { default: listRoute } = await import('../pages/api/marketplace/list.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
async function call(route, { method = 'POST', body, query: q = {}, admin = false, user = null } = {}) {
  ipN++;
  const res = fakeRes();
  const headers = { 'x-forwarded-for': `10.77.${Math.floor(ipN / 250)}.${ipN % 250}` };
  if (admin) headers['x-admin-key'] = process.env.ADMIN_UPLOAD_KEY;
  if (user) headers.cookie = `oa_session=${createSessionToken(user.id, user.sessionVersion || 0)}`;
  await quiet(() => route({ method, body, query: q, headers, socket: { remoteAddress: headers['x-forwarded-for'] } }, res));
  return res;
}
async function reset() {
  await query(`truncate creators, users, listings, orders, violations restart identity`);
  await query('delete from app_meta');
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb)`);
}
const stored = async (id) => (await query('select data from creators where id = $1', [String(id)])).rows[0].data;

// ---------------------------------------------------------------------------
section('taxonomy');
check('eight categories in the specified order', same(cats.CATEGORIES.map((c) => c.key), ['women', 'men', 'couples', 'gay', 'lesbian', 'trans', 'nonbinary', 'ai']));
check('labels', cats.categoryLabel('trans') === 'Trans' && cats.categoryLabel('nonbinary') === 'Non-binary' && cats.categoryLabel('ai') === 'AI / Virtual');
check('no slur anywhere in the labels', cats.CATEGORIES.every((c) => !/shemale|tranny/i.test(`${c.key} ${c.label}`)));
check('categoryLabel never throws on junk', cats.categoryLabel(undefined) === '' && cats.categoryLabel({}) === '' && cats.categoryLabel('nope') === 'nope');
check('taxonomy is frozen', Object.isFrozen(cats.CATEGORIES) && Object.isFrozen(cats.CATEGORIES[0]));

section('sanitizeCategories');
const sc = cats.sanitizeCategories;
check('non-array/non-string -> []', [null, undefined, 42, true, {}, () => 1, NaN].every((v) => same(sc(v), [])));
check('unknown keys dropped', same(sc(['women', 'shemale', 'MILF', '']), ['women']));
check('dupes removed, order kept', same(sc(['men', 'women', 'men']), ['men', 'women']));
check('max 3', same(sc(['women', 'men', 'gay', 'trans', 'ai']), ['women', 'men', 'gay']));
check('mixed case and whitespace', same(sc(['  Women ', 'MEN', '\tTrans\n']), ['women', 'men', 'trans']));
check('comma-separated string', same(sc('women, Men ,  ai'), ['women', 'men', 'ai']));
check('non-string items inside an array are skipped', same(sc([1, null, { key: 'women' }, ['men'], 'gay']), ['gay']));
check('label text is not a key', same(sc(['Non-binary', 'AI / Virtual']), []));

section('parseCategoriesInput (the routes)');
const pc = cats.parseCategoriesInput;
check('null/empty clears', same(pc(null).value, []) && same(pc('').value, []) && same(pc(undefined).value, []));
check('array ok', same(pc(['women', 'bogus']).value, ['women']));
check('comma string ok', same(pc('men,gay').value, ['men', 'gay']));
check('number refused', !!pc(5).error);
check('object refused', !!pc({ 0: 'women' }).error);
check('array of non-strings refused', !!pc(['women', 7]).error);
check('four known keys refused, not silently cut', !!pc(['women', 'men', 'gay', 'trans']).error);
check('four entries with a duplicate is fine', same(pc(['women', 'women', 'men', 'gay']).value, ['women', 'men', 'gay']));

section('query + URL helpers');
check('categoryFromQuery known', cats.categoryFromQuery('Women') === 'women');
check('categoryFromQuery array takes first', cats.categoryFromQuery(['men', 'women']) === 'men');
check('categoryFromQuery junk -> null', cats.categoryFromQuery('x') === null && cats.categoryFromQuery(undefined) === null && cats.categoryFromQuery({}) === null);
check('withCategoryParam keeps other params', cats.withCategoryParam('?creator=4&listing=9', 'women') === '?creator=4&listing=9&category=women');
check('withCategoryParam replaces', cats.withCategoryParam('category=men&q=x', 'gay') === '?category=gay&q=x');
check('withCategoryParam clears', cats.withCategoryParam('?category=men', null) === '' && cats.withCategoryParam('?q=a&category=men', '') === '?q=a');
check('withCategoryParam ignores an unknown key (clears)', cats.withCategoryParam('?category=men', 'bogus') === '');
check('creatorInCategory', cats.creatorInCategory({ categories: ['men'] }, 'men') && !cats.creatorInCategory({ categories: ['men'] }, 'women') && cats.creatorInCategory({}, null));
check('creatorInCategory re-sanitises stored junk', !cats.creatorInCategory({ categories: 'nope' }, 'women') && cats.creatorInCategory({ categories: ' Women ' }, 'women'));

section('countByCategory (faceted count helper)');
{
  const items = [{ c: ['women'] }, { c: ['women', 'couples'] }, { c: ['men'] }, { c: null }, { c: ['bogus', 'men', 'men'] }];
  const { total, counts } = cats.countByCategory(items, (i) => i.c);
  check('total counts every item', total === 5);
  check('per-key counts, dupes/junk ignored', counts.women === 2 && counts.men === 2 && counts.couples === 1 && counts.gay === 0);
  check('every key present', cats.CATEGORIES.every((k) => typeof counts[k.key] === 'number'));
  check('non-array input is empty', cats.countByCategory(null, () => []).total === 0);
}

section('public projection');
{
  const pub = toPublicCreator({ id: '1', name: 'A', categories: ['women', 'bogus', 'couples'], status: 'active' });
  check('categories are public (sanitised)', same(pub.categories, ['women', 'couples']));
  const none = toPublicCreator({ id: '2', name: 'B', status: 'active' });
  check('missing categories project as [] (never undefined)', same(none.categories, []));
  const junk = toPublicCreator({ id: '3', name: 'C', categories: { evil: true } });
  check('junk projects as []', same(junk.categories, []));
}

section('editor drafts');
{
  const d = draftFrom({ id: '1', name: 'A', categories: ['women', 'bogus'] });
  check('admin draft holds known keys', same(d.categories, ['women']));
  const base = draftFrom({ id: '1', name: 'A', categories: ['women'] });
  check('unchanged categories not sent', !('categories' in fieldsFromDraft({ ...base }, base).fields));
  const out = fieldsFromDraft({ ...base, categories: ['women', 'men'] }, base);
  check('changed categories sent as an array', same(out.fields.categories, ['women', 'men']));
  // A legacy stored value with an unknown key is not an edit.
  const legacy = draftFrom({ id: '1', categories: ['women', 'legacy'] });
  check('legacy junk not mistaken for an edit', !('categories' in fieldsFromDraft({ ...legacy }, draftFrom({ id: '1', categories: ['women'] })).fields));
  // Rebase: another tab changed categories while this draft edited them -> conflict.
  const r = rebaseDraft({ ...base, categories: ['men'] }, base, { id: '1', name: 'A', categories: ['gay'] });
  check('rebase flags a concurrent categories edit', r.conflicts.includes('categories'));
  const r2 = rebaseDraft({ ...base, name: 'Z' }, base, { id: '1', name: 'A', categories: ['gay'] });
  check('rebase takes an untouched field from the fresh record', same(r2.draft.categories, ['gay']) && r2.conflicts.length === 0);
  const dd = draftFromCreator({ categories: ['ai', 'x'] });
  check('dashboard draft holds known keys', same(dd.categories, ['ai']));
  check('dashboard payload carries categories', same(profileFieldsFromDraft(dd).fields.categories, ['ai']));
  check('dashboard draft of null creator', same(draftFromCreator(null).categories, []));
}

section('seed roster');
check('female demo is women, male demo is men', same(seedRoster.find((c) => c.id === 1).categories, ['women']) && same(seedRoster.find((c) => c.id === 2).categories, ['men']));

// ---------------------------------------------------------------------------
section('/api/me/profile');
await reset();
{
  const creator = await creators.createCreator({ name: 'Mia', handle: '@mia', status: 'active', bio: 'hello there' });
  const user = await users.createUser({ email: 'mia@cat.test', password: 'password123', role: 'creator', creatorId: creator.id });

  let res = await call(meProfileRoute, { user, body: { fields: { categories: ['Women', 'couples', 'bogus'] } } });
  check('saves known keys', res.statusCode === 200 && same(res.body.creator.categories, ['women', 'couples']), JSON.stringify(res.body));
  check('stored normalised', same((await stored(creator.id)).categories, ['women', 'couples']));

  res = await call(meProfileRoute, { user, body: { fields: { categories: 'gay' } } });
  check('comma string accepted', res.statusCode === 200 && same((await stored(creator.id)).categories, ['gay']));

  res = await call(meProfileRoute, { user, body: { fields: { categories: { women: true } } } });
  check('object refused with field', res.statusCode === 400 && res.body.field === 'categories');
  check('refusal changed nothing', same((await stored(creator.id)).categories, ['gay']));

  res = await call(meProfileRoute, { user, body: { fields: { categories: [1, 2] } } });
  check('array of numbers refused', res.statusCode === 400);

  res = await call(meProfileRoute, { user, body: { fields: { categories: ['women', 'men', 'gay', 'trans'] } } });
  check('more than 3 refused', res.statusCode === 400 && /up to 3/.test(res.body.error));

  res = await call(meProfileRoute, { user, body: { fields: { bio: 'hello there again' } } });
  check('unrelated save leaves categories', res.statusCode === 200 && same((await stored(creator.id)).categories, ['gay']));

  res = await call(meProfileRoute, { user, body: { fields: { categories: null } } });
  check('null clears', res.statusCode === 200 && same((await stored(creator.id)).categories, []));
}

section('/api/admin/profile and /api/admin/create');
await reset();
{
  const c = await creators.createCreator({ name: 'Ann', handle: '@ann', status: 'active' });
  let res = await call(adminProfileRoute, { admin: true, body: { creatorId: c.id, fields: { categories: 'lesbian, Women' } } });
  check('admin comma string saved', res.statusCode === 200 && same((await stored(c.id)).categories, ['lesbian', 'women']), JSON.stringify(res.body));
  res = await call(adminProfileRoute, { admin: true, body: { creatorId: c.id, fields: { categories: 12 } } });
  check('admin refuses a number', res.statusCode === 400 && same((await stored(c.id)).categories, ['lesbian', 'women']));
  res = await call(adminProfileRoute, { admin: true, body: { creatorId: c.id, fields: { categories: ['women', 'men', 'gay', 'ai'] } } });
  check('admin refuses more than 3', res.statusCode === 400);

  // Round trip through the panel's own draft helpers.
  const before = draftFrom(await creators.getCreatorById(c.id));
  const built = fieldsFromDraft({ ...before, categories: ['ai'] }, before);
  res = await call(adminProfileRoute, { admin: true, body: { creatorId: c.id, fields: built.fields } });
  check('panel round trip', res.statusCode === 200 && same(draftFrom(res.body.creator).categories, ['ai']));

  res = await call(adminCreateRoute, { admin: true, body: { categories: ['men', 'nope'] } });
  check('create stores categories', res.statusCode === 200 && same(res.body.creator.categories, ['men']), JSON.stringify(res.body));
  res = await call(adminCreateRoute, { admin: true, body: { categories: [{}] } });
  check('create refuses garbage and creates nothing', res.statusCode === 400 && (await query('select count(*)::int n from creators')).rows[0].n === 2);
}

section('/api/marketplace/list ?category=');
await reset();
{
  const w = await creators.createCreator({ name: 'W', handle: '@w', status: 'active', categories: ['women'] });
  const m = await creators.createCreator({ name: 'M', handle: '@m', status: 'active', categories: ['men', 'gay'] });
  const p = await creators.createCreator({ name: 'P', handle: '@p', status: 'pending', categories: ['women'] });
  for (const cr of [w, m, p]) {
    const l = await listings.createListing(cr.id, { title: `Set ${cr.name}`, priceCents: 500, kind: 'digital', unlimited: true });
    const src = media.mediaSrc(media.newMediaPathname({ purpose: 'listing', creatorId: cr.id, listingId: l.id, contentType: 'image/jpeg' }));
    await listings.addListingMedia(l.id, { type: 'image', src });
  }
  let res = await call(listRoute, { method: 'GET', query: {} });
  check('unfiltered lists visible sellers only', res.statusCode === 200 && res.body.listings.length === 2);
  check('listing carries seller categories', same(res.body.listings.find((l) => l.creatorName === 'M').creatorCategories, ['men', 'gay']));
  res = await call(listRoute, { method: 'GET', query: { category: 'women' } });
  check('?category=women filters (pending seller still hidden)', res.body.listings.length === 1 && res.body.listings[0].creatorName === 'W');
  res = await call(listRoute, { method: 'GET', query: { category: 'GAY' } });
  check('case-insensitive key', res.body.listings.length === 1 && res.body.listings[0].creatorName === 'M');
  res = await call(listRoute, { method: 'GET', query: { category: 'bogus' } });
  check('unknown category is no filter', res.statusCode === 200 && res.body.listings.length === 2);
  res = await call(listRoute, { method: 'GET', query: { category: ['couples'] } });
  check('empty category', res.statusCode === 200 && res.body.listings.length === 0);
  check('no media src leaks', JSON.stringify(res.body).indexOf('/api/media/') === -1);
}

await closePool();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
