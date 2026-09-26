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
 * GLUED COMPOUNDS ARE A SECOND TIER. Tags and handles are written as one run
 * of letters by convention ("teenpussy", "@hotteen", "sexyschoolgirl"), and
 * sanitizeTags even strips the "#"/"@"/"." that would separate them, so a
 * word-only match let every prohibited term through as long as it was glued
 * to another word. Terms marked `compound: true` also match INSIDE a run of
 * letters. Most of them have no innocent word that contains them (jailbait,
 * schoolgirl, underage, incest...). The few that do -- "teen" (eighteen,
 * canteen), "rape" (grape, scrape, therapeutic), "loli" (lolipop), "ageplay"
 * (stageplay) -- are matched inside a compound only after the words in
 * COMPOUND_ALLOWLIST below are blanked out, so honest text stays clean.
 * Deliberately NOT compound: "shota" (headshotart, snapshotapp, the name
 * Shotaro), "pedo" (torpedo, speedo, pedometer), "noncon" (nonconformist),
 * "tween" (between) and the spaced phrases ("under age" would match
 * "thunder ages"); their glued forms that matter (shotacon, pedophile,
 * nonconsent, underage) are compound entries of their own. "teeny" is
 * flagged: it is a common minor-suggestive category name, and the accepted
 * cost is that "teeny bikini" is refused too.
 *
 * Pure: no database import, so it is safe anywhere.
 */
import { detectPaymentCircumvention, normalizeForMatching, PAYMENT_CIRCUMVENTION_MESSAGE } from './payment-circumvention-filter.js';

const PROHIBITED_TERMS = [
  // Minor-suggestive. Card-network rules and every adult processor ban
  // content that depicts or suggests a minor, including in role-play, tags
  // and titles -- whatever the performer's real age.
  { term: 'teen', compound: true, category: 'minor-suggestive' },
  { term: 'teenage', category: 'minor-suggestive' },
  { term: 'teenager', category: 'minor-suggestive' },
  { term: 'preteen', compound: true, category: 'minor-suggestive' },
  { term: 'pre teen', category: 'minor-suggestive' },
  { term: 'tween', category: 'minor-suggestive' },
  { term: 'underage', compound: true, category: 'minor-suggestive' },
  { term: 'under age', category: 'minor-suggestive' },
  { term: 'jailbait', compound: true, category: 'minor-suggestive' },
  { term: 'jail bait', category: 'minor-suggestive' },
  { term: 'barely legal', compound: true, category: 'minor-suggestive' },
  { term: 'schoolgirl', compound: true, category: 'minor-suggestive' },
  { term: 'school girl', category: 'minor-suggestive' },
  { term: 'schoolboy', compound: true, category: 'minor-suggestive' },
  { term: 'school boy', category: 'minor-suggestive' },
  { term: 'little girl', category: 'minor-suggestive' },
  { term: 'little boy', category: 'minor-suggestive' },
  { term: 'loli', compound: true, category: 'minor-suggestive' },
  { term: 'lolita', compound: true, category: 'minor-suggestive' },
  { term: 'lolicon', compound: true, category: 'minor-suggestive' },
  { term: 'shota', category: 'minor-suggestive' },
  { term: 'shotacon', compound: true, category: 'minor-suggestive' },
  { term: 'age play', category: 'minor-suggestive' },
  { term: 'ageplay', compound: true, category: 'minor-suggestive' },
  { term: 'pedo', category: 'minor-suggestive' },
  { term: 'pedophile', compound: true, category: 'minor-suggestive' },
  { term: 'paedophile', compound: true, category: 'minor-suggestive' },
  // The noun forms, and the British short form. "-philia" has no innocent
  // word around it, so both are compound; "paedo" is word-tier like "pedo".
  { term: 'pedophilia', compound: true, category: 'minor-suggestive' },
  { term: 'paedophilia', compound: true, category: 'minor-suggestive' },
  { term: 'paedo', category: 'minor-suggestive' },
  { term: 'child porn', compound: true, category: 'minor-suggestive' },
  // "pre-teen hardcore", a CSAM search term with no other meaning.
  { term: 'pthc', category: 'minor-suggestive' },
  // Non-consent and the other categories card-network rules prohibit outright.
  { term: 'rape', compound: true, category: 'non-consensual' },
  // The inflections of "rape" that drop its final "e" never match "rape"
  // plus a suffix. Word tier only: as compounds, "rapist" is inside
  // "therapist" and "raping" inside "draping"/"scraping".
  { term: 'raping', category: 'non-consensual' },
  { term: 'rapist', category: 'non-consensual' },
  { term: 'molest', category: 'non-consensual' },
  // The allowed suffixes (s/es/ed/er/ers/ing) do not reach the noun.
  { term: 'molestation', category: 'non-consensual' },
  { term: 'noncon', category: 'non-consensual' },
  { term: 'non con', category: 'non-consensual' },
  { term: 'nonconsent', compound: true, category: 'non-consensual' },
  { term: 'non consent', category: 'non-consensual' },
  { term: 'nonconsensual', compound: true, category: 'non-consensual' },
  { term: 'non consensual', category: 'non-consensual' },
  { term: 'incest', compound: true, category: 'incest' },
  { term: 'incestuous', category: 'incest' },
  { term: 'bestiality', compound: true, category: 'bestiality' },
  // The common misspelling.
  { term: 'beastiality', compound: true, category: 'bestiality' },
  { term: 'zoophilia', compound: true, category: 'bestiality' },
  { term: 'zoophile', compound: true, category: 'bestiality' },
  { term: 'necrophilia', compound: true, category: 'necrophilia' },
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

// Tier two: the glued spelling of a `compound` term, matched anywhere inside
// a run of letters. Contiguous only -- the spaced-out spellings are the word
// tier's job, and a multi-word phrase only counts glued ("barelylegal"),
// never across a space. The digit swaps are narrower than LEET: with no word
// boundary, "1" for "l"/"i" turned "hello11" and "yolo11" into "loli", so
// only the swaps that do not read as an ordinary number suffix stay.
const COMPOUND_LEET = { a: '[a4@]', e: '[e3]', o: '[o0]', s: '[s5$]', t: '[t7]' };
function buildCompoundRe({ term }) {
  const body = term.split(' ').map((w) => [...w].map((ch) => COMPOUND_LEET[ch] || ch).join('')).join('');
  return new RegExp(body, 'g');
}
const COMPILED_COMPOUND = PROHIBITED_TERMS.filter((t) => t.compound).map((t) => ({ ...t, re: buildCompoundRe(t) }));

// Ordinary words that contain a compound term. Blanked out of the text before
// the compound tier runs (the word tier never needs this: its boundaries
// already refuse a term with a letter on either side). Matched as substrings,
// so "grape" also covers "grapefruit" and "grapes", "scrape" covers
// "skyscraper", "nineteen" covers "nineteenth". Add to it here, with the term
// it protects, when an honest word turns out to be refused.
const COMPOUND_ALLOWLIST = [
  // "teen"
  'eighteen', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'nineteen', 'umpteen',
  'canteen', 'sateen', 'velveteen', 'poteen', 'teensy', 'kirsteen', 'kristeen', 'christeen',
  // ...and real names that contain it: the surname Steen (Steenbergen,
  // Vansteenkiste, and Kirsteen above), the given names Mateen and Justeen.
  // Accepted cost: "hotsteen" reads as a name, "hotteen" is still refused.
  'steen', 'mateen', 'justeen', 'pristeen',
  // "rape"
  'grape', 'drape', 'scrape', 'crape', 'trapez', 'rapeseed', 'therapeu', 'parape', 'sarape', 'serape',
  // ...and the Spanish/Portuguese/Italian "terapeuta"/"terapeutico", and
  // "frapé" (NFKD folds it to "frape"). "rapero"/"rapera" (Spanish for
  // rapper) are NOT substrings here -- "raperoleplay" would blank to
  // "leplay" -- they are whole-word entries in NAME_ALLOWLIST_RE below.
  'terapeu', 'frape',
  // "loli"
  'lolipop',
  // ...and Hololive, the VTuber agency: one of the most common cosplay tags.
  // A glued evasion is still caught -- "hololiveloli" blanks to "loli".
  'hololive',
  // "ageplay"
  'stageplay',
];
const COMPOUND_ALLOWLIST_RE = new RegExp(COMPOUND_ALLOWLIST.join('|'), 'g');
// Names that START with a compound term, where a substring allowlist entry
// would open a hole ("teena" as a substring would also blank the start of
// "teenass"). So these are blanked only in the position the name takes:
//   - "Teena"/"Teenah" only as a whole word,
//   - the Thai given-name prefix "Rapee-" (Rapeepat, Rapeeporn) only at the
//     start of a word, and only those five letters -- anything glued on after
//     it is still screened ("rapeeteen" is still "teen"),
//   - Spanish "rapero"/"rapera" (rapper) only as a whole word.
const NAME_ALLOWLIST_RE = /(?<![a-z])(?:teenah?(?![a-z])|rapee(?=[a-z])|raper[oa]s?(?![a-z]))/g;

// An explicit under-18 self-description. Numbers are not letters, so none of
// the word lists above can express this; it is a word-tier rule of its own.
// Deliberately narrow, because the obvious broad version refuses ordinary
// adult text (round-3 and round-4 review):
//   - "under 18" is NOT screened at all. On an adult platform it is almost
//     always the exclusion disclaimer ("if you're under 18, leave", "minors
//     (under 18) not allowed", "under 18s not welcome"), and no negation list
//     keeps up with real phrasing.
//   - Only ages 10-17, as digits or spelled out (ten..seventeen). "my 2 year
//     old cat" and "3 years old page anniversary" are not about a person.
//   - The short form with digits ("15yo", "16 y/o", "17 y.o.") matches on its
//     own only where it reads as a label about a person: standing alone (a
//     tag, the start of a sentence, after punctuation) or after a descriptive
//     word ("hot 16yo", "new 17yo set"). After any other word ("Macallan
//     12yo", "Toyota 12yo", "Top 10 yo mama jokes") it does not -- whisky
//     ages, car ages and "yo mama" were refused and logged as minor content.
//     It never matches before "mama". Spelled numbers get no bare short form
//     at all ("ten yo" is too easily something else).
//   - The long forms ("15 years old", "seventeen-year-old") match only as a
//     self-description or in front of a person noun ("17-year-old girl") --
//     "my dog is 12 years old" is fine. A self-description may also end the
//     sentence with just the number ("i'm seventeen", "aged 16."), but never
//     with more words after it ("i'm fifteen minutes away").
//   - The self-description lead-ins are about a PERSON: i'm / she's / he's /
//     aged / just turned / i|she|he turned. A bare "turned" matched any
//     subject ("my blog turned 15 years old"), and nothing matches ahead of a
//     drink or food it describes ("aged 12 years old single malt").
const MINOR_AGE_NUM = '(?:(?<![0-9])1[0-7]|(?<![a-z])(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen))';
const MINOR_AGE_DIGITS = '(?<![0-9])1[0-7]';
const NOT_A_DRINK = '(?![\\s,-]{0,3}(?:single|malt|scotch|whisk|bourbon|rum|port|wine|cheddar|cheese|balsamic|cask|reserve|bottle))';
const MINOR_SHORT_AGE = '[\\s-]{0,2}(?:y\\s?\\/\\s?o|y\\.\\s?o\\b\\.?|yo)(?![a-z])(?!\\s*mama)' + NOT_A_DRINK;
const MINOR_ANY_AGE = '[\\s-]{0,2}(?:y\\s?\\/\\s?o|y\\.\\s?o\\b\\.?|yo|yrs?[\\s-]{0,2}old|years?[\\s-]{0,2}old)(?![a-z])(?!\\s*mama)' + NOT_A_DRINK;
const SELF_LEAD = "(?<![a-z])(?:i'?m|i am|she'?s|she is|he'?s|he is|aged?|just turned|(?:i|she|he)(?:\\s+just)?\\s+turned)(?:\\s+[a-z]+){0,2}[\\s:,-]{1,3}";
// Words that make a bare "16yo" a label for a person rather than the age of
// a thing. Left of the number, one word.
const PERSON_ADJ = '(?:hot|sexy|cute|horny|naughty|young|tiny|petite|new|real|sweet|little|innocent|slutty|busty|shy|nude|naked|pretty|skinny|thick|curvy)';
// A bare determiner ("my 15yo", "a 16 y/o") says nothing about WHAT is that
// age -- "me and my 12yo dog", "my 15 y/o car still runs", "proud owner of a
// 13 yo husky" were refused and logged as minor content, the most serious
// category there is. So after a determiner the short form counts only when
// the next word is an animal or a thing from THING_NOUN, optionally after ONE
// word from the fixed THING_MODIFIER list ("my 12yo golden retriever").
// "my 15yo girlfriend", "a 16yo" at the end of a line and "the 17yo next
// door" are still refused.
//   - The middle slot is a fixed list, never "any word": an open slot let a
//     sexual noun ride in front of an innocent one ("my 15yo slut house",
//     "our 14yo babe account", "my 16yo pussy cat").
//   - THING_NOUN leaves out every animal word that is also sexual or petplay
//     slang -- pet, kitty, kitten, bunny, pony -- and "home" ("my 15yo home
//     alone"). "my 16yo pet"/"a 16yo kitty" stay refused; the accepted cost is
//     that an honest "my 12yo kitten" is refused too and has to be reworded.
const DETERMINER = '(?:my|our|your|her|his|a|an|the)';
const THING_MODIFIER = '(?:golden|german|australian|labrador|old|used|rescue|family|black|white|brown|grey|gray|red|blue|silver|yellow|orange)';
const THING_NOUN = '(?:dogs?|doggos?|pups?|puppy|puppies|cats?|horses?|birds?|parrots?|fish|hamsters?|rabbits?|husky|huskies|retrievers?|labs?|labrador|poodles?|pugs?|chihuahuas?|terriers?|shepherds?|beagles?|bulldogs?|cars?|trucks?|jeeps?|bikes?|motorcycles?|vans?|laptops?|computers?|pc|phones?|iphones?|tvs?|house|channel|page|blog|business|brand|company|shop|store|plants?|trees?|guitars?|camera|account)';
const NOT_A_THING = '(?![\\s-]{1,3}(?:' + THING_MODIFIER + '[\\s-]{1,2})?' + THING_NOUN + '(?![a-z]))';
const MINOR_AGE_RES = [
  // Short form, digits only: alone / after punctuation, or after a descriptive word.
  new RegExp('(?:^|[^a-z0-9\\s]\\s*|(?<![a-z])' + PERSON_ADJ + '[\\s-]{1,2})' + MINOR_AGE_DIGITS + MINOR_SHORT_AGE),
  // ...or after a bare determiner, unless an animal or a thing follows.
  new RegExp('(?<![a-z])' + DETERMINER + '[\\s-]{1,2}' + MINOR_AGE_DIGITS + MINOR_SHORT_AGE + NOT_A_THING),
  // Self-description with an age word after the number ("i'm only 16 years old").
  new RegExp(SELF_LEAD + MINOR_AGE_NUM + MINOR_ANY_AGE),
  // Self-description ending on the number itself ("im seventeen", "aged 16.").
  new RegExp(SELF_LEAD + MINOR_AGE_NUM + '(?=\\s*(?:$|[.!?;,)]))'),
  // In front of a person noun ("17-year-old girl", "sixteen year old schoolgirl").
  new RegExp(MINOR_AGE_NUM + MINOR_ANY_AGE + '[\\s-]{1,2}(?:girls?|boys?|teens?|schoolgirls?|schoolboys?|students?|virgins?|kids?|daughters?|sons?|nieces?|nephews?|babysitters?)(?![a-z])'),
];

// Stretched letters ("teeen", "teeeeen") are an evasion of every word above.
// Three or more of one letter fold to two before matching; no term here has a
// tripled letter, and ordinary words keep their doubled ones.
function foldStretched(text) {
  return text.replace(/([a-z])\1{2,}/g, '$1$1');
}

/**
 * `{ flagged, reasons }`, same shape as detectPaymentCircumvention so callers
 * and the violations queue treat both the same way.
 */
export function detectProhibitedTerms(text) {
  const normalized = foldStretched(normalizeForMatching(text));
  const reasons = [];
  if (!normalized) return { flagged: false, reasons };
  const add = (term, category) => {
    const reason = `prohibited term (${category}): "${term}"`;
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  for (const { term, category, re } of COMPILED) {
    const m = normalized.match(re);
    // A term still has to contain a real letter -- "7337" is a number.
    if (m && /[a-z]/.test(m[0])) add(term, category);
  }
  // Curly apostrophes (the iOS default) read as straight ones for the
  // self-description lead-ins.
  const ageText = normalized.replace(/[\u2018\u2019\u02bc]/g, "'");
  if (MINOR_AGE_RES.some((re) => re.test(ageText))) add('under-18 age', 'minor-suggestive');
  const masked = normalized.replace(NAME_ALLOWLIST_RE, ' ').replace(COMPOUND_ALLOWLIST_RE, ' ');
  for (const { term, category, re } of COMPILED_COMPOUND) {
    for (const m of masked.matchAll(re)) {
      if (/[a-z]/.test(m[0])) {
        add(term, category);
        break;
      }
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
    if (!(key in fields) || typeof fields[key] !== 'string' || fields[key] === '') continue;
    // The handle is screened WITHOUT its leading "@". It is this creator's
    // handle ON THIS platform, and the payment filter reads any "@word" near
    // a contact-app name as a handover to that app -- so "@snap_queen" was
    // refused (and logged as fee-dodging) for pointing at itself. The body is
    // judged the way the same words in a display name are.
    const value = key === 'handle' ? fields[key].replace(/^@+/, '') : fields[key];
    if (value) out.push([key, value]);
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
