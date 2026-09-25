/**
 * The fixed CATEGORY taxonomy for browsing creators and the marketplace
 * ("Women", "Men", "Couples", ...) -- the left-hand sidebar on /marketplace
 * and /creators, and a filter on /search.
 *
 * Categories are NOT tags. Tags are free text a creator types (up to 8,
 * lib/creator-status.js sanitizeTags); categories are a short closed list the
 * platform owns, so the sidebar never grows a long tail and every value can
 * be trusted in a URL (?category=women). A creator picks up to 3. Listings
 * have no category of their own: they inherit their seller's.
 *
 * Wording is deliberate: "Trans", never the slur some sites use for this
 * category -- it is offensive, and payment processors and ad networks flag it.
 *
 * Pure, no database import: used by React components (the dashboard's chip
 * picker, the admin editor, the browse sidebars) as well as the API routes.
 */

export const CATEGORIES = Object.freeze([
  Object.freeze({ key: 'women', label: 'Women' }),
  Object.freeze({ key: 'men', label: 'Men' }),
  Object.freeze({ key: 'couples', label: 'Couples' }),
  Object.freeze({ key: 'gay', label: 'Gay' }),
  Object.freeze({ key: 'lesbian', label: 'Lesbian' }),
  Object.freeze({ key: 'trans', label: 'Trans' }),
  Object.freeze({ key: 'nonbinary', label: 'Non-binary' }),
  Object.freeze({ key: 'ai', label: 'AI / Virtual' }),
]);

export const MAX_CATEGORIES = 3;

const KEYS = new Set(CATEGORIES.map((c) => c.key));
const LABELS = new Map(CATEGORIES.map((c) => [c.key, c.label]));

/** Whether `key` is one of the known category keys (exact, already normalised). */
export function isCategoryKey(key) {
  return typeof key === 'string' && KEYS.has(key);
}

/**
 * Normalises one raw value to a known key, or null. Case and surrounding
 * whitespace are forgiven ("  Women " -> 'women'); anything else is not
 * (no fuzzy matching -- an unknown value is dropped, not guessed at).
 */
export function normalizeCategoryKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return KEYS.has(key) ? key : null;
}

/**
 * A creator's categories as they may be stored: an array (the dashboard and
 * the admin editor send one) or a comma-separated string, reduced to known
 * keys, deduped, in the order given, at most MAX_CATEGORIES. Anything else --
 * null, a number, an object, an array of junk -- is []. Never throws.
 */
export function sanitizeCategories(value) {
  const raw = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  const out = [];
  for (const item of raw) {
    const key = normalizeCategoryKey(item);
    if (!key || out.includes(key)) continue;
    out.push(key);
    if (out.length >= MAX_CATEGORIES) break;
  }
  return out;
}

/** Display label for a key; an unknown key comes back as-is (never throws). */
export function categoryLabel(key) {
  return LABELS.get(key) || (typeof key === 'string' ? key : '');
}

/**
 * The category a browse page was asked for (?category=...), or null. Query
 * values can be arrays (?category=a&category=b) or anything else a visitor
 * types; only a single known key filters.
 */
export function categoryFromQuery(value) {
  const one = Array.isArray(value) ? value[0] : value;
  return normalizeCategoryKey(one);
}

/**
 * A stored record's categories, read defensively: what is on the row is
 * re-sanitised so a legacy or hand-edited value can never add an unknown key
 * to a sidebar or crash a filter.
 */
export function categoriesOf(creator) {
  return creator && typeof creator === 'object' ? sanitizeCategories(creator.categories) : [];
}

/** Whether a creator is in `category`. A null/empty category matches everyone. */
export function creatorInCategory(creator, category) {
  if (!category) return true;
  return categoriesOf(creator).includes(category);
}

/**
 * Per-category counts for a sidebar. `items` are whatever is being browsed
 * (creators, listings), ALREADY filtered by every other active filter -- that
 * is what makes the count faceted: it says how many results clicking the
 * category would show given everything else selected. `categoriesFor(item)`
 * returns that item's category keys (a listing's are its seller's).
 *
 * Returns { total, counts: { [key]: n } } with every known key present
 * (zero included), so the sidebar can list the whole taxonomy.
 */
export function countByCategory(items, categoriesFor) {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.key, 0]));
  let total = 0;
  for (const item of Array.isArray(items) ? items : []) {
    total += 1;
    const keys = sanitizeCategories(categoriesFor(item));
    for (const k of keys) counts[k] += 1;
  }
  return { total, counts };
}

/**
 * A profile write's `categories` field (/api/me/profile, /api/admin/profile,
 * /api/admin/create). Returns { value } with the list to store, or { error }.
 *
 * - null / '' clear it ([]).
 * - An array of strings, or a comma-separated string (the admin panel), is
 *   reduced to known keys; an unknown key is dropped, not guessed at.
 * - Any other TYPE (a number, an object, an array holding non-strings) is
 *   refused: it was not sent by either editor, and storing a guess would
 *   hide the bug that sent it.
 * - More than MAX_CATEGORIES known keys is refused rather than silently cut
 *   to the first three, which would drop the creator's later picks without a
 *   word. Both editors cap the chips at three, so only a hand-made request
 *   gets here.
 */
export function parseCategoriesInput(value) {
  if (value === null || value === undefined || value === '') return { value: [] };
  const isList = Array.isArray(value) && value.every((v) => typeof v === 'string');
  if (typeof value !== 'string' && !isList) {
    return { error: 'Categories must be a list of category names.' };
  }
  const raw = typeof value === 'string' ? value.split(',') : value;
  const known = new Set(raw.map(normalizeCategoryKey).filter(Boolean));
  if (known.size > MAX_CATEGORIES) {
    return { error: `Pick up to ${MAX_CATEGORIES} categories.` };
  }
  return { value: sanitizeCategories(raw) };
}

/**
 * The query string for the current page with `?category=` set to `key` (or
 * removed when `key` is falsy), every other parameter kept as it was -- so a
 * category link from a ?creator=/?listing= view, or a /search?q= query, stays
 * scoped. Returns '' or '?a=b...'. Pure (takes the current search string), so
 * the browse pages share it and it can be tested without a browser.
 */
export function withCategoryParam(search, key) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  const k = normalizeCategoryKey(key);
  if (k) params.set('category', k);
  else params.delete('category');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
