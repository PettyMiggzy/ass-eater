// The site's free-text screens, applied to what server/ publishes.
//
// site-screens/*.js are BYTE-IDENTICAL copies of the site's
// lib/prohibited-terms.js and lib/payment-circumvention-filter.js (plain ESM,
// no dependencies). Copied rather than imported across the repo because
// tsc's rootDir is src/ and the compiled dist/ must be self-contained;
// text-screen.test.ts fails the moment the two copies drift, so an edit to
// the site's lists has to be copied here in the same change.
//
// Without this, a bridged (or native) creator could publish text on server/
// -- a bio with a Cash App handle, a "teen" tag feeding GET /creators/tags --
// that the site refuses outright and logs as a violation.
import {
  screenPublicText as screenPublicTextJs, detectProhibitedTerms as detectProhibitedTermsJs, rawTagItems as rawTagItemsJs,
} from './site-screens/prohibited-terms.js';
import {
  detectPaymentCircumvention as detectPaymentCircumventionJs,
  normalizeForMatching as normalizeForMatchingJs,
  foldLookalikeLetters as foldLookalikeLettersJs,
  tagEndsWithPaymentCue as tagEndsWithPaymentCueJs,
} from './site-screens/payment-circumvention-filter.js';

// The JS default parameter (`context = null`) infers as `null`; this is the
// signature it actually has.
const screenPublicText = screenPublicTextJs as unknown as (text: string, opts: { context: string | null }) => ScreenHit | null;

type Detection = { flagged: boolean; reasons: string[] };
const detectProhibitedTerms = detectProhibitedTermsJs as unknown as (text: string) => Detection;
const detectPaymentCircumvention = detectPaymentCircumventionJs as unknown as (text: string, opts?: { crossTag: boolean }) => Detection;
const normalizeForMatching = normalizeForMatchingJs as unknown as (text: string) => string;
const foldLookalikeLetters = foldLookalikeLettersJs as unknown as (text: string) => string;
const tagEndsWithPaymentCue = tagEndsWithPaymentCueJs as unknown as (tag: string) => boolean;
const rawTagItems = rawTagItemsJs as unknown as (input: unknown) => string[];

export type ScreenHit = { kind: 'payment' | 'prohibited'; reasons: string[]; message: string };

/** Screens one value; null when clean. `context` 'handle'/'username' judges it as a name token. */
export function screenText(text: unknown, context: string | null = null): ScreenHit | null {
  if (typeof text !== 'string' || !text) return null;
  return screenPublicText(text, { context });
}

/**
 * Throws a 400 if any `[context, value]` entry (an array value is screened
 * item by item) is flagged. The global error handler answers
 * `{ error: 'prohibited_terms' | 'payment_circumvention' }`; `field` stays on
 * the error for logs. Call it before writing anything.
 */
export function assertCleanText(entries: Array<[string, unknown]>) {
  for (const [field, value] of entries) {
    if (Array.isArray(value)) {
      for (const v of value) assertCleanText([[field, v]]);
      continue;
    }
    // 'tag' is passed through: the site screens each tag with the strict
    // minor-age rule (a tag is a short label, not a sentence).
    const hit = screenText(value, field === 'username' || field === 'handle' || field === 'tag' ? field : null);
    if (hit) {
      throw Object.assign(new Error(hit.kind === 'prohibited' ? 'prohibited_terms' : 'payment_circumvention'), {
        statusCode: 400, field,
      });
    }
  }
}

function throwHit(kind: 'prohibited' | 'payment', field: string): never {
  throw Object.assign(new Error(kind === 'prohibited' ? 'prohibited_terms' : 'payment_circumvention'), {
    statusCode: 400, field,
  });
}

// The site's lib/creator-status.js sanitizeTags, applied to server/'s own
// limits (10 tags of 40 characters, as creators.ts PATCH /me accepts):
// lowercase, lookalike letters folded to the word the screens judged, every
// character but letters, digits, space and "-" dropped, whitespace folded,
// duplicates dropped. This is the form server/ STORES (creators.ts PATCH
// /me), so what is published is exactly what the cross-tag steps below read
// -- the same reason the site screens its stored form.
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 40;
export function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const folded = foldLookalikeLetters(item.toLowerCase())
      .replace(/[^\p{L}\p{N} -]+/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Cut by code point, never mid-surrogate (a lone surrogate fails the write).
    const tag = Array.from(folded).slice(0, MAX_TAG_LENGTH).join('').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// Digit-bearing words that name a category or a format, not an account (the
// site's DIGIT_CATEGORY_START_RE).
const DIGIT_CATEGORY_START_RE = /^(?:y2k|[1-9]k|[23]d|[0-9]0s|[0-9]{3,4}p|[0-9]{2,3}fps|18 ?plus)(?![0-9])/;

// The site's joinForPaymentScreen: stored tags joined by a space, except
// " | " at a boundary where the next tag's digit is all that makes it look
// like a handle ("tg" + "y2k", "snap" + "4k").
function joinForPaymentScreen(list: string[]): string {
  const bare = (tag: string) => normalizeForMatching(String(tag)).trim().replace(/^#+/, '');
  let out = '';
  list.forEach((tag, i) => {
    if (i > 0) {
      const prev = bare(list[i - 1]);
      const next = bare(tag);
      const shortWord = /^[a-z0-9]{1,5}$/.test(prev);
      const shortCategory = shortWord && /^[a-z0-9]{1,5}$/.test(next) && /[0-9]/.test(next) && /[a-z]/.test(next);
      out += shortCategory || DIGIT_CATEGORY_START_RE.test(next) ? ' | ' : ' ';
    }
    out += tag;
  });
  return out;
}

const isAlnum = (c: string) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
function trimToAlnum(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && !isAlnum(text[start])) start += 1;
  while (end > start && !isAlnum(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

// Maximal runs of adjacent single-word tags, as bare words (site singleWordRuns).
function singleWordRuns(list: string[]): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  for (const tag of list) {
    const word = trimToAlnum(normalizeForMatching(String(tag)).trim());
    if (word && /^[a-z0-9]+$/.test(word)) run.push(word);
    else { if (run.length) runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs;
}

/**
 * A creator's tag list, screened the way the site screens it -- a faithful
 * port of lib/listings-store.js findCircumventionInTags, step for step (see
 * the step comments there for why each boundary is read the way it is):
 *
 *  1. every tag on its own, raw and stored form, as a TAG (strict minor-age
 *     rule);
 *  2. prohibited phrases across runs of whole single-word tags
 *     (["barely", "legal"]), raw and stored;
 *  3. payment details across tags:
 *     a. the STORED tags joined by a space (joinForPaymentScreen), crossTag
 *        mode: "cash" + "app", "telegram" + "janedoe99";
 *     b. the RAW tags joined by " | ", crossTag mode: ["venmo", "@janedoe"];
 *     c. a stored tag that ENDS in a payment cue with the next tag's first
 *        two words, NORMAL mode: "pay me on" + "snapchat".
 *
 * "Stored" is sanitizeTags above -- exactly what PATCH /creators/me saves, so
 * the join reads the text that is published. Throws the same 400 as
 * assertCleanText.
 */
export function assertCleanTags(tags: unknown) {
  if (!Array.isArray(tags)) return;
  const strings = rawTagItems(tags);
  if (!strings.length) return;
  const stored = sanitizeTags(tags);
  assertCleanText([['tag', [...strings, ...stored]]]);
  for (const list of [strings, stored]) {
    for (const r of singleWordRuns(list)) {
      if (r.length >= 2 && detectProhibitedTerms(r.join(' ')).flagged) throwHit('prohibited', 'tags');
    }
  }
  if (stored.length >= 2 && detectPaymentCircumvention(joinForPaymentScreen(stored), { crossTag: true }).flagged) throwHit('payment', 'tags');
  if (strings.length >= 2 && detectPaymentCircumvention(strings.join(' | '), { crossTag: true }).flagged) throwHit('payment', 'tags');
  for (let i = 0; i + 1 < stored.length; i += 1) {
    if (!tagEndsWithPaymentCue(stored[i])) continue;
    const head = stored[i + 1].split(' ').slice(0, 2).join(' ');
    if (detectPaymentCircumvention(`${stored[i]} ${head}`).flagged) throwHit('payment', 'tags');
  }
}
