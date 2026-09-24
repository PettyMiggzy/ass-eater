/**
 * Terms that may not appear in any public free-text field a creator (or a fan
 * choosing a public username) writes: display name, handle, bio, location,
 * price text, tags, social handles, and marketplace listing copy.
 *
 * WHY THIS EXISTS. Tags in particular become public chips, a /search?tag=
 * page and an entry in the site-wide "Browse by tag" cloud with no re-review
 * after approval. Adult payment processors and the card-network content
 * rules they enforce require a platform to block minor-suggestive and a short
 * list of other prohibited content categories OUTRIGHT, not to moderate them
 * after the fact -- one "teen" tag in the public cloud is the kind of thing
 * that ends a processor relationship on review.
 *
 * THE LIST IS CONSERVATIVE ON PURPOSE. Every term here is one that has no
 * innocent reading on an adult platform. Words that are ordinary English as
 * well ("young", "minor", "kid", "petite", "daddy") are deliberately NOT here:
 * they would block honest bios ("minor edits", "no kids on set") and log
 * innocent creators to the violations queue, and a queue full of false hits
 * is one moderators stop reading. The owner / counsel own the final list;
 * add to it here, one entry per line, with the category it belongs to.
 *
 * Matching uses the same normalisation as the payment-circumvention filter
 * (lookalike letters folded, zero-width characters stripped, accents dropped)
 * plus digit-for-letter spellings ("t33n") and words spelled with EVERY
 * letter spaced apart ("t e e n", "t-e-e-n") -- never a partial spacing, so
 * "I shot a new set" is not "shota". A term must be a WORD: "eighteen", "canteen" and
 * "grape" do not contain the terms "teen" and "rape".
 *
 * Pure: no database import, so it is safe anywhere.
 */
import { detectPaymentCircumvention, normalizeForMatching, PAYMENT_CIRCUMVENTION_MESSAGE } from './payment-circumvention-filter.js';

const PROHIBITED_TERMS = [
  // Minor-suggestive. Card-network rules and every adult processor ban
  // content that depicts or suggests a minor, including in role-play, tags
  // and titles -- whatever the performer's real age.
  { term: 'teen', category: 'minor-suggestive' },
  { term: 'teenage', category: 'minor-suggestive' },
  { term: 'teenager', category: 'minor-suggestive' },
  { term: 'preteen', category: 'minor-suggestive' },
  { term: 'pre teen', category: 'minor-suggestive' },
  { term: 'tween', category: 'minor-suggestive' },
  { term: 'underage', category: 'minor-suggestive' },
  { term: 'under age', category: 'minor-suggestive' },
  { term: 'jailbait', category: 'minor-suggestive' },
  { term: 'barely legal', category: 'minor-suggestive' },
  { term: 'schoolgirl', category: 'minor-suggestive' },
  { term: 'school girl', category: 'minor-suggestive' },
  { term: 'schoolboy', category: 'minor-suggestive' },
  { term: 'school boy', category: 'minor-suggestive' },
  { term: 'little girl', category: 'minor-suggestive' },
  { term: 'little boy', category: 'minor-suggestive' },
  { term: 'loli', category: 'minor-suggestive' },
  { term: 'lolita', category: 'minor-suggestive' },
  { term: 'lolicon', category: 'minor-suggestive' },
  { term: 'shota', category: 'minor-suggestive' },
  { term: 'shotacon', category: 'minor-suggestive' },
  { term: 'age play', category: 'minor-suggestive' },
  { term: 'ageplay', category: 'minor-suggestive' },
  { term: 'pedo', category: 'minor-suggestive' },
  { term: 'pedophile', category: 'minor-suggestive' },
  { term: 'child porn', category: 'minor-suggestive' },
  // Non-consent and the other categories card-network rules prohibit outright.
  { term: 'rape', category: 'non-consensual' },
  { term: 'noncon', category: 'non-consensual' },
  { term: 'non con', category: 'non-consensual' },
  { term: 'nonconsent', category: 'non-consensual' },
  { term: 'non consent', category: 'non-consensual' },
  { term: 'nonconsensual', category: 'non-consensual' },
  { term: 'non consensual', category: 'non-consensual' },
  { term: 'incest', category: 'incest' },
  { term: 'incestuous', category: 'incest' },
  { term: 'bestiality', category: 'bestiality' },
  { term: 'zoophilia', category: 'bestiality' },
  { term: 'necrophilia', category: 'necrophilia' },
];

// Digit/symbol-for-letter spellings. Narrower than the payment filter's leet
// map on purpose: "!" and "|" are left out, because "lol!" must not read as
// "loli".
const LEET = { a: '[a4@]', b: '[b8]', e: '[e3]', g: '[g9]', i: '[i1]', l: '[l1]', o: '[o0]', s: '[s5$]', t: '[t7]', z: '[z2]' };
// A word matches in one of two spellings, never a mix of them:
//   - contiguous, with digit-for-letter swaps ("teen", "t33n"), or
//   - FULLY spaced out, one or two separator characters after every letter
//     but the last ("t e e n", "t.e.e.n", "T-E-E-N").
// Allowing an optional gap between ANY two letters let a term match across
// an ordinary word break -- "I shot a new video" read as "shota", "lol i
// love this" as "loli", "rap e" as "rape" -- refusing honest bios and logging
// the creator under the most serious category in the moderation queue. A
// half-spaced evasion ("te en") is the accepted miss.
// Between the words of a phrase, up to three separators ("barely-legal",
// "barely  legal", "barelylegal").
const LETTER_SEP = '[^a-z0-9]{1,2}';
const WORD_GAP = '[^a-z0-9]{0,3}';

function wordPattern(word) {
  const letters = [...word].map((ch) => LEET[ch] || ch);
  if (letters.length < 2) return letters.join('');
  return `(?:${letters.join('')}|${letters.join(LETTER_SEP)})`;
}

function buildRe({ term }) {
  const body = term.split(' ').map(wordPattern).join(WORD_GAP);
  // Plural/verb suffixes stay matched ("teens"); an adjacent LETTER breaks the
  // match so "eighteen", "canteen" and "grape" never do.
  return new RegExp(`(?<![a-z])${body}(?:s|es|ed|er|ers|ing)?(?![a-z])`);
}

const COMPILED = PROHIBITED_TERMS.map((t) => ({ ...t, re: buildRe(t) }));

/**
 * `{ flagged, reasons }`, same shape as detectPaymentCircumvention so callers
 * and the violations queue treat both the same way.
 */
export function detectProhibitedTerms(text) {
  const normalized = normalizeForMatching(text);
  const reasons = [];
  if (!normalized) return { flagged: false, reasons };
  for (const { term, category, re } of COMPILED) {
    const m = normalized.match(re);
    // A term still has to contain a real letter -- "7337" is a number.
    if (m && /[a-z]/.test(m[0])) {
      const reason = `prohibited term (${category}): "${term}"`;
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  return { flagged: reasons.length > 0, reasons };
}

export const PROHIBITED_TERMS_MESSAGE =
  "That wasn't saved -- it contains a term that isn't allowed anywhere on this platform (content that suggests a minor, non-consent, incest or bestiality). Remove it and try again.";

/**
 * Runs BOTH public-text checks on one value. Returns null when it is clean,
 * otherwise `{ kind: 'payment' | 'prohibited', reasons, message }`.
 *
 * Prohibited terms are checked first: they are the more serious of the two,
 * and the one the admin queue most needs to see labelled correctly.
 */
export function screenPublicText(text) {
  if (text === null || text === undefined || text === '') return null;
  const prohibited = detectProhibitedTerms(text);
  if (prohibited.flagged) {
    return { kind: 'prohibited', reasons: prohibited.reasons, message: PROHIBITED_TERMS_MESSAGE };
  }
  const payment = detectPaymentCircumvention(text);
  if (payment.flagged) {
    return { kind: 'payment', reasons: payment.reasons, message: PAYMENT_CIRCUMVENTION_MESSAGE };
  }
  return null;
}

/**
 * Every public free-text value on a creator profile, as `[context, value]`
 * pairs, ready for screenPublicText. `context` is what the violations queue
 * records and what an admin-facing error names. Only keys present in
 * `fields` are returned, so a partial update screens only what it writes.
 */
export function publicProfileTextEntries(fields) {
  const out = [];
  if (!fields) return out;
  for (const key of ['name', 'handle', 'bio', 'location', 'price']) {
    if (key in fields && typeof fields[key] === 'string' && fields[key] !== '') out.push([key, fields[key]]);
  }
  if (Array.isArray(fields.tags)) {
    for (const tag of fields.tags) if (typeof tag === 'string' && tag) out.push(['tag', tag]);
  }
  if (fields.socials && typeof fields.socials === 'object') {
    for (const [k, v] of Object.entries(fields.socials)) {
      if (typeof v === 'string' && v) out.push([`social_${k}`, v]);
    }
  }
  return out;
}

/**
 * The tag items exactly as typed, before sanitizeTags strips "@", "$" and "."
 * out of them. Screened as well as the stored form: stripping punctuation
 * turns "555.123.4567" into a bare digit run the phone check (rightly) lets
 * through without a cue, so the raw text is the one that still shows what was
 * meant.
 */
export function rawTagItems(input) {
  const raw = typeof input === 'string' ? input.split(',') : Array.isArray(input) ? input : [];
  return raw.filter((t) => typeof t === 'string' && t.trim()).slice(0, 50).map((t) => t.trim().slice(0, 100));
}
