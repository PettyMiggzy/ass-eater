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
import { screenPublicText as screenPublicTextJs, detectProhibitedTerms as detectProhibitedTermsJs } from './site-screens/prohibited-terms.js';
import {
  detectPaymentCircumvention as detectPaymentCircumventionJs,
  normalizeForMatching as normalizeForMatchingJs,
} from './site-screens/payment-circumvention-filter.js';

// The JS default parameter (`context = null`) infers as `null`; this is the
// signature it actually has.
const screenPublicText = screenPublicTextJs as unknown as (text: string, opts: { context: string | null }) => ScreenHit | null;

type Detection = { flagged: boolean; reasons: string[] };
const detectProhibitedTerms = detectProhibitedTermsJs as unknown as (text: string) => Detection;
const detectPaymentCircumvention = detectPaymentCircumventionJs as unknown as (text: string, opts: { crossTag: boolean }) => Detection;
const normalizeForMatching = normalizeForMatchingJs as unknown as (text: string) => string;

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

/**
 * A creator's tag list, screened the way the site screens it
 * (lib/listings-store.js findCircumventionInTags): each tag on its own, then
 * the tags TOGETHER, so a prohibited phrase split across single-word tags
 * (["barely", "legal"]) or a handle split from its payment rail
 * (["venmo", "@janedoe"]) is refused too. The joined checks mirror the
 * site's steps 2 and 3b: prohibited phrases across runs of whole single-word
 * tags, and payment details across the raw tags joined by " | " in crossTag
 * mode (which does not read two unrelated category tags as a payment cue).
 */
export function assertCleanTags(tags: unknown) {
  if (!Array.isArray(tags)) return;
  const strings = tags.filter((t): t is string => typeof t === 'string' && t.length > 0);
  assertCleanText([['tag', strings]]);
  if (strings.length < 2) return;
  let run: string[] = [];
  const runs: string[][] = [];
  for (const t of strings) {
    const word = normalizeForMatching(t).trim().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (word && /^[a-z0-9]+$/.test(word)) run.push(word);
    else { if (run.length) runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  for (const r of runs) {
    if (r.length >= 2 && detectProhibitedTerms(r.join(' ')).flagged) throwHit('prohibited', 'tags');
  }
  if (detectPaymentCircumvention(strings.join(' | '), { crossTag: true }).flagged) throwHit('payment', 'tags');
}
