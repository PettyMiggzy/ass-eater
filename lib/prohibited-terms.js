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
import { detectPaymentCircumvention, normalizedReadings, PAYMENT_CIRCUMVENTION_MESSAGE } from './payment-circumvention-filter.js';

// The join between a child word and a content word ("child porn", "kid-porn",
// "kid_porn", "kid.porn", "kid  porn"): spaces or tabs on ONE line, or a
// single glued "_" "." "-". Never punctuation plus a space, and never a line
// break: that is a sentence boundary, and "Mom of 3 kids. Nudes 20", "No kids
// - porn only" and "Mom of 2 kids" + newline + "Nudes 20" are ordinary bios
// (round-20 fix-up: the first version joined across any three of
// "\s _ . -" and refused them under the most serious category). The original
// "child porn" term keeps its wider WORD_GAP ("child/porn", "child*porn"), as
// it always had: it predates the groups and is not narrowed.
const CHILD_PAIR_GAP = '(?:[ \\t]{0,3}|[_.-])';

const PROHIBITED_TERMS = [
  // Minor-suggestive. Card-network rules and every adult processor ban
  // content that depicts or suggests a minor, including in role-play, tags
  // and titles -- whatever the performer's real age.
  { term: 'teen', compound: true, category: 'minor-suggestive' },
  { term: 'teenage', category: 'minor-suggestive' },
  { term: 'teenager', category: 'minor-suggestive' },
  // The diminutives, as words of their own: the compound tier already reads
  // "teen" inside them, but name mode (handles, usernames) does not run that
  // tier, so a bare "@teeny" published (round-13 accounts#0).
  { term: 'teeny', category: 'minor-suggestive' },
  { term: 'teenie', category: 'minor-suggestive' },
  { term: 'preteen', compound: true, category: 'minor-suggestive' },
  { term: 'pre teen', category: 'minor-suggestive' },
  // Plural only: with the verb suffixes, "tweening"/"tweened" (the animation
  // terms -- 2D/3D animators are a real creator niche) were refused and logged
  // as minor content (round-10 accounts#3).
  { term: 'tween', suffixes: '(?:s)?', category: 'minor-suggestive' },
  // `disclaimable`: skipped when a negation or disclaimer sits right next to
  // it ("18+ only, no underage", "I'm not underage", "are you underage?") --
  // the same reason "under 18" is not screened at all (see MINOR_AGE_RES).
  // "underage girl" is still refused. See isDisclaimed.
  { term: 'underage', compound: true, disclaimable: true, category: 'minor-suggestive' },
  { term: 'under age', disclaimable: true, category: 'minor-suggestive' },
  // "under-aged", "under aged": the allowed suffixes never make "age" into
  // "aged", so only the glued "underaged" was caught (round-10 accounts#2).
  { term: 'under aged', disclaimable: true, category: 'minor-suggestive' },
  { term: 'jailbait', compound: true, category: 'minor-suggestive' },
  { term: 'jail bait', category: 'minor-suggestive' },
  { term: 'barely legal', compound: true, category: 'minor-suggestive' },
  { term: 'schoolgirl', compound: true, category: 'minor-suggestive' },
  { term: 'school girl', category: 'minor-suggestive' },
  { term: 'schoolboy', compound: true, category: 'minor-suggestive' },
  { term: 'school boy', category: 'minor-suggestive' },
  // Round 19 (accounts#5): the one-word "highschool" (and middle school,
  // junior high) paired with a person or sexual word. "high school girl"
  // matched "school girl" but "highschool girl" matched nothing. Built below
  // (SCHOOL_PAIR_LEADS): the glued forms are compound and name-safe.
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
// "sex" in a pair is never sex education, or the abuse / trafficking words a
// survivor or an advocate writes ("child sex abuse survivor", "my high school
// sex ed teacher").
const SEX_EDUCATION_AFTER = '(?![^a-z0-9]{0,3}(?:ed|education|educator|abuse|abused|abuser|trafficking|offenders?|crimes?|predators?|assault|exploitation|survivors?)(?![a-z]))';
// Round 20 (accounts#9): also the person nouns "high schooler(s)" / "middle
// schooler(s)" and the abbreviation "jr high" ("high schooler slut", "jr high
// girl"). A bare "high schooler" is not a term: in free text it is how an
// adult describes a past self or a family member.
const SCHOOL_PAIR_LEADS = ['high school', 'middle school', 'junior high', 'jr high', 'high schooler', 'high schoolers',
  'middle schooler', 'middle schoolers'];
const SCHOOL_PAIR_WORDS = ['girl', 'boy', 'slut', 'whore', 'babe', 'virgin', 'gf', 'bf', 'sis', 'twink', 'daughter', 'porn', 'sex',
  'nudes', 'nude', 'pussy', 'cum', 'fuck', 'horny', 'naked', 'bitch', 'hoe', 'cheerleader', 'teen'];
// Round 20 (accounts#1): the words with an ordinary REMINISCING reading --
// "married my high school bf", "still with my high school gf", "former high
// school cheerleader, now 30", "our high school babe reunion". In FREE text
// only, a spaced pair with one of these words is skipped when a possessive or
// "former"/"ex" sits right in front of it (see isSchoolReminiscence); in a
// tag or a name, and glued ("highschoolbf"), it is still refused. The other
// words ("high school slut", "high school girl", "high school nudes") are
// refused everywhere whatever precedes them.
const SCHOOL_SOFT_WORDS = new Set(['gf', 'bf', 'cheerleader', 'sex', 'babe', 'sis']);
// One entry per LEAD with its words as one alternation (a pair "group"),
// rather than one regex per pair: the lists below are a few hundred pairs,
// and every term runs on every public text. The reason names the pair that
// matched ("high school gf"). See pairWordOf.
// `openStart`: matched after any letters too ("16andhighschool girl",
// "hothighschool girl") -- no ordinary word ends in "high" before "school".
// "sex" is never "sex ed" / "sex education" ("my high school sex ed teacher").
for (const lead of SCHOOL_PAIR_LEADS) {
  PROHIBITED_TERMS.push({
    term: lead,
    words: SCHOOL_PAIR_WORDS,
    softWords: SCHOOL_SOFT_WORDS,
    wordNotAfter: { sex: SEX_EDUCATION_AFTER },
    compound: true,
    nameSafeCompound: true,
    openStart: true,
    category: 'minor-suggestive',
  });
}

// Round 20 (accounts#3): a child word directly before a porn / sex / nude
// word. Only "child porn" was listed, so "child pornography", "kiddie porn",
// "kid porn", "toddler porn", "child sex" and "minor nudes" published in every
// field. These pairs have no innocent reading; the words that do are kept
// narrow: "baby" (adult slang) pairs only with the porn words and never
// before "star" ("hey baby, porn star here" is the pairing an adult means);
// "minor" / "minors" only with porn / nudes / naked ("minor sex scene edits"),
// also never before "star"; "sex" is never "sex ed", "sex education" or the
// abuse / trafficking words a survivor or an advocate writes ("child sex abuse
// survivor"). The join is CHILD_PAIR_GAP (top of the file) -- never a comma
// ("no kids, sex positive") and never a sentence break.
const NOT_STAR_AFTER = '(?![^a-z0-9]{0,3}stars?(?![a-z]))';
const CHILD_LEADS = ['child', 'children', 'childs', 'kid', 'kids', 'kiddie', 'kiddy', 'kiddies', 'toddler', 'toddlers', 'infant', 'infants'];
const PORN_WORDS = ['porn', 'porno', 'pornography'];
// "xxx" reaches the rules as "xx" (foldStretched), which is also a sign-off
// ("night night kids xx"), so it pairs with every lead except "kid"/"kids".
const CHILD_CONTENT_WORDS = [...PORN_WORDS, 'sex', 'nudes', 'nude', 'naked'];
const CHILD_XX_LEADS = new Set(['child', 'children', 'childs', 'kiddie', 'kiddy', 'kiddies', 'toddler', 'toddlers', 'infant', 'infants']);
// "child porn" is listed above on its own (with its compound form); the
// group adds "porno" / "pornography" and the other words.
// The glued forms ("kiddieporn", "childpornography", "kidnudes") have no
// ordinary word around them -- except with "sex" ("kidsexchange") and "xxx",
// which are therefore not compound; "baby"/"minor" pairs are word-tier only.
PROHIBITED_TERMS.push(
  ...CHILD_LEADS.map((lead) => ({
    term: lead, words: CHILD_XX_LEADS.has(lead) ? [...CHILD_CONTENT_WORDS, 'xx'] : CHILD_CONTENT_WORDS, gap: CHILD_PAIR_GAP,
    wordNotAfter: { sex: SEX_EDUCATION_AFTER },
    compoundWords: CHILD_CONTENT_WORDS.filter((w) => w !== 'sex'), compound: true, nameSafeCompound: true,
    category: 'minor-suggestive',
  })),
  ...['baby', 'babies'].map((lead) => ({ term: lead, words: PORN_WORDS, gap: CHILD_PAIR_GAP, notAfter: NOT_STAR_AFTER, category: 'minor-suggestive' })),
  ...['minor', 'minors'].map((lead) => ({
    term: lead, words: [...PORN_WORDS, 'nudes', 'nude', 'naked'], gap: CHILD_PAIR_GAP, notAfter: NOT_STAR_AFTER, category: 'minor-suggestive',
  })),
);
// Round 20 fix-up: the two pairs the group above leaves out for free text
// ("kid"/"kids" + "xxx", which reaches the rules as the sign-off "xx"; "baby" +
// "nudes"/"naked", an endearment before a menu) have neither reading in a tag,
// a handle or a username, which is only ever a label: refused there
// (detectIn, strictAge only). Same join as the group.
const CHILD_PAIR_STRICT_RE = new RegExp(`(?<![a-z])(?:kids?${CHILD_PAIR_GAP}xx+|bab(?:y|ies)${CHILD_PAIR_GAP}(?:nudes?|naked))(?![a-z])`);

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

function buildRe({ term, words = null, wordNotAfter = {}, suffixes = '(?:s|es|ed|er|ers|ing)?', openStart = false, gap = WORD_GAP, notAfter = '' }, flags = '') {
  const body = term.split(' ').map(wordPattern).join(gap);
  // Plural/verb suffixes stay matched ("teens"); an adjacent LETTER breaks the
  // match so "eighteen", "canteen" and "grape" never do.
  if (!words) return new RegExp(`${openStart ? '' : '(?<![a-z])'}${body}${suffixes}(?![a-z])${notAfter}`, flags);
  // A pair group: the lead, the gap, then ONE of its words (captured, so the
  // reason can name it), each with its own "never before" guard.
  const alts = words.map((w) => `${wordPattern(w)}${suffixes}(?![a-z])${wordNotAfter[w] || ''}`).join('|');
  return new RegExp(`${openStart ? '' : '(?<![a-z])'}${body}${gap}(?<w>${alts})${notAfter}`, flags);
}

const COMPILED = PROHIBITED_TERMS.map((t) => ({ ...t, re: buildRe(t, t.disclaimable || t.words ? 'g' : '') }));

// Which of a pair group's words a match ended on (for the reason and the
// soft-word check): the captured text read back against each word's pattern.
const PAIR_WORD_RES = new Map();
function pairWordOf(t, captured) {
  if (!PAIR_WORD_RES.has(t)) {
    PAIR_WORD_RES.set(t, t.words.map((w) => [w, new RegExp(`^${wordPattern(w)}(?:s|es|ed|er|ers|ing)?$`)]));
  }
  const hit = PAIR_WORD_RES.get(t).find(([, re]) => re.test(captured));
  return hit ? hit[0] : captured.replace(/[^a-z]/g, '');
}

// Round 20 (accounts#1): a school pair with a reminiscing word, in FREE text,
// after "my" / "our" / "former" / "ex" (and "married to my", "with my"...:
// the possessive is what matters), and spaced ("high school bf", not
// "highschoolbf"). See SCHOOL_SOFT_WORDS. Never "your" ("I'll be your high
// school cheerleader" is role-play of a minor).
const SCHOOL_REMINISCE_BEFORE_RE = /(?<![a-z])(?:my|our|former|ex)(?:[^a-z0-9]{1,3}(?:former|old|ex))?[^a-z0-9]{1,3}$/;
function isSchoolReminiscence(text, start, match, word) {
  return /[^a-z0-9]$/.test(match.slice(0, match.length - word.length)) && SCHOOL_REMINISCE_BEFORE_RE.test(text.slice(Math.max(0, start - 20), start));
}

// Tier two: the glued spelling of a `compound` term, matched anywhere inside
// a run of letters. Contiguous only -- the spaced-out spellings are the word
// tier's job, and a multi-word phrase only counts glued ("barelylegal"),
// never across a space. The digit swaps are narrower than LEET: with no word
// boundary, "1" for "l"/"i" turned "hello11" and "yolo11" into "loli", so
// only the swaps that do not read as an ordinary number suffix stay.
const COMPOUND_LEET = { a: '[a4@]', e: '[e3]', o: '[o0]', s: '[s5$]', t: '[t7]' };
function buildCompoundRe({ term, words = null, compoundWords = words }) {
  const glue = (phrase) => phrase.split(' ').map((w) => [...w].map((ch) => COMPOUND_LEET[ch] || ch).join('')).join('');
  if (!compoundWords) return new RegExp(glue(term), 'g');
  return new RegExp(`${glue(term)}(?<w>${compoundWords.map(glue).join('|')})`, 'g');
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
  // ...and the everyday "#extrapetite" hashtag (round-11 accounts#2). The
  // whole word only: "rapetite" alone would also blank "rapetits".
  'extrapetite',
  // "loli"
  'lolipop',
  // ...and Hololive, the VTuber agency: one of the most common cosplay tags.
  // A glued evasion is still caught -- "hololiveloli" blanks to "loli".
  'hololive',
  // "ageplay"
  'stageplay',
];
const COMPOUND_ALLOWLIST_RE = new RegExp(COMPOUND_ALLOWLIST.join('|'), 'g');
// Name mode's own mask (round-14 accounts#0): the same list WITHOUT the
// spelled-out minor ages. Blanking "sixteen" in "sixteenslut" left only
// " slut" for the teen + sexual-word test, so "@sixteenslut", "@fifteenporn"
// and "fourteenslut" published. "nineteen"/"eighteen" (adult ages) and the
// name collisions (Steen, Kirsteen, Mateen...) are still blanked.
const SPELLED_MINOR_AGES = new Set(['thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen']);
const NAME_COMPOUND_ALLOWLIST_RE = new RegExp(COMPOUND_ALLOWLIST.filter((w) => !SPELLED_MINOR_AGES.has(w)).join('|'), 'g');
// Names that START with a compound term, where a substring allowlist entry
// would open a hole ("teena" as a substring would also blank the start of
// "teenass"). So these are blanked only in the position the name takes:
//   - "Teena"/"Teenah" only as a whole word,
//   - the Thai given-name prefix "Rapee-" (Rapeepat, Rapeeporn) only at the
//     start of a word, and only those five letters -- anything glued on after
//     it is still screened ("rapeeteen" is still "teen"),
//   - Spanish "rapero"/"rapera" (rapper) only as a whole word.
const NAME_ALLOWLIST_RE = /(?<![a-z])(?:teenah?(?![a-z])|rapee(?=[a-z])|raper[oa]s?(?![a-z]))/g;

// "underage" / "under age(d)" are, on an adult platform, mostly the exclusion
// disclaimer -- "18+ only, no underage", "No one underage allowed",
// "Underage? leave now." -- or a question or denial in a DM ("are you
// underage?", "no I'm not underage, I'm 24"). Refusing those logged honest
// creators and fans under the most serious category there is (round-10
// accounts#3). So a match is skipped when a negation, a question or a
// disclaimer sits right next to it; anything else ("underage girl", "new
// underage set") is still refused.
// Round 11 (accounts#3) widened both sides to the everyday phrasings the
// round-10 list missed: "not for", "nothing", "zero tolerance for", "don't
// allow", "do not message me if" before it; "(users) will be
// reported/removed", "(kids) stay away", "(accounts) to NCMEC", "= instant
// block", "(:) do not follow" after it. Still only right next to the term: a
// bare "if" ("dm me if underage"), "reported" before it, or an arbitrary word
// between it and the exclusion ("underage content will be removed soon lol")
// are NOT disclaimers.
const DISCLAIMER_BEFORE_RE = new RegExp(
  "(?:^|[^a-z])(?:no|not(?: for)?|never|nothing|nobody|no ?one|none|zero(?: tolerance(?: for)?)?|dni"
  // "if" only after a negation ("do not message me if underage"): a bare "if"
  // is also "dm me if underage", which solicits a minor (round-11 fix-up).
  + "|(?:don'?t|do not|we don'?t|we do not) (?:allow|want|accept|tolerate|message me|msg me|dm me|follow)(?: me)?(?: if)?"
  + "|are (?:you|u)|r u|if (?:you ?(?:'?re|are)|youre|ur|u r|u are))"
  + '(?:[^a-z0-9]{1,3}(?:one|body|person|people|minors?|kids?|or|and|&|\\/)){0,2}[^a-z0-9]{0,3}$',
);
// After the term, these shapes count, and only these (round-10 fix-up: a bare
// "?" or any "leave" within three words let "new underage? set" and
// "underage leave you wanting more" through):
//   - a "?" that is answered by an exclusion right away ("Underage? leave
//     now.", "underage?? DNI") -- a "?" followed by anything else is not a
//     disclaimer ("underage?? you know what I sell");
//   - an imperative directly after it that ends the clause ("underage, leave",
//     "underage -- please go away now.");
//   - a ban word up to three words on ("underage users will be banned",
//     "minors/underage DNI", "underage content not allowed").
// The only words that may sit between "underage" and a later exclusion word.
const DISCLAIMER_FILLER = '(?:[^a-z0-9]{1,3}(?:kids?|people|persons?|users?|accounts?|viewers?|minors?|fans?|profiles?))?';
const DISCLAIMER_AFTER_RE = new RegExp(
  '^(?:[^a-z0-9]{0,2}\\?+[^a-z0-9]{0,3}(?:leave|dni|no|nope|not allowed|banned|get out|go away|stay away|keep out|bye)(?![a-z])'
  + '|[^a-z0-9]{1,3}(?:please |pls )?(?:leave|block|get out|keep out|stay away|go away)'
  + '(?: (?:now|pls|please|asap|immediately))?\\s*(?:[^a-z0-9\\s]|$)'
  + '|(?:[^a-z0-9]{1,3}[a-z]+){0,3}?[^a-z0-9]{1,3}(?:(?:not|never|isn\'?t|aren\'?t|is not|are not) (?:allowed|permitted|welcome)'
  + '|dni|banned|prohibited|blocked|need not apply)(?![a-z])'
  // "Underage users will be reported", "Underage kids stay away": these
  // words are ordinary prose ("hot underage content will be removed soon
  // lol", "underage girls stay away from mom"), so only a filler noun may
  // sit between the term and them -- never an arbitrary word (round-11
  // fix-up).
  + `|${DISCLAIMER_FILLER}(?:[^a-z0-9]{1,3}(?:will|would|shall|are|is|get|gets)(?: (?:be|get))?)?`
  + '[^a-z0-9]{1,3}(?:reported|removed|stay away|keep away|keep out)(?![a-z])'
  // "We report underage accounts to NCMEC"
  + `|${DISCLAIMER_FILLER}[^a-z0-9]{1,3}(?:are |will be |get )?(?:reported )?to (?:ncmec|the police|police|law enforcement|the authorities|authorities)(?![a-z])`
  // "underage = instant block", "underage = ban"
  + '|[^a-z0-9=]{0,2}=[^a-z0-9]{0,2}(?:(?:instant|auto|automatic|immediate) )?(?:block|ban)(?![a-z])'
  // "minors/underage: do not follow", "if u underage dont follow" -- only an
  // exclusion verb, never "do not miss this" / "dont tell mom".
  + "|[^a-z0-9]{1,5}(?:please |pls )?(?:do not|don'?t|dont) "
  + '(?:follow|message|msg|dm|sub|subscribe|interact|enter|apply|view|look)(?![a-z]))',
);
function isDisclaimed(text, start, end) {
  return DISCLAIMER_BEFORE_RE.test(text.slice(Math.max(0, start - 30), start))
    || DISCLAIMER_AFTER_RE.test(text.slice(end, end + 40));
}

// An explicit under-18 self-description. Numbers are not letters, so none of
// the word lists above can express this; it is a word-tier rule of its own.
// Deliberately narrow, because the obvious broad version refuses ordinary
// adult text (round-3 and round-4 review):
//   - "under 18" is NOT screened at all. On an adult platform it is almost
//     always the exclusion disclaimer ("if you're under 18, leave", "minors
//     (under 18) not allowed", "under 18s not welcome"), and no negation list
//     keeps up with real phrasing.
//   (Round 7 narrowed the determiner rule too far and let "a 16yo house slut"
//   and "16 year old slut" through; round 8 restored them. Every string from
//   both audits is a regression case in lib/r8b.test.mjs, in both directions.)
//   - Only ages 10-17, as digits or spelled out (ten..seventeen). "my 2 year
//     old cat" and "3 years old page anniversary" are not about a person.
//   - The short form with digits ("15yo", "16 y/o", "17 y.o.") matches on its
//     own only where it reads as a label about a person: standing alone (a
//     tag, the start of a sentence, after punctuation) or after a descriptive
//     word, a sexual noun or a sexual verb ("hot 16yo", "new 17yo set",
//     "slut 16yo"), or after a determiner unless a thing follows (below).
//     After any other word ("Macallan 12yo", "Toyota 12yo", "Top 10 yo mama
//     jokes") it does not -- whisky ages, car ages and "yo mama" were refused
//     and logged as minor content. It never matches before "mama". Spelled
//     numbers get no bare short form at all ("ten yo" is too easily something
//     else).
//   - The long forms ("15 years old", "seventeen-year-old") match as a
//     self-description, in front of a person or sexual noun ("17-year-old
//     girl", "16 year old slut"), directly after a sexual noun or verb unless
//     a thing follows ("fucking a 16 year old in the ass"), and -- after a
//     descriptive word, after a determiner or, digits only, standing alone as
//     a tag or title -- only when it ends the clause or a person noun follows
//     within two words ("horny 16 year old", "a 16 year old house wife", "16
//     year old"; see PERSON_AFTER_LONG). "my dog is 12 years old", "this
//     account is 15 years old", "15 years old today", "a 10 year old song"
//     and "bored 10 year old me" are fine.
//     A self-description may also end the sentence with just the number
//     ("i'm seventeen", "aged 16."), but never with more words after it
//     ("i'm fifteen minutes away").
//   - The self-description lead-ins are about a PERSON: i'm / she's / he's /
//     aged / just turned / i|she|he turned. A bare "turned" matched any
//     subject ("my blog turned 15 years old"), and nothing matches ahead of a
//     drink or food it describes ("aged 12 years old single malt").
const MINOR_AGE_NUM = '(?:(?<![0-9])1[0-7]|(?<![a-z])(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen))';
const MINOR_AGE_DIGITS = '(?<![0-9])1[0-7]';
const NOT_A_DRINK = '(?![\\s,-]{0,3}(?:single|malt|scotch|whisk|bourbon|rum|port|wine|cheddar|cheese|balsamic|cask|reserve|bottle|cognac|brandy|tequila|mezcal|vodka|sake|vinegar))';
const MINOR_SHORT_AGE = '[\\s-]{0,2}(?:y\\s?\\/\\s?o|y\\.\\s?o\\b\\.?|yo)(?![a-z])(?!\\s*mama)' + NOT_A_DRINK;
// "years young" is the euphemism for "years old", and a bare "yrs" ("16yrs",
// "17 yrs") is the everyday abbreviation of it (round-10 accounts#2). The bare
// "yrs" is a LONG form, not a short one: "15 yrs experience", "my 16 yrs of
// modeling" and "I ran 16 yrs" are ordinary, so it only counts where the long
// form does -- ending the clause, before a person noun, and so on.
const MINOR_LONG_AGE = '[\\s-]{0,2}(?:yrs?[\\s-]{0,2}old|years?[\\s-]{0,2}(?:old|young)|yrs?)(?![a-z])' + NOT_A_DRINK;
const MINOR_ANY_AGE = '[\\s-]{0,2}(?:y\\s?\\/\\s?o|y\\.\\s?o\\b\\.?|yo|yrs?[\\s-]{0,2}old|years?[\\s-]{0,2}(?:old|young))(?![a-z])(?!\\s*mama)' + NOT_A_DRINK;
// The bare "yrs" on its own, for the two rules that take it separately.
const MINOR_YRS = '[\\s-]{0,2}yrs?(?![a-z])' + NOT_A_DRINK;
// Words that make a bare "16yo" a label for a person rather than the age of
// a thing. Left of the number, one word. Round 8 added the everyday
// descriptors a listing title actually uses (blonde, amateur, slim, fresh...):
// "blonde 16yo" and "amateur 16yo" went through because only "hot/sexy/..."
// were listed.
const PERSON_ADJ = '(?:hot|sexy|cute|horny|naughty|young|tiny|petite|new|real|sweet|little|innocent|slutty|busty|shy|nude|naked|pretty|skinny|thick|curvy|blonde?|brunette|redhead|ginger|amateur|slim|fresh|tight|kinky|dirty|wet|virgin|ebony|asian|latina|chubby|freaky|lonely|bored)';
// Person and sexual nouns. Used three ways: after the long form ("16 year old
// slut"), as the word BEFORE a short form ("slut 16yo"), and to cancel the
// thing exemption below when one follows the thing ("a 16yo house slut").
// The rule-4 list used to hold only girls/boys/teens/students...: "16 year old
// slut" and "horny 17 year old whore" were published with nothing logged.
const PERSON_NOUN = '(?:girls?|gals?|chicks?|boys?|teens?|schoolgirls?|schoolboys?|students?|virgins?|kids?|daughters?|stepdaughters?|sons?|stepsons?|sisters?|stepsis(?:ters?)?|brothers?|cousins?|nieces?|nephews?|babysitters?|wife|wives|housewife|housewives|gfs?|bfs?|girlfriends?|boyfriends?)';
const SEXUAL_NOUN = '(?:sluts?|whores?|hoes?|babes?|bitch(?:es)?|pussy|pussies|cunts?|twinks?|bimbos?|milfs?|sissy|sissies|nymphos?|cumsluts?|fucktoys?|sex\\s?toys?|pornstars?)';
const PERSON_OR_SEXUAL_NOUN = '(?:' + PERSON_NOUN + '|' + SEXUAL_NOUN + ')';
// A sexual verb before the age ("fucking 16yo", "fucking 16 year old"), also
// through a preposition and a determiner for the long form (SEXUAL_LEAD).
const SEXUAL_VERB = '(?:fuck(?:s|ed|ing|in)?|cum(?:s|ming|med)?|bang(?:s|ed|ing)?|screw(?:s|ed|ing)?|pound(?:s|ed|ing)?|breed(?:s|ing)?|rail(?:s|ed|ing)?|stroke|stroking|jerk(?:ing)?)';
// Everything that, one word to the LEFT of an age, makes it a person's age.
// Round 9 added the person nouns: "girl 16yo" and "gf 16yo" went through.
// (A given name in front -- "emma 16yo" -- is still not read as a lead: it is
// the same shape as "Toyota 12yo" and "Rolling 10yo", which must pass. Glued
// or joined with "_"/"." it is caught: see GLUED_AGE_RE.)
const PERSON_LEAD = '(?<![a-z])(?:' + PERSON_ADJ + '|' + PERSON_NOUN + '|' + SEXUAL_NOUN + '|' + SEXUAL_VERB + ')[\\s-]{1,2}';
// A bare determiner ("my 15yo", "a 16 y/o") says nothing about WHAT is that
// age -- "me and my 12yo dog", "my 15 y/o car still runs", "proud owner of a
// 13 yo husky" were refused and logged as minor content, the most serious
// category there is. So after a determiner the age counts unless the next
// word is an animal or a thing from THING_NOUN, optionally after ONE word from
// the fixed THING_MODIFIER list ("my 12yo golden retriever").
// "my 15yo girlfriend", "a 16yo" at the end of a line and "the 17yo next
// door" are still refused.
//   - The middle slot is a fixed list, never "any word": an open slot let a
//     sexual noun ride in front of an innocent one ("my 15yo slut house",
//     "our 14yo babe account", "my 16yo pussy cat").
//   - The thing only exempts when NO person or sexual noun follows it within
//     the next two words. Round 7 checked only the word after the age, so the
//     reverse order went through: "a 16yo house slut", "my 16yo shop girl",
//     "our 16yo account babe", "a 16 y/o house wife". "my 14 yo cat Luna" and
//     "my 15 y/o car still runs" still pass.
//   - THING_NOUN leaves out every animal word that is also sexual or petplay
//     slang -- pet, kitty, kitten, bunny, pony -- and "home" ("my 15yo home
//     alone"), and every word for a picture or a video ("a 16yo clip" is not
//     the age of a thing). "my 16yo pet"/"a 16yo kitty" stay refused; the
//     accepted cost is that an honest "my 12yo kitten" is refused too and has
//     to be reworded.
const DETERMINER = '(?:my|our|your|her|his|a|an|the|this|that|these|those)';
const THING_MODIFIER = '(?:golden|german|australian|labrador|old|used|rescue|family|black|white|brown|grey|gray|red|blue|silver|yellow|orange)';
const THING_NOUN = '(?:dogs?|doggos?|pups?|puppy|puppies|cats?|horses?|birds?|parrots?|fish|hamsters?|rabbits?|husky|huskies|retrievers?|labs?|labrador|poodles?|pugs?|chihuahuas?|terriers?|shepherds?|beagles?|bulldogs?|cars?|trucks?|jeeps?|bikes?|motorcycles?|vans?|laptops?|computers?|pc|phones?|iphones?|tvs?|house|channel|page|blog|business|brand|company|shop|store|plants?|trees?|guitars?|camera|account|website|site|podcast|tradition|anniversary|watch|couch|sofa|tattoos?)';
const NOT_A_THING = '(?![\\s-]{1,3}(?:' + THING_MODIFIER + '[\\s-]{1,2})?' + THING_NOUN + '(?![a-z])'
  + '(?!(?:[^a-z0-9]{1,3}[a-z]+)?[^a-z0-9]{1,3}' + PERSON_OR_SEXUAL_NOUN + '(?![a-z])))';
// Where a LONG form ("16 year old") is about a person rather than a thing.
// The long form is ordinary English in a way "16yo" is not ("a 10 year old
// song", "the 17 year old record still stands", "bored 10 year old me",
// "Dirty 16 year old sneakers"), so after a determiner, a descriptive word or
// standing alone it counts only when (a) the phrase ends the clause -- end of
// text or punctuation ("fucking a 16 year old", "a sixteen year old.", the
// tag "16 year old") -- or (b) a person or sexual noun follows within two
// words ("a 16 year old house wife", "hot 16 year old blonde slut"). Any other
// following noun is the age of that thing. Round 8's first pass used the
// short form's open "unless a thing follows" rule here and refused all of the
// sentences above as minor content.
const CLAUSE_END = '(?=\\s*(?:$|[.!?;,:)\\]|/#]))';
const NOUN_WITHIN_TWO = '(?=(?:[^a-z0-9]{1,3}[a-z]+)?[^a-z0-9]{1,3}' + PERSON_OR_SEXUAL_NOUN + '(?![a-z]))';
// ...or (c) "and" plus a sexual adjective or noun ("17 years old and horny").
const SEXUAL_ADJ = '(?:horny|slutty|kinky|naughty|nude|naked|wet|freaky|sexy|dirty|thirsty|needy)';
// Round 17 (accounts#2): also "and a virgin" / "and a slut" -- "a" only
// before these few words ("chapter 16 and a boy" stays a chapter).
const SEXUAL_AND = '(?=\\s*(?:and|&|n)\\s+(?:(?:so|very|super|always|really)\\s+)?(?:' + SEXUAL_ADJ + '|' + PERSON_OR_SEXUAL_NOUN
  + '|a\\s+(?:virgin|slut|whore|hoe|bitch))(?![a-z]))';
const PERSON_AFTER_LONG = '(?:' + CLAUSE_END + '|' + NOUN_WITHIN_TWO + '|' + SEXUAL_AND + ')';
// SEXUAL_AND, widened for a SPELLED age after a self-description lead-in: the
// sexual words, a sexual verb, or a verb of wanting ("sixteen and loves older
// men", "sixteen and looking"). Never "and" + a number or a unit ("aged
// twelve and eighteen months" is cheese).
const SPELLED_AND = '(?=\\s*(?:and|&|n)\\s+(?:(?:so|very|super|always|really|still)\\s+)?(?:'
  + SEXUAL_ADJ + '|' + PERSON_OR_SEXUAL_NOUN + '|' + SEXUAL_VERB
  + '|loves?|likes?|wants?|needs?|craves?|craving|looking|lookin|ready|down|single|curious|into|dtf|a\\s+(?:virgin|slut|whore|girl|boy))(?![a-z]))';
// Directly after a sexual noun or verb -- optionally through a preposition and
// a determiner ("cum on a 16 year old", "fucking a 16 year old in the ass",
// "slut 16 year old") -- the long form counts unless a thing follows.
// "Fucking 12 year old laptop died" is still the age of a laptop.
const SEXUAL_LEAD = '(?<![a-z])(?:' + SEXUAL_NOUN + '|' + SEXUAL_VERB + ')'
  + '(?:[\\s-]{1,2}(?:on|in|inside|into|with|over|for))?(?:[\\s-]{1,2}' + DETERMINER + ')?[\\s-]{1,2}';
// What may follow a bare digit age and make it a count or a measure rather
// than a person's age: a unit, a time, money, a size, or a counted thing.
// Checked directly after the number; glued units too ("12in", "10k", "16th").
const COUNT_WORD = '(?:minutes?|mins?|hours?|hrs?|h|seconds?|secs?|days?|nights?|weeks?|wks?|months?|mos?|years?|yrs?|yr'
  + '|inch(?:es)?|cm|mm|ft|feet|foot|lbs?|pounds?|kgs?|kilos?|stone|miles?|mi|km|k|pm|am|p\\.m|a\\.m|o\\s?clock'
  + '|th|st|nd|rd|percent|dollars?|bucks|usd|usdg|credits?|tokens?|cents?|more|times|x|out|outta|of'
  + '|pics?|photos?|pictures?|videos?|vids?|clips?|sets?|packs?|items?|posts?|people|followers?|fans|subs|subscribers?'
  + '|hands|hh|floors?|blocks?|points?|pts|goals?|games?|wins?|shots?|drinks?|beers?|episodes?|eps?|chapters?|pages?|steps?|reps?|laps?|rounds?|plus)';
// ...or a score, "12 for 12" / "10 of 10" ("for" alone stays an age: "i'm 16
// for you").
const NOT_A_COUNT = '(?![0-9])(?![.,/:x-]?\\s?[0-9])(?![%$+])(?!in(?![a-z]))(?!\\s+(?:for|of|out of)\\s+[0-9])(?![\\s-]{0,2}' + COUNT_WORD + '(?![a-z]))';
// An age/sex label. "f"/"m" glued to the age or around a "/".
// "f/16" right after "at"/"on"/"shot"/"aperture" is a camera setting
// ("Shot on f/16", "at f/16"), never a label.
const NOT_APERTURE = '(?<!(?:at|on|shot|aperture|@)\\s{0,2})';
const AGE_SEX_LABEL = '(?:' + MINOR_AGE_DIGITS + '\\s?[fm](?![a-z0-9])|(?<![a-z0-9])' + NOT_APERTURE + '[fm]\\s?\\/\\s?' + MINOR_AGE_DIGITS + '(?![0-9])|' + MINOR_AGE_DIGITS + '\\s?\\/\\s?f(?![a-z0-9]))(?:\\s?\\/\\s?[a-z]{2,4})?';
// ...the female forms only, for a label standing alone ("16f", "f/16",
// "16/f/usa"): an "m" is also "million"/"minutes"/"per month".
const AGE_SEX_LABEL_F = '(?:' + MINOR_AGE_DIGITS + '\\s?f(?![a-z0-9])|(?<![a-z0-9])' + NOT_APERTURE + '[fm]\\s?\\/\\s?' + MINOR_AGE_DIGITS + '(?![0-9])|' + MINOR_AGE_DIGITS + '\\s?\\/\\s?f(?![a-z0-9]))(?:\\s?\\/\\s?[a-z]{2,4})?';
// Glued forms, matched on the text with "_" and "." between letters/digits
// removed (the form sanitizeTags stores, and how handles are written):
// "girl16yo", "hot_16_yo", "jess.16.yo", "lily16yo", "16yohot",
// "16yearsold". A letter run glued straight onto the age is a label for a
// person; "Toyota 12yo" with its space is not touched by this.
const GLUED_AGE_RE = new RegExp('(?:[a-z]' + MINOR_AGE_DIGITS + '(?:yo|yrs?old|years?old)(?![a-z])'
  + '|(?<![a-z0-9])' + MINOR_AGE_DIGITS + '(?:yo(?!mama)|yrs?old|years?old)[a-z]'
  + '|(?<![a-z0-9])' + MINOR_AGE_DIGITS + '(?:yrs?old|years?old)(?![a-z]))');
// The words allowed between a lead-in and the number are a FIXED list of
// adverbs that keep it a self-description ("i'm only 16", "she's just 15").
// Round 8 allowed any one or two words there, so "I'm a size 12", "I'm live
// at 10!", "i'm level 16" and "He's number 12" were refused and logged as
// under-18 content. A bare "age" does not lead when it follows "at"/"since"
// ("I started modeling at age 16", "drawing since age 15, now 24"): that is
// a past age, not a present self-description. "aged 16" and a label "age: 16"
// still lead. A bare "just turned" does not lead after a thing ("my blog just
// turned 12 today") -- "just turned 16 and ready" still does.
const SELF_ADVERB = '(?:only|just|barely|now|literally)';
const SELF_LEAD = "(?<![a-z])(?:i'?m|i am|she'?s|she is|he'?s|he is|aged|(?<!(?:at|since|from|until|till|by|of)[\\s-]{1,2})age"
  + "|(?<!" + THING_NOUN + "[\\s-]{1,2})just turned|(?:i|she|he)(?:\\s+just)?\\s+turned)(?:\\s+" + SELF_ADVERB + "){0,2}[\\s:,-]{1,3}";
// Round 19 (accounts#3): the singular sexual nouns (line "slut 16"): a
// plural or "sex toys" before a number is a price menu or a count.
const SEXUAL_NOUN_SINGULAR = '(?:slut|whore|hoe|babe|bitch|pussy|cunt|twink|bimbo|milf|sissy|nympho|cumslut|fucktoy)';
// A rank, a size, an episode or a set number in front of the digits, with a
// real separator (round-19 fix-up: glued "set16" is a name, and "no 16 and
// horny" is a sentence, not "No. 16" -- same rule as neutralizeNonAges).
const FREE_NOT_A_RANK_EARLY = '(?<!(?<![a-z])(?:(?:size|top|vol|volume|ep|episode|part|pt|chapter|ch|day|week|level|lvl|number|season|series|set|scene)[\\s.#:_-]{1,2}|no\\s?[.#]\\s?))';
// The singular person words, for the label rule below (the same list as
// STRICT_SINGULAR_PERSON, which is defined further down).
const STRICT_SINGULAR_PERSON_EARLY = '(?:girl|boy|teen|babe|schoolgirl|schoolboy|virgin|daughter|stepdaughter|gf|bf|sis|stepsis)';
// The sexual words a "16f" label may be followed by, two words on.
const LABEL_SEXUAL_WORD = '(?:porn|sex|nudes?|pussy|cum|xxx|fuck|dick|cock|tits|boobs|horny|sluts?|whores?)';
const MINOR_AGE_RES = [
  // Short form, digits only: alone / after punctuation, or after a descriptive
  // word, a sexual noun or a sexual verb.
  new RegExp('(?:^|[^a-z0-9\\s]\\s*|' + PERSON_LEAD + ')' + MINOR_AGE_DIGITS + MINOR_SHORT_AGE),
  // Short form after a bare determiner, unless an animal or a thing follows
  // ("a 16yo", "watch this 15yo").
  new RegExp('(?<![a-z])' + DETERMINER + '[\\s-]{1,2}' + MINOR_AGE_DIGITS + MINOR_SHORT_AGE + NOT_A_THING),
  // Long form after a sexual noun or verb, unless a thing follows.
  new RegExp(SEXUAL_LEAD + MINOR_AGE_NUM + MINOR_LONG_AGE + NOT_A_THING),
  // Long form after a descriptive word or a determiner, or standing alone as
  // a tag or title (digits only): only when it ends the clause or a person
  // noun follows (see PERSON_AFTER_LONG). "horny seventeen year old", "a
  // sixteen year old", "#16 years old" -- but not "15 years old today".
  new RegExp('(?<![a-z])(?:' + PERSON_ADJ + '|' + DETERMINER + ')[\\s-]{1,2}' + MINOR_AGE_NUM + MINOR_LONG_AGE + PERSON_AFTER_LONG),
  new RegExp('(?:^|[^a-z0-9\\s]\\s*)' + MINOR_AGE_DIGITS + MINOR_LONG_AGE + PERSON_AFTER_LONG),
  // Self-description with an age word after the number ("i'm only 16 years old").
  new RegExp(SELF_LEAD + MINOR_AGE_NUM + MINOR_ANY_AGE),
  // Self-description ending on the number itself ("im seventeen", "aged 16.").
  // Spelled-out numbers only count here, at the end of the clause, because
  // "i'm fifteen minutes away" is ordinary.
  new RegExp(SELF_LEAD + MINOR_AGE_NUM + '(?=\\s*(?:$|[.!?;,)]))'),
  // ...or with "and" plus a sexual word or a wanting verb ("i'm sixteen and
  // horny", "she's sixteen and loves older men"): "fifteen and" can't be
  // "fifteen minutes". Round 9 did this for digits only (round-10 accounts#2).
  new RegExp(SELF_LEAD + MINOR_AGE_NUM + SPELLED_AND),
  // The bare "yrs" after a self-description, ending the clause or before
  // "and" + a sexual word ("i'm 16 yrs", "she's 15 yrs and horny") -- not
  // "he's 12 yrs into his career".
  new RegExp(SELF_LEAD + MINOR_AGE_NUM + MINOR_YRS + '(?:' + CLAUSE_END + '|' + SEXUAL_AND + ')'),
  // A DIGIT age after a self-description lead-in counts whatever follows --
  // "im 17 and horny", "i'm 16 lol", "just turned 16 and ready" -- unless a
  // unit or a counted thing follows directly ("i'm 15 minutes away", "i'm 12
  // inches", "i'm 10/10"). Round 8 required the number to end the clause for
  // digits too, which let the most explicit form of the claim through.
  new RegExp(SELF_LEAD + MINOR_AGE_DIGITS + NOT_A_COUNT),
  // A SINGULAR sexual noun directly before a bare digit age ("slut 16", "slut,
  // 16"), unless a unit or a counted thing follows ("babe 10 pics"). Round 19
  // (accounts#3): plurals and "sex toys" / "pornstars" are a price menu or a
  // count ("Used sex toys 15, lingerie 20", "Babes 12"), not an age.
  new RegExp('(?<![a-z])' + SEXUAL_NOUN_SINGULAR + '[\\s,:-]{1,3}' + MINOR_AGE_DIGITS + NOT_A_COUNT),
  // A bare digit age joined to a sexual word: "16 and horny", "Emma, 16,
  // horny" (the comma-separated profile shape). Round 19 (accounts#3): not a
  // rank, a height or a rating -- and every rule here runs on the text with
  // those numbers already neutralized (neutralizeNonAges).
  new RegExp(FREE_NOT_A_RANK_EARLY + "(?<![0-9]\\s?['’′\"]\\s?)" + MINOR_AGE_DIGITS + '(?![0-9])(?!\\s?\\/\\s?[0-9])' + SEXUAL_AND),
  new RegExp(',\\s*' + MINOR_AGE_DIGITS + '\\s*,\\s*(?:' + SEXUAL_ADJ + '|' + PERSON_OR_SEXUAL_NOUN + '|' + LABEL_SEXUAL_WORD + ')(?![a-z])'),
  // Round 20 (accounts#4): the age as the FIRST field of a label, its own
  // field, then a sexual or singular person word as the next whole field
  // ("16, horny, dm me"; "16 | girl" once the bio separators read as commas).
  // A plural ("16, girls") is a count.
  new RegExp('(?:^|,)\\s*' + MINOR_AGE_DIGITS + '(?![0-9])\\s*,\\s*(?:' + SEXUAL_ADJ + '|' + STRICT_SINGULAR_PERSON_EARLY + '|' + SEXUAL_NOUN_SINGULAR + '|'
    + LABEL_SEXUAL_WORD + ')(?![a-z])(?=\\s*(?:$|[,.!?;]))'),
  // ...and the reverse two-field label ("girl | 16", "cute girl, 16"): a
  // singular person word or a sexual word, then the age as a whole field.
  new RegExp('(?<![a-z])(?:' + SEXUAL_ADJ + '|' + STRICT_SINGULAR_PERSON_EARLY + '|' + SEXUAL_NOUN_SINGULAR + ')\\s*,\\s*' + MINOR_AGE_DIGITS
    + '(?![0-9])(?=\\s*(?:$|[,.!?;]))'),
  // "only 17 years old" standing alone.
  new RegExp('(?:^|[^a-z0-9\\s]\\s*)' + SELF_ADVERB + '\\s+' + MINOR_AGE_DIGITS + MINOR_LONG_AGE + PERSON_AFTER_LONG),
  // Age/sex labels ("16f", "[16f]", "f/16", "16/f/usa", "16F horny"): inside
  // brackets anywhere, or standing alone as the text / a clause, or -- the
  // female form only -- directly followed by a sexual adjective or noun.
  // "16m"/"m/16" only in brackets ("hit 12m views", "$12/m", "Reached 13m dm
  // me" are not labels), and never "f/16" in running text ("shot at f/16").
  // The trailing word is NOT a person noun or "dm"/"hmu"/"lf": "Apt 14F dm
  // me", "room 12f girls night" and "Shot on f/16 girl portraits" are an
  // apartment, a room and an aperture.
  new RegExp('[\\[(]\\s?' + AGE_SEX_LABEL + '\\s?[\\])]'),
  new RegExp('(?:^|[.!?;,|:]\\s*)' + AGE_SEX_LABEL_F + '(?=\\s*(?:$|[.!?;,|:)\\]]))'),
  new RegExp('(?:^|[^a-z0-9$/.\\s]\\s*|\\s)' + AGE_SEX_LABEL_F + '\\s+(?:' + SEXUAL_ADJ + '|' + SEXUAL_NOUN + ')(?![a-z])'),
  // Round 19 (accounts#9): the female label with a sexual word up to two
  // words on ("16f selling nudes", "16f new nudes here").
  new RegExp('(?:^|[^a-z0-9$/.\\s]\\s*|\\s)' + AGE_SEX_LABEL_F + '(?:\\s+[a-z]+){1,2}\\s+(?:' + LABEL_SEXUAL_WORD + '|' + SEXUAL_ADJ + ')(?![a-z])'),
  // In front of a person or sexual noun ("17-year-old girl", "sixteen year
  // old schoolgirl", "16 year old slut").
  new RegExp(MINOR_AGE_NUM + '(?:' + MINOR_ANY_AGE + '|' + MINOR_YRS + ')[\\s-]{1,2}' + PERSON_OR_SEXUAL_NOUN + '(?![a-z])'),
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
export function detectProhibitedTerms(text, { nameLike = false, strictAge = nameLike, squashWhole = nameLike } = {}) {
  const reasons = [];
  const add = (term, category) => {
    const reason = `prohibited term (${category}): "${term}"`;
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  // Every reading of the text (lib/payment-circumvention-filter.js
  // normalizedReadings: a capital I after a lowercase letter is ALSO read as
  // an "l", so "LoIita" is "lolita" while "McIntyre" is still judged as typed).
  if (!nameLike) {
    for (const reading of normalizedReadings(text)) detectIn(foldStretched(reading), add, { strictAge, squashWhole });
  } else {
    // A name is judged word by word -- and again with "x" decoration at the
    // edges of each word dropped, so "xteenx" / "xxincestxx" are read as the
    // word they wrap (round-11 fix-up).
    const split = splitNameWords(text);
    for (const source of [split, stripEdgeX(split)]) {
      for (const reading of normalizedReadings(source)) detectIn(foldStretched(reading), add, { compound: false });
    }
  }
  return { flagged: reasons.length > 0, reasons };
}

/**
 * A handle or username is ONE token of glued words -- usually a first name
 * and a surname -- so the compound tier (a term matched anywhere inside a run
 * of letters) reads across the name boundary: "laurapeters" and "kiaraperez"
 * as "rape", "paulolima" as "loli", "vincestone" as "incest", and logged the
 * creator under the most serious category for their own name (round-11
 * accounts#2). For these fields only, words are what "_", ".", "-" and a
 * camelCase capital separate, and each is judged whole by the word tier
 * ("rape_play", "RapePlay", "hot.loli" are still refused), plus the narrow
 * NAME_COMPOUND_RES slice ("teenslut"), the name-safe compound terms and the
 * descriptor slice (NAME_SAFE_COMPOUND, NAME_DESCRIPTOR_RES: "sexyschoolgirl",
 * "hotteen", "incestlover"), and an edge-"x" reading ("xteenx").
 * The accepted cost: a name-colliding term (rape, loli, teen, incest,
 * ageplay) glued inside an all-lowercase handle to anything else ("rapeplay")
 * is not caught there. A camelCase break needs two lowercase letters on its left and
 * a Capital plus two lowercase on its right, so alternating case ("TeEn")
 * is not a way to split a word, and a capital I is never a word start
 * ("LoIita" still reads as "lolita").
 */
function splitNameWords(text) {
  return String(text ?? '').replace(/(?<=\p{Ll}{2})(?=(?!I)\p{Lu}\p{Ll}{2})/gu, ' ');
}

function stripEdgeX(text) {
  return text.replace(/(?<![\p{L}\p{N}])[xX]{1,4}(?=\p{L})|(?<=\p{L})[xX]{1,4}(?![\p{L}\p{N}])/gu, '');
}

// Name mode keeps ONE narrow slice of the compound tier: the highest-risk
// terms glued straight onto a sexual word ("teenslut", "pornteen",
// "incestsex"). A first name + surname never forms these,
// so this costs no real name what the full compound tier did.
const NAME_SEXUAL_WORD = '(?:sluts?|porn|sex|nudes?|pussy|cum|xxx|fuck|dick|cock|tits|boobs|horny)';
const NAME_COMPOUND_RES = [
  { term: 'teen', category: 'minor-suggestive' },
  { term: 'pedo', category: 'minor-suggestive' },
  { term: 'loli', category: 'minor-suggestive' },
  { term: 'incest', category: 'incest' },
].map((t) => ({ ...t, re: new RegExp(`${t.term}${NAME_SEXUAL_WORD}|${NAME_SEXUAL_WORD}${t.term}`) }));
// A spelled-out minor age as its own word next to a sexual word in a name
// ("Sixteen_Slut", "slut.fifteen", "twelveporn") -- round-14 accounts#0.
// The glued "sixteenslut" is the teen slice above; this adds the separated
// forms and the ages with no "teen" in them. "ten" only as a separate word
// ("tencummings" is a surname shape), and "nineteen"/"eighteen" never.
const NAME_SPELLED_MINOR = '(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)';
// The sexual word is bounded on its open side (round-14 fix-up): unbounded,
// "Ten Dickson", "Eleven Cumming" and "Essex Ten" / "Wessex Twelve" -- a
// first name and a surname, a county and a number -- read as age + sexual
// word and were refused as under-18 content.
// "ten" is also an everyday word, so it pairs only with the sexual words that
// are not also first names ("Dick Ten") or surname starts.
const NAME_TEN_SEXUAL_WORD = '(?:sluts?|porn|nudes?|pussy|xxx|fuck|tits|boobs|horny)';

// A MINOR AGE NEXT TO A SEXUAL WORD, in EVERY context (round-15 accounts#0).
// Round 14 ran this only in name mode, so "sixteenslut", "Sixteen Slut",
// "fifteenporn" and "16slut" were refused as a handle but published as a tag,
// a display name, a bio or a listing title -- the fields that feed the public
// tag cloud -- and the reverse glued order ("slutsixteen") passed even as a
// handle. It now runs on every text, name mode or not, on the text masked with
// NAME_COMPOUND_ALLOWLIST_RE (the spelled minor ages are NOT blanked;
// "nineteen", "eighteen", Kirsteen, Mateen, Steen, Teena are), in both orders,
// glued or with up to two separators:
//   - spelled ages eleven..seventeen with any MINOR_SEXUAL_WORD. Separated and
//     age-first, a counted thing after the sexual word makes it a count ("twelve
//     porn clips", "fifteen nudes for $30"), not an age.
//   - "ten" only as its own word, only with NAME_TEN_SEXUAL_WORD (not "dick",
//     "cum", "sex": "Ten Dickson", "Essex Ten", "tencummings", "sexten").
//   - digit ages 10-17. Never after another digit, a currency sign or a decimal
//     point ("2016", "$16", "1.16"), never as a count or a measure ("porn 10
//     min", "cum 12 times", "tits 10/10"). Glued ("16slut", "slut16") with the
//     sexual words that are not also things people count or measure (no
//     nudes/tits/boobs/dick/cock/xxx: "16nudes", "12cock"); separated and
//     age-first only with the singular person words ("16 slut", "16 whore",
//     whatever follows: "16 slut pics") or "pussy" when no counted thing
//     follows -- "10 sex toys", "12 porn scenes", "15 nudes" and "10 horny
//     girls" are counts -- plus "horny" ending the clause ("16 horny"); separated and
//     sexual-first with the same list as glued ("slut 16", "porn, 15").
const NAME_SPELLED_MINOR_ONLY = NAME_SPELLED_MINOR;
const MINOR_SEXUAL_WORD = '(?:cumsluts?|sluts?|porn|sex|nudes?|pussy|cum|xxx|fuck|dick|cock|tits|boobs|horny|whores?|hoes?|bitch(?:es)?|cunts?)';
const DIGIT_SEXUAL_WORD = '(?:cumsluts?|sluts?|porn|sex|pussy|cum|fuck|horny|whores?|hoes?|bitch(?:es)?|cunts?)';
// A singular person word after an age is the age of that person whatever
// follows ("Sixteen Slut set", "16 slut pics"): only the other sexual words
// can be counted things ("twelve porn clips").
const PERSON_SEXUAL_WORD = '(?:cumslut|slut|whore|hoe|bitch|cunt)';
const COUNTED_AFTER = `(?![\\s-]{1,3}(?:${COUNT_WORD}|for|each|ea|per|at|only|apiece)(?![a-z]))`;
const DIGIT_AGE = '(?<![0-9$\u00a3\u20ac.,])1[0-7]';
// Not a size, a rank, an episode or a day ("size 16 slut dress", "top 10
// pussy", "day 12 porn", "Top ten porn stars").
// Nor an aperture ("shot at f/16 horny", round-9's pass case).
const NOT_A_RANK = '(?<!(?:size|top|no|vol|ep|episode|part|pt|chapter|ch|day|week|level|lvl|number|#)[\\s.#:-]{0,2})(?<!f\\s?\\/\\s?)';
const DIGIT_NOT_A_COUNT = `${NOT_A_COUNT}(?![\\s-]{0,2}(?:each|ea|per|apiece|["'\u2033])(?![a-z]))`;
// Round-15 fix-up: "slut at 16", "horny at sixteen", "fucked at 15" and
// "porn at age 14", "slut at 16 years old" (a sexual word, then "at"/
// "aged"/"at age" and a minor age), and "sixteen and horny" (the spelled form of what "16 and horny"
// already refused). A clock time is not an age: "horny at 10pm", "at 16:00",
// "cum at 11 tonight" and "at 12 noon" pass. Accepted cost: a bare "horny at
// 10" with nothing after it reads as an age.
const AT_SEXUAL_WORD = `(?:${MINOR_SEXUAL_WORD}|fuck(?:s|ed|ing|in)|cumm(?:ing|ed)|bang(?:ed|ing)|sexy|naked|nude)`;
const AT_AGE_LEAD = `(?<![a-z])${AT_SEXUAL_WORD}[^a-z0-9]{1,3}(?:at(?:[^a-z0-9]{1,2}age)?|aged?)[^a-z0-9$\u00a3\u20ac]{1,2}`;
const NOT_A_TIME = "(?![\\s-]{0,2}(?:tonight|today|tomorrow|tmrw|noon|midnight|sharp|est|edt|pst|pdt|cst|cdt|mst|mdt|et|pt|ct|mt|gmt|utc|bst|cet|cest|o'clock|oclock)(?![a-z]))";
// A minor age standing on its own: digits 10-17, or a spelled eleven..seventeen.
const FREE_AGE_DIGIT = `${DIGIT_AGE}(?![0-9])`;
const FREE_AGE = `(?:${FREE_AGE_DIGIT}|(?<![a-z])${NAME_SPELLED_MINOR_ONLY}(?![a-z]))`;
// An age word that makes a PRECEDING number an age: "yo" / "y.o." alone, or
// years / yrs only with "old" ("16 year old", "15 yr old") -- "10 years porn
// experience" is a duration.
const AGE_OLD_AFTER = '[\\s-]{0,2}(?:yo|y\\.o\\.?|(?:years?|yrs?)[\\s-]{0,2}olds?)(?![a-z])';
// Round 17 (accounts#2): the adjectives that may sit between a digit age and
// the sexual or person word ("16 tight pussy", "15 little slut"). A fixed
// list: "new" / "real" / "fresh" are left out ("16 new pussy pics" is a
// count, and they describe content more than a person).
// A PRICE after the phrase makes its number a count ("15 nudes $30", "12 wet
// pussy $30", "10 hot pussy 20 each"): a currency sign, or a number with a
// currency word or a per-item word after it. A bare number alone is not a
// price here (round-19 fix-up: "Mia 16 wet pussy 25", "sexy 16 wet pussy 25"
// are an age with a number tacked on) -- a real menu ("Nudes 15, wet pussy
// 25") has its prices neutralized before any age rule runs.
const PAIR_PRICE_AFTER = '(?![^a-z0-9]{1,3}(?:[$\\u00a3\\u20ac]\\s?[0-9]|[0-9]{1,4}\\s?(?:[$\\u00a3\\u20ac]|usd|dollars?|bucks|each|ea|per|tokens?|credits?)(?![a-z])))';
const AGE_NOUN_ADJ = '(?:tight|wet|little|tiny|young|petite|horny|slutty|naughty|innocent|hot|sexy|cute|virgin|dirty|kinky|shy|sweet|skinny|nude|naked|busty|teen)';
// The singular person words a digit age labels in a tag or a handle ("16
// girl"); plurals are counts ("16 girls").
const STRICT_SINGULAR_PERSON = '(?:girl|boy|teen|babe|schoolgirl|schoolboy|virgin|daughter|stepdaughter|gf|bf|sis|stepsis)';
// SPELLED_AND plus the person adjectives, for labels only (tags, handles):
// "16 and petite", "16 and innocent".
const STRICT_AND = '(?=\\s*(?:and|&|n)\\s+(?:(?:so|very|super|always|really|still)\\s+)?(?:'
  + SEXUAL_ADJ + '|' + PERSON_OR_SEXUAL_NOUN + '|' + SEXUAL_VERB + '|' + PERSON_ADJ
  + '|loves?|likes?|wants?|needs?|craves?|craving|looking|lookin|ready|down|single|curious|into|dtf|a\\s+(?:virgin|slut|whore|girl|boy))(?![a-z]))';
// STRICT: the name-like short fields -- handle, username, social handles and
// each individual TAG (round-16 accounts#0-#3). A number beside a sexual word
// in a two-word label has no sentence around it to make it a count, so every
// order and separation is read as an age.
const MINOR_AGE_SEXUAL_STRICT_RE = new RegExp([
  // spelled, age first: glued, or separated and not a count
  `${NOT_A_RANK}(?<![a-z])${NAME_SPELLED_MINOR_ONLY}(?:${MINOR_SEXUAL_WORD}(?![a-z])|[^a-z0-9]{1,2}(?:${PERSON_SEXUAL_WORD}(?![a-z])|${MINOR_SEXUAL_WORD}(?![a-z])${COUNTED_AFTER}))`,
  // spelled, sexual word first, glued or separated ("slutsixteen", "slut.fifteen")
  `(?<![a-z])${MINOR_SEXUAL_WORD}[^a-z0-9$]{0,2}${NAME_SPELLED_MINOR_ONLY}(?![a-z])${COUNTED_AFTER}`,
  // "ten": its own word only, and only with the non-name sexual words
  `${NOT_A_RANK}(?<![a-z])ten[^a-z0-9]{1,2}(?:sluts?(?![a-z])|${NAME_TEN_SEXUAL_WORD}(?![a-z])${COUNTED_AFTER})`,
  `(?<![a-z])${NAME_TEN_SEXUAL_WORD}[^a-z0-9]{1,2}ten(?![a-z])`,
  // digits, age first, glued ("16slut", "16porn")
  `${NOT_A_RANK}${DIGIT_AGE}${DIGIT_SEXUAL_WORD}(?![a-z])`,
  // digits, age first, separated: the person words only, not a count
  `${NOT_A_RANK}${DIGIT_AGE}[^a-z0-9$]{1,2}(?:${PERSON_SEXUAL_WORD}(?![a-z])|pussy(?![a-z])${COUNTED_AFTER})`,
  // ...and with ONE adjective between (round-17 accounts#2: "16 tight
  // pussy", "15 little slut"), not a count ("12 wet pussy pics")
  `${NOT_A_RANK}${DIGIT_AGE}[^a-z0-9$]{1,2}${AGE_NOUN_ADJ}[^a-z0-9]{1,2}(?:${PERSON_SEXUAL_WORD}|pussy)(?![a-z])${COUNTED_AFTER}`,
  // digits, then a singular person word (round-17 accounts#2: the tag "16
  // girl"): a two-word label is an age
  `(?<![a-z0-9])${NOT_A_RANK}${DIGIT_AGE}[^a-z0-9$]{1,2}${STRICT_SINGULAR_PERSON}(?![a-z])`,
  // ...and with ONE adjective between ("16 hot girl", "15 little girl");
  // the plural stays a count ("16 hot girls")
  `(?<![a-z0-9])${NOT_A_RANK}${DIGIT_AGE}[^a-z0-9$]{1,2}${AGE_NOUN_ADJ}[^a-z0-9]{1,2}${STRICT_SINGULAR_PERSON}(?![a-z])`,
  `${NOT_A_RANK}${DIGIT_AGE}[^a-z0-9$]{1,2}horny${CLAUSE_END}`,
  // digits, sexual word first, glued or separated ("slut16", "porn, 15")
  `(?<![a-z])${DIGIT_SEXUAL_WORD}[^a-z0-9$\u00a3\u20ac]{0,2}${DIGIT_AGE}${DIGIT_NOT_A_COUNT}`,
  // a sexual word, then "at" / "aged" / "at age" and a minor age, not a clock time
  `${AT_AGE_LEAD}(?:${DIGIT_AGE}(?:${DIGIT_NOT_A_COUNT}${NOT_A_TIME}|[\\s-]{0,2}(?:years?|yrs?|yo)(?![a-z]))|${NAME_SPELLED_MINOR_ONLY}(?![a-z])${COUNTED_AFTER}${NOT_A_TIME})`,
  // the age with an age word after it, then the sexual word ("16 year old porn")
  `${NOT_A_RANK}${FREE_AGE}${AGE_OLD_AFTER}[^a-z0-9]{1,3}(?:${MINOR_SEXUAL_WORD}|${PERSON_SEXUAL_WORD})(?![a-z])`,
  // a spelled minor age, "and", a sexual adjective or noun ("sixteen and horny")
  `${NOT_A_RANK}(?<![a-z])${NAME_SPELLED_MINOR_ONLY}(?![a-z])${SEXUAL_AND}`,
  // round-17 accounts#2: in a label, a minor age (digits or spelled) and the
  // wider "and ..." list -- "16 and ready", "sixteen and ready", "16 and a
  // virgin", "16 and petite" -- the age opening the label (a tag "Order 16
  // and ready to ship" is a sentence). Free text keeps SEXUAL_AND.
  `(?:^|[^a-z0-9\\s-]\\s*)${FREE_AGE}${STRICT_AND}`,
  // round-17 accounts#3: a spelled minor age with yo / years old standing
  // alone ("fifteen years old", "sixteen yo", "fifteenyearsold"); digits
  // already are (MINOR_AGE_RES). Free text keeps "my blog is fifteen years
  // old".
  `(?:^|[^a-z0-9\\s]\\s*)(?<![a-z])${NAME_SPELLED_MINOR_ONLY}[\\s-]{0,2}(?:yo|y\\.o\\.?|(?:years?|yrs?)[\\s-]{0,2}old)(?![a-z])`,
].join('|'));

// "barely" + a minor age ("barely 16", "barelysixteen", "barely_sixteen") --
// the obvious variant of the listed "barely legal" (round-16 accounts#3), in
// EVERY context: nothing else reads "barely <age 10-17>" as a person. A count
// or a time after a digit is not an age ("barely 10 minutes left").
const MINOR_AGE_UNIT = '(?:gb|tb|mb|kb|gigs?|fps|bits?|mbps|kbps|pk|pcs|oz|ounces?|ml|mg|lb|mph|kph|k)';
const MONTH_WORD = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
// A count, a measure, a time or a date after a digit (free text only).
const FREE_NOT_A_COUNT = `${DIGIT_NOT_A_COUNT}${NOT_A_TIME}(?![\\s-]{0,2}(?:${MINOR_AGE_UNIT}|${MONTH_WORD}|new|vs|in\\s+1)(?![a-z]))`;
const BARELY_MINOR_AGE = `(?<![a-z])barely[^a-z0-9]{0,3}(?:${DIGIT_AGE}${FREE_NOT_A_COUNT}|${NAME_SPELLED_MINOR_ONLY}(?![a-z])${COUNTED_AFTER}${NOT_A_TIME})`;
const BARELY_MINOR_AGE_RE = new RegExp(BARELY_MINOR_AGE);

// Round 17 (accounts#1): the glued "<age> and <sexual word>" -- how a handle
// or a stored tag writes "16 and horny" ("16andhorny", "16nhorny",
// "sixteenandhorny", and "16.and.horny" / "sixteen_and_horny" once the
// separators are stripped). Every context, on the separator-stripped text,
// bounded on both sides; "18andhorny" is not a minor age.
// Round 18 (accounts#0): also after a name or a descriptor ("jess16andhorny",
// "hot16andhorny", "jess_sixteen_and_horny") and with "-" joiners
// ("16-and-horny", tested on a copy with "-" stripped too) -- the lookbehind
// only keeps a DIGIT age from being the tail of a longer number, the same
// stance GLUED_AGE_RE takes ("2016andhorny" / "18andhorny" are not minor
// ages). A spelled age takes any prefix: no ordinary word ends in
// "eleven".."seventeen", and "and" + a sexual word must follow. "and a
// virgin" is the glued "16-and-a-virgin".
const GLUED_AND_TAIL = `(?:and|n)(?:so|very|super)?(?:${SEXUAL_ADJ}|${PERSON_OR_SEXUAL_NOUN}|a(?:virgin|slut|whore|hoe|bitch))(?![a-z])`;
const GLUED_AND_RE = new RegExp(`(?:(?<![0-9])1[0-7]|${NAME_SPELLED_MINOR_ONLY})${GLUED_AND_TAIL}`);
// ...and for labels only (tags, handles): "16andready", and a glued
// self-description standing on its own ("im16", "shes16", "im_16").
// Round 19 (accounts#6): and the person adjectives STRICT_AND already reads
// spaced ("16 and petite"): "16andpetite", "16andinnocent".
const GLUED_AND_STRICT_RE = new RegExp(`(?<![a-z0-9])(?:1[0-7]|${NAME_SPELLED_MINOR_ONLY})(?:and|n)(?:ready|down|single|dtf|avirgin|aslut|petite|innocent|tiny|young|cute|sweet|little|shy|tight|pretty|skinny|curious|lonely|bored|fresh)(?![a-z])`
  + `|(?<![a-z0-9])(?:im|iam|shes|hes|only)1[0-7](?![0-9a-z])`);

// Round 18 (accounts#0, srv-auth-core#0/#1) -- DECIDED DESIGN for NAME-LIKE
// values: a handle, a username, a social handle, each tag, and a run of
// adjacent single-word tags read together. These are labels, written glued,
// so every rule above that needs a separator or a word boundary missed a
// shape: "16girl", "16tightpussy", "hotsixteenslut", "jess16andready",
// "jess_fifteen_yo", "16-and-ready". Here the value is SQUASHED -- folded
// lowercase with every non-alphanumeric removed ("-", "_", ".", spaces) --
// and refused when a minor age (a digit 10-17 with no digit on either side,
// or a spelled eleven..seventeen) sits directly next to:
//   - a sexual or singular person word (slut, whore, pussy, girl, boy, babe,
//     teen, virgin, gf, daughter...), in either order, optionally joined by
//     and / n / und, and (age first) optionally with ONE adjective from
//     AGE_NOUN_ADJ between ("16hotgirl", "16tightpussy");
//   - or, age first, yo / yearsold / yrsold (ending the value or before such
//     a word: "12yearoldwhiskey" is whisky), or ready / horny / wet.
// There is NO outer word boundary: letters may come before the age and after
// an "open" word ("jess16andhorny", "hot16andhorny", "16girlxo"). A refused
// handle costs its owner a different pick; a minor-suggestive handle is the
// worst case this platform has, so this over-refusal in name-like fields is
// ACCEPTED (e.g. "cowboy16" and "win10andready" are refused too).
// Kept passing, because nothing about them is an age beside such a word:
//   - PLURAL person words are counts, not ages ("16girls", "top10babes",
//     "16hotgirls"); the older strict rules still refuse "16sluts";
//   - a digit inside a longer number or code ("1080pgirl", "2016girl",
//     "y2kgirl", "win10pro"), and adult ages ("jess18andhorny");
//   - a rank word right before the number ("size16hotgirl", "top10hotgirl"),
//     as NOT_A_RANK already does in the strict rule;
//   - the "closed" words that begin or end ordinary names and words match
//     only as a whole word on the word's own side: porn (Pornell), sex
//     (Essex, Wessex, sexton), cum (Cumming), hoe (shoe), wet (wetsuit),
//     ready (ReadyBoost), yo (yoga) -- "Sixteen Pornell", "Eleven Cumming",
//     "Wessex Twelve" pass;
//   - after the age in word-first order, a count or a unit ("cum12times",
//     "porn10min").
// Tags are squashed per whitespace-separated word (a tag is often a phrase:
// "shot at f/16 horny", "10 pussy pics"); names and joined tag runs are
// squashed whole. The adult-age and name mask (NAME_COMPOUND_ALLOWLIST_RE:
// "nineteen", Kirsteen, Mateen...) is applied first and breaks adjacency.
const SQ_AGE = `(?:(?<![0-9])1[0-7](?![0-9])|${NAME_SPELLED_MINOR_ONLY})`;
const SQ_NOT_A_RANK = '(?<!(?:size|top|vol|episode|chapter|season|level|lvl|number|part|week|day))';
// Letters may follow these. The plural ("girls", "sluts", "bitches") is a
// count and does not match.
// Round 19 (accounts#2): the plural guard must not read the "s" of a
// following "sixteen"/"seventeen" as a plural -- "girlsixteen" published
// while "girlfifteen" was refused. (accounts#6): sis / stepsis / bf / twink,
// which the strict rule already treats as persons, were missing here.
const SQ_PLURAL = '(?!e?s(?!ixteen|eventeen))';
const SQ_OPEN_WORD = `(?:(?:cumslut|slut|whore|bitch|cunt|pussy|girl|boy|babe|teen|virgin|daughter|stepdaughter|schoolgirl|schoolboy|stepsister|stepsis|twink)${SQ_PLURAL}|horny|gf(?!x|s(?!ixteen|eventeen))|bf(?!s(?!ixteen|eventeen))|sis${SQ_PLURAL})`;
// Only as a whole word on the side away from the age.
const SQ_CLOSED_WORD = '(?:porn(?:o|star)?|sex(?:y|ual)?|cum|fuck(?:ed|ing|er|toy)?|hoe|wet|nude)';
const SQ_JOIN = '(?:(?:and|n|und)a?)?';
const SQ_COUNT_AFTER = '(?!(?:mins?|minutes?|hrs?|hours?|pm|am|times|x|k|inch(?:es)?|in|cm|mm|ft|pics?|photos?|vids?|videos?|clips?|th|st|nd|rd|percent|each|off|oz|gb|fps|bit)(?![a-z]))';
const SQUASHED_MINOR_AGE_RE = new RegExp([
  // age first: the word (open, or closed and ending there), optionally
  // through and/n/und and ONE adjective
  `${SQ_NOT_A_RANK}${SQ_AGE}${SQ_JOIN}(?:${AGE_NOUN_ADJ})?(?:${SQ_OPEN_WORD}|${SQ_CLOSED_WORD}(?![a-z]))`,
  // age first: an age word ending the value or followed by a sexual / person
  // word ("fifteenyearsold", "16yearsoldgirl" -- not "12yearoldwhiskey"), or
  // ready / wet
  `${SQ_NOT_A_RANK}${SQ_AGE}(?:(?:(?:years?|yrs?)(?:old|young)|yo)(?:(?![a-z])|(?=${SQ_OPEN_WORD}|${SQ_CLOSED_WORD}(?![a-z])))|${SQ_JOIN}(?:ready|wet)(?![a-z]))`,
  // word first (a closed word must start its word), optionally and/n/und,
  // then the age -- not a count or a unit
  `(?:${SQ_OPEN_WORD}|(?<![a-z])${SQ_CLOSED_WORD})(?:and|n|und)?${SQ_AGE}${SQ_COUNT_AFTER}`,
].join('|'));

// The squashed forms of a value (see SQUASHED_MINOR_AGE_RE): masked, then
// every non-alphanumeric dropped, either as one string or word by word.
// A tag stays word by word here: squashing "10 pussy pics" or "12 porn
// scenes" into one run would read the count as an age. The separated
// one-chip shapes ("16 porn", "girl 16", round-19 accounts#1) are the
// pairing rule's job (MINOR_AGE_PAIR_RE), which runs in every context with
// the count guards. The ordinary words that contain a pairing word (Essex,
// oasis, thorny...) are masked first, as they are for the pairing rule.
function squashedForms(ageText, perWord) {
  const masked = ageText.replace(NAME_ALLOWLIST_RE, '|').replace(NAME_COMPOUND_ALLOWLIST_RE, '|').replace(PAIR_NAME_MASK_RE, '|');
  const parts = perWord ? masked.split(/\s+/) : [masked];
  return parts.map((p) => p.replace(/[^a-z0-9|]+/g, '')).filter(Boolean);
}

// FREE TEXT: display name, bio, location, listing copy, DMs, wall posts
// (round-16 accounts#0-#2). The round-15 rule above refused ordinary counts,
// sizes, dates, units, ratings and titles next to a sexual word here ("porn
// 12 new scenes", "sex 16 bit", "tits ten out of ten", "twelve porn stars",
// "Ocean's Eleven porn parody") and logged them as minor-suggestive. In free
// text a minor age next to a sexual word is refused ONLY where the number
// clearly reads as a person's age:
//   - glued to the sexual word ("porn15", "slut16", "sixteenslut", "16slut");
//   - followed by yo / y.o. / years / yrs (old) ("porn 15 yo");
//   - after barely / only / just turned / i'm / she's / he's / aged / age
//     ("slut, only 16", "barely 16");
//   - followed directly by a singular person word ("16 slut", "Sixteen Slut
//     set", "horny 16 girl");
//   - followed by "and" + a sexual word ("16 and horny", "sixteen and horny");
//   - standing at the END of the clause beside the sexual word ("porn, 15",
//     "slut sixteen", "Twelve Porn", "16 horny") -- nothing follows that could
//     make it a count. A "/" (a rating, "ten/10") or "out of" does not end it,
//     and a "#" or an apostrophe before the digits is a rank or a year.
//   - after "at" / "aged" / "at age" (the round-15 AT rule, times excluded).
// Everything else -- counts, sizes, dates, units, ratings, listicles, parodies,
// times, prices -- passes. Plural sexual words age-first ("twelve sluts",
// "fifteen nudes") are counts here; the strict rule above still refuses them
// in a tag or a handle.
// A ':' or '.' followed by digits continues the number, not the clause ("slut
// 16:9 video" is an aspect ratio, "porn 16.5" a version).
const FREE_END = '(?=\\s*(?:$|[.!?;,:)\\]|]))(?!\\s*(?:\\/|out\\s+of|[:.]\\s*\\d))';
const AGE_WORD_AFTER = '[\\s-]{0,2}(?:yo|y\\.o\\.?|years?|yrs?)(?![a-z])';
// Free text only: a season / series / set / scene number is not an age
// ("season 13 porn", "set 12 nude") -- on top of NOT_A_RANK.
const FREE_NOT_A_RANK = `${NOT_A_RANK}(?<!(?<![a-z])(?:season|series|set|scene|clip|pic|photo|vid|video|round|take)[\\s.#:-]{0,2})`;
const AGE_LEAD = "(?:barely|only|just\\s+turned|i'?m|she'?s|he'?s|aged|age)";
const SINGULAR_PERSON = '(?:cumslut|slut|whore|hoe|bitch|cunt|girl|boy|teen|babe)';
// Sexual words that stand as a thing, not a count, when they end the clause.
const SINGULAR_SEXUAL = '(?:cumslut|slut|porn|sex|pussy|cum|xxx|fuck|dick|cock|horny|whore|hoe|bitch|cunt)';
const FREE_SEP = "[^a-z0-9$\u00a3\u20ac#'\u2019]{1,2}";
const FREE_AGE_TEN = `(?:${FREE_AGE}|(?<![a-z])ten(?![a-z]))`;
const MINOR_AGE_SEXUAL_FREE_RE = new RegExp([
  // glued, both orders
  `${FREE_NOT_A_RANK}(?<![a-z])${NAME_SPELLED_MINOR_ONLY}${MINOR_SEXUAL_WORD}(?![a-z])`,
  `(?<![a-z])${MINOR_SEXUAL_WORD}${NAME_SPELLED_MINOR_ONLY}(?![a-z])`,
  `${FREE_NOT_A_RANK}${DIGIT_AGE}${DIGIT_SEXUAL_WORD}(?![a-z])`,
  `(?<![a-z])${DIGIT_SEXUAL_WORD}${DIGIT_AGE}${FREE_NOT_A_COUNT}(?![a-z])`,
  // sexual word, then the age with an age word after it
  `(?<![a-z])${MINOR_SEXUAL_WORD}${FREE_SEP}${FREE_AGE}${AGE_WORD_AFTER}`,
  // the age with an age word after it, then the sexual word ("16 year old
  // porn", "fifteen yo nudes", "14 years old porn")
  `${FREE_NOT_A_RANK}${FREE_AGE}${AGE_OLD_AFTER}[^a-z0-9]{1,3}(?:${MINOR_SEXUAL_WORD}|${PERSON_SEXUAL_WORD})(?![a-z])`,
  // sexual word, then a lead-in, then the age. A DIGIT only after the
  // DIGIT_SEXUAL_WORD words (round-17 accounts#0): "nudes only 10 left" is a
  // stock count, "porn only 16" an age.
  `(?<![a-z])${DIGIT_SEXUAL_WORD}[^a-z0-9]{1,3}(?:(?:and|&)\\s+)?${AGE_LEAD}[^a-z0-9$\u00a3\u20ac]{1,3}${FREE_AGE_DIGIT}${FREE_NOT_A_COUNT}`,
  `(?<![a-z])${MINOR_SEXUAL_WORD}[^a-z0-9]{1,3}(?:(?:and|&)\\s+)?${AGE_LEAD}[^a-z0-9$\u00a3\u20ac]{1,3}(?<![a-z])${NAME_SPELLED_MINOR_ONLY}(?![a-z])${COUNTED_AFTER}${NOT_A_TIME}`,
  // a lead-in, the age, then a singular sexual person word
  `(?<![a-z])${AGE_LEAD}[^a-z0-9$\u00a3\u20ac]{1,3}${FREE_AGE}[^a-z0-9]{1,2}${PERSON_SEXUAL_WORD}(?![a-z])`,
  // the age, then a singular sexual person word ("16 slut", "ten slut")
  `${FREE_NOT_A_RANK}${FREE_AGE_TEN}[^a-z0-9$]{1,2}${PERSON_SEXUAL_WORD}(?![a-z])`,
  // ...or with ONE adjective between, not a count (round-17 accounts#2: "16
  // tight pussy", "15 little slut" -- but "10 hot slut videos")
  `${FREE_NOT_A_RANK}${FREE_AGE}[^a-z0-9$]{1,2}${AGE_NOUN_ADJ}[^a-z0-9]{1,2}${PERSON_SEXUAL_WORD}(?![a-z])${COUNTED_AFTER}`,
  // ..."pussy" unless a counted thing or a price follows it (round-18
  // accounts#1: "12 Wet Pussy Selfies", "10 wet pussy gifs" and the price menu
  // "Nudes 15, wet pussy 25" are counts and prices, as they are without the
  // adjective). Round 19 (accounts#0): round 18 required the phrase to END the
  // clause, so any continuation -- an emoji, "dm me", "here" -- published "16
  // wet pussy"; the exemptions are lookaheads again. The strict (tag / handle)
  // rule keeps its own version.
  `${FREE_NOT_A_RANK}${FREE_AGE}[^a-z0-9$]{1,2}${AGE_NOUN_ADJ}[^a-z0-9]{1,2}pussy(?![a-z])${COUNTED_AFTER}(?![\\s-]{1,3}(?:selfies?|gifs?|images?|closeups?|snaps?|shots?)(?![a-z]))${PAIR_PRICE_AFTER}`,
  // a sexual word, the age, then a singular person word ("horny 16 girl")
  `(?<![a-z])${MINOR_SEXUAL_WORD}${FREE_SEP}${FREE_AGE}[^a-z0-9]{1,2}${SINGULAR_PERSON}(?![a-z])`,
  // the age, "and", a sexual adjective or noun
  `${FREE_NOT_A_RANK}${FREE_AGE}${SEXUAL_AND}`,
  // the age and the sexual word ending the clause, both orders. A DIGIT only
  // after the DIGIT_SEXUAL_WORD words (round-17 accounts#0): "nudes 15,
  // videos 25", "tits 12" and "Cock 16" are prices, counts and ratings -- the
  // spelled "slut sixteen" / "nudes sixteen" still read as ages.
  `(?<![a-z])${DIGIT_SEXUAL_WORD}${FREE_SEP}${FREE_AGE_DIGIT}${FREE_END}`,
  `(?<![a-z])${MINOR_SEXUAL_WORD}${FREE_SEP}(?<![a-z])${NAME_SPELLED_MINOR_ONLY}(?![a-z])${FREE_END}`,
  `(?<![a-z])${NAME_TEN_SEXUAL_WORD}${FREE_SEP}ten(?![a-z])${FREE_END}`,
  `${FREE_NOT_A_RANK}${FREE_AGE_TEN}[^a-z0-9$]{1,2}${SINGULAR_SEXUAL}${FREE_END}`,
  // "at" / "aged" / "at age" (unchanged from the strict rule)
  `${AT_AGE_LEAD}(?:${DIGIT_AGE}(?:${DIGIT_NOT_A_COUNT}${NOT_A_TIME}|[\\s-]{0,2}(?:years?|yrs?|yo)(?![a-z]))|${NAME_SPELLED_MINOR_ONLY}(?![a-z])${COUNTED_AFTER}${NOT_A_TIME})`,
].join('|'));

// ROUND 19 -- THE PAIRING RULE, built to a combinatorial spec rather than to
// the strings of the last finding (lib/screen-generated.test.mjs generates
// the shapes; seven rounds running, every one-string fix was followed by the
// same shape with another separator, adjective, tail or order). A minor age
// directly beside a sexual or singular person word is refused in EVERY
// context -- name-like fields, tags and free text alike:
//   - the age: digits 10..17 (never inside a longer number, after a currency
//     sign, a decimal point or a "/"), or a spelled eleven..seventeen, with an
//     optional yo / years old / yrs old after it; "ten" only as its own word
//     and only with the sexual words that are not also names;
//   - the join: nothing, spaces (and "_" "." "-", read as spaces), or and / n
//     / & -- glued or spaced ("16andgirl", "girl n 16");
//   - ONE adjective may sit in front of the word, age first ("16 hot girl");
//   - letters may come before the pair ("jess16girl", "hotporn 16"); the
//     ordinary words that contain a pairing word are masked first
//     (PAIR_NAME_MASK_RE: Essex, oasis, thorny...);
//   - anything may FOLLOW (an emoji, "dm me", "here", "lol") -- except, after
//     a sexual CONTENT word (porn, sex, cum, nudes, pussy...), a counted or
//     measured thing, another noun, or a price, which make the number a count
//     ("12 porn scenes", "10 wet pussy pics", "15 nudes for $30", "cum 12
//     loads"). A singular PERSON word is an age whatever follows ("16 girl
//     nudes", "girl 16 nudes"); its plural is a count ("16 girls").
// Numbers that are never an age -- ranks, sizes, episodes, heights, ratings,
// price menus -- are neutralized BEFORE any age rule runs (neutralizeNonAges),
// so this rule, the older ones and the glued/squashed ones all agree on them.
// Person words, and the sexual person words (slut, whore...). Both are an
// age label whatever follows when nothing sits between them and the age ("16
// slut pics"); with an ADJECTIVE between, a sexual person word followed by a
// counted thing is a count ("10 hot slut videos"), as the spec's free-text
// carve-out has it.
const PAIR_PERSON_ONLY = '(?:girl|boy|babe|teen|virgin|gf|bf|stepsister|stepsis|sis|daughter|stepdaughter|twink|schoolgirl|schoolboy)';
const PAIR_SEXUAL_PERSON = '(?:cumslut|slut|whore|bitch|cunt)';
const PAIR_PERSON = `(?:${PAIR_PERSON_ONLY}|${PAIR_SEXUAL_PERSON})`;
// "xx+": the text reaching the rules has stretched letters folded to two
// (foldStretched), so "xxx" arrives as "xx".
const PAIR_CONTENT = '(?:porn|sex|cum|fuck|nudes?|xx+|pussy|horny|wet|naked)';
const PAIR_TEN_WORD = '(?:porn|fuck|slut|pussy|nudes?|horny|xx+)';
const PAIR_AGE_DIGIT = `${FREE_NOT_A_RANK}(?<![0-9$\u00a3\u20ac"/.][\\s]?)(?<![0-9])1[0-7](?![0-9])`;
const PAIR_AGE = `(?:${PAIR_AGE_DIGIT}|${NAME_SPELLED_MINOR_ONLY})`;
// Round 20 (accounts#10): never the start of "older" -- "years old" matched
// inside "years older", so "my gf 10 years older than me" read as an age.
// Not a full word boundary: the glued label "16 years oldslut" is an age.
const PAIR_AGE_WORD = '(?:\\s{0,2}(?:yo|years?\\s{0,2}olds?(?!er)|yrs?\\s{0,2}olds?(?!er)))?';
const PAIR_SEP = '(?:\\s{0,3}(?:and|&|n)?\\s{0,3})';
// A counted or measured thing after a content word (or after the age, word
// first): the COUNT_WORD units, the product nouns a listing counts, and any
// sexual or person noun (so "12 wet pussy" is read with "wet" as the
// adjective, and "10 horny girls" as a count).
const PAIR_COUNTED = `(?:${COUNT_WORD}|${MINOR_AGE_UNIT}|for|each|ea|per|at|only|apiece|stars?|scenes?|parod(?:y|ies)|toys?`
  + '|positions?|tips?|loads?|facials?|tributes?|guys|men|women|chicks|models?|selfies?|gifs?|images?|closeups?|snaps?|shots?'
  + '|tapes?|movies?|films?|sites?|bundles?|compilations?|comps|part|series|porn|sex|cum|fuck|nudes?|pussy|horny|wet|naked'
  + `|${PAIR_PERSON}s?)`;
// ...or any plural noun ("13 wet wipes"), but not the everyday words that
// merely end in "s".
const PAIR_PLURAL = '(?!(?:always|lets|thanks|kisses|xoxos|hugs|miss|kiss|yes|pls|plus|dms|ass|bless)(?![a-z]))[a-z]{3,}s(?![a-z])';
const PAIR_CONTENT_AFTER = `(?![\\s-]{1,3}(?:${PAIR_COUNTED})(?![a-z]))(?![\\s-]{1,3}${PAIR_PLURAL})${PAIR_PRICE_AFTER}`;
const PAIR_AFTER_AGE_CONTENT = `${FREE_NOT_A_COUNT}(?![\\s-]{1,3}(?:${PAIR_COUNTED})(?![a-z]))(?![\\s-]{1,3}${PAIR_PLURAL})`;
const PAIR_ADJ_PERSON = `(?:(?:${AGE_NOUN_ADJ}|porn|sex|xxx|cum|fuck)\\s{0,3})?`;
const PAIR_ADJ_CONTENT = `(?:${AGE_NOUN_ADJ}\\s{0,3})?`;
const MINOR_AGE_PAIR_RE = new RegExp([
  // age first
  `${PAIR_AGE}${PAIR_AGE_WORD}${PAIR_SEP}(?:${PAIR_ADJ_PERSON}${PAIR_PERSON_ONLY}(?![a-z])|${PAIR_SEXUAL_PERSON}(?![a-z])`
    + `|(?:${AGE_NOUN_ADJ}|porn|sex|xxx|cum|fuck)\\s{0,3}${PAIR_SEXUAL_PERSON}(?![a-z])${PAIR_CONTENT_AFTER}`
    + `|${PAIR_ADJ_CONTENT}${PAIR_CONTENT}(?![a-z])${PAIR_CONTENT_AFTER})`,
  // word first
  `${PAIR_PERSON}${PAIR_SEP}${PAIR_AGE}${PAIR_AGE_WORD}${FREE_NOT_A_COUNT}`,
  `${PAIR_CONTENT}${PAIR_SEP}${PAIR_AGE}${PAIR_AGE_WORD}${PAIR_AFTER_AGE_CONTENT}`,
  // "ten": its own word, separated, the non-name sexual words only
  `(?<![a-z])ten\\s{1,3}(?:(?:and|&)\\s{1,3})?${PAIR_TEN_WORD}(?![a-z])${PAIR_CONTENT_AFTER}`,
  `(?<![a-z])${PAIR_TEN_WORD}\\s{1,3}(?:(?:and|&)\\s{1,3})?ten(?![a-z])${PAIR_AFTER_AGE_CONTENT}`,
].join('|'));
// Ordinary words that contain a pairing word, blanked before the pairing and
// squashed rules run: the "-sex" places (Essex, Wessex, Sussex, Middlesex)
// and "unisex", "thorny", and the everyday "-sis" words (basis, oasis,
// crisis, genesis...). Add to it here when an honest word turns out refused.
// Whole words only: "jessex" (a folded "jesssex") is not Essex.
const PAIR_NAME_MASK_RE = /(?<![a-z])(?:(?:es|wes|sus|middle|uni)sex|thorny|(?:ba|oa|cri|the|gene|analy|empha|paraly|synthe|hypothe|diagno|progno|psoria|neme|osmo|neuro|psycho|metamorpho|parenthe|kine|mime|tme|i)sis)(?![a-z])/g;

// Numbers that are never a person's age, replaced by "0" before the age rules
// read the text (round 19, accounts#3 and srv-auth-core#0: "5'10 and sexy",
// "UK size 12 and sexy", "Rated 10/10 and sexy", "size-16-and-sexy",
// "ep-12-and-horny", "Used sex toys 15, lingerie 20" were refused and logged
// as minor content because each age rule carried its own, different guards):
//   - a rank, size, episode, chapter, season, volume, part, level, day, set...
//     word right before the number, with a real separator between them
//     ("size 16", "ep-12", "chapter fifteen") -- never glued ("set16girl",
//     "no16horny" are a name, not a rank), and "no" only as "no." / "no #"
//     ("no 16 and horny" is a sentence);
//   - a height: a single digit, a foot mark / "ft" / a dash, then 0-11 inches
//     ("5'10", "5ft10", "5-10") -- twelve or more inches is not a height, so
//     "5-16 slut" keeps its 16;
//   - a rating ("10/10", "12/10", "ten out of ten");
//   - an aperture after at/on/shot ("shot at f/16");
//   - a number after "#" or an apostrophe that follows a word ("porn #16",
//     "porn '16");
//   - a price in a MENU: a number with another "<words> <number>" item right
//     after it or right before it ("Nudes 15, videos 25", "Customs from 15.
//     Nudes 10.") -- unless the word in front of it is a singular person word
//     or a sexual adjective ("slut 16, porn 15", "sexy 16 wet pussy 25"), or
//     the number is directly followed by a sexual adjective or person word
//     and the word in front of it is not a menu item ("Mia 16 wet pussy 25",
//     "Emma 16 horny nudes 20"; "Custom nudes 15 wet pussy 25" is a menu).
// Round-19 fix-up: the rank list is only genuine rank/size/episode words.
// Ordinary nouns ("model", "gen", "room", "row", "unit", "rated", "pic",
// "vid"...) are how a minor would describe themselves ("cam model 16
// horny"), and neutralizing after them published exactly that.
// In NAME-LIKE contexts (handles, usernames, tags: strictAge), where
// over-refusal is accepted, only the height and rating guards and the
// narrowest size/episode words (NON_AGE_RANK_STRICT, separated:
// "size-16-and-sexy" as a #chip, srv-auth-core#0) apply -- a price tail or
// any other word must never launder "model16horny", "set16girl" or
// "Mia 16 wet pussy 25" into a handle or a #chip.
const NON_AGE_RANK = '(?:size|sz|top|num|number|vol|volume|ep|eps|episode|part|pt|chapter|chap|ch|day|week|wk|level|lvl|lv'
  + '|season|series|set|scene)';
const NON_AGE_RANK_STRICT_RE = new RegExp('(?<![a-z])((?:size|sz|vol|volume|ep|eps|episode|chapter|chap|season|part|level|lvl)[\\s._-]{1,3})'
  + '(?:[0-9]{1,4}(?![0-9])|(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)(?![a-z]))', 'g');
const NON_AGE_NUMBER = '(?:[0-9]{1,4}(?![0-9])|(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)(?![a-z]))';
const NON_AGE_RANK_RE = new RegExp(`(?<![a-z])(${NON_AGE_RANK}[\\s.#:_-]{1,3}|no\\s?[.#]\\s?)${NON_AGE_NUMBER}`, 'g');
// Round 20 (accounts#11), FREE text only: a device or software model number
// ("iPhone 15 nudes", "Windows 11 girl", "Galaxy S16 porn", "Pixel 12 selfies")
// is not an age. Only product names that no person is called -- never
// "model" or "gen", which a minor describing themselves uses ("cam model 16
// horny" stays refused). Tags and handles keep the strict rule.
const NON_AGE_PRODUCT_RE = /(?<![a-z])((?:iphone|ipad|ipod|ios|windows|galaxy(?:[\s._-]{0,2}(?:s|note|a|z|tab))?|pixel|android|xbox|playstation|macbook|imac|airpods|kindle)[\s._-]{0,3})(?:[0-9]{1,4}(?![0-9])|(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)(?![a-z]))/g;
const NON_AGE_HEIGHT_RE = /(?<![0-9])([1-9][\s-]?(?:['\u2019\u2032"]{1,2}|ft\.?|foot|feet|[-\u2013])[\s-]{0,2})(?:1[01]|[0-9])(?![0-9])/g;
const NON_AGE_RATING_RE = /(?<![a-z0-9])(?:[0-9]{1,3}|ten|eleven|twelve)(\s?(?:\/|out\s+of|outta)\s?)(?:5|10|100|ten)(?![0-9a-z])/g;
const NON_AGE_APERTURE_RE = /(?<=(?:at|on|shot|aperture|@)\s{0,2}f\s?\/\s?)[0-9]{1,2}(?![0-9])/g;
const NON_AGE_MARKED_RE = /(?<=[a-z0-9]\s?[#'\u2019])[0-9]{1,4}(?![0-9])/g;
const MENU_PERSON_WORD = new Set(['girl', 'boy', 'babe', 'teen', 'virgin', 'gf', 'bf', 'sis', 'stepsis', 'stepsister', 'daughter',
  'stepdaughter', 'twink', 'schoolgirl', 'schoolboy', 'cumslut', 'slut', 'whore', 'hoe', 'bitch', 'cunt', 'im', 'i\'m', 'am', 'aged',
  'age', 'turned', 'only', 'just', 'barely',
  // sexual adjectives: "sexy 16 wet pussy 25" is an age with a price tail
  'tight', 'wet', 'little', 'tiny', 'young', 'petite', 'horny', 'slutty', 'naughty', 'innocent', 'hot', 'sexy', 'cute', 'dirty',
  'kinky', 'shy', 'sweet', 'skinny', 'nude', 'naked', 'busty', 'freaky', 'thirsty', 'needy']);
// A sexual adjective or person word straight after the number...
const MENU_AGE_FOLLOW_RE = new RegExp(`^\\s{1,2}(?:${AGE_NOUN_ADJ}|freaky|thirsty|needy|${PAIR_PERSON})(?![a-z])`);
// ...is still a menu price only after an item noun ("Custom nudes 15 wet
// pussy 25").
const MENU_ITEM_WORD_RE = /^(?:pussy|nudes?|videos?|vids?|pics?|photos?|sexting|customs?|clips?|lingerie|panties|socks|toys?|sets?|tapes?|porn|xx+|boobs|tits|feet|gifs?|selfies?|ratings?|rates?|bundles?)$/;
// The next item's price has two digits or a currency sign, and is not a
// "24/7": "horny 16, dm me 4 more" is not a menu.
const MENU_PRICE = '(?:[$\\u00a3\\u20ac]\\s?[0-9]|[0-9]{2})(?![0-9]*\\s?\\/)';
const MENU_NEXT_RE = new RegExp('^\\s?(?:[,;|\\u2022/]\\s?(?:[a-z]+[\\s:]{1,2}){1,3}|\\s(?:[a-z]+\\s){0,2}'
  + '(?:pussy|nudes?|videos?|vids?|pics?|photos?|sexting|customs?|clips?|lingerie|panties|socks|toys?|sets?)\\s?:?\\s?)' + MENU_PRICE);
const MENU_PREV_RE = /(?:[$\u00a3\u20ac]\s?[0-9]{1,4}|[0-9]{2})\s?[,;|\u2022/.]\s?(?:[a-z]+[\s:]{1,2}){1,3}[$\u00a3\u20ac]?$/;
// Round 20 (accounts#0): a creator's menu is routinely DECORATED -- "Nudes 15
// 💦, videos 25 🎥", "Sexting 15 💬 Nudes 12 📸", "Nudes 12 & videos 20",
// "Nudes 15!! Videos 25!!", "Nudes 15 (5 pics) | Videos 25", one item per
// line -- and MENU_NEXT_RE / MENU_PREV_RE only knew one optional space and a
// [,;|•/]. So round 19's pairing rule read "Nudes 15" as an age and refused
// the whole menu as minor content. The item-separator tests now run on a copy
// in which an emoji run, a newline, "&", "and", a run of "!" and a short
// parenthetical are separators too, and separator runs and spaces collapse.
// The sexual-adjective / person-word guard (MENU_AGE_FOLLOW_RE) runs on the
// copy with emoji as SPACES and, also, past a leading separator: "Mia 16 💦
// wet pussy 25" and "Mia 16 & horny 20" are still an age with a price
// tacked on, never a menu.
const MENU_SEPARATED = (t) => t
  .replace(EMOJI_RUN_RE, ',')
  .replace(/\([^()]{0,30}\)/g, ',')
  .replace(/[\n\r&\u00b7\u2219\u22c5\u2661\u2665\u2764\u2606\u2605]+|!+|(?<![a-z])and(?![a-z])|\s+[-\u2013\u2014~*]+\s+|\s[~*]+|[~*]+\s/g, ',')
  .replace(/\s*[,;|\u2022/](?:\s*[,;|\u2022/])*\s*/g, ', ')
  .replace(/[ \t]+/g, ' ');
const MENU_SPACED = (t) => t.replace(EMOJI_RUN_RE, ' ').replace(/\s+/g, ' ');
const MENU_LEAD_SEP_RE = /^[\s,;|\u2022/&!()]*(?:and\s+)?/;
function neutralizeMenuPrices(text) {
  return text.replace(/(?<![0-9])[0-9]{1,4}(?![0-9])/g, (num, offset) => {
    const before = text.slice(Math.max(0, offset - 60), offset);
    const item = MENU_SPACED(before).match(/([a-z']+)[\s:]{1,2}[$\u00a3\u20ac]?$/);
    if (!item || MENU_PERSON_WORD.has(item[1])) return num;
    const after = text.slice(offset + num.length, offset + num.length + 60);
    const spaced = MENU_SPACED(after);
    if (!MENU_ITEM_WORD_RE.test(item[1])
      && (MENU_AGE_FOLLOW_RE.test(spaced) || MENU_AGE_FOLLOW_RE.test(` ${spaced.replace(MENU_LEAD_SEP_RE, '')}`))) return num;
    return MENU_NEXT_RE.test(after) || MENU_PREV_RE.test(before)
      || MENU_NEXT_RE.test(MENU_SEPARATED(after)) || MENU_PREV_RE.test(MENU_SEPARATED(before)) ? '0' : num;
  });
}
export function neutralizeNonAges(text, { strictAge = false } = {}) {
  let t = String(text ?? '')
    .replace(NON_AGE_HEIGHT_RE, (m, lead) => `${lead}0`)
    .replace(NON_AGE_RATING_RE, (m, mid) => `0${mid}0`);
  if (strictAge) return t.replace(NON_AGE_RANK_STRICT_RE, (m, lead) => `${lead}0`);
  t = t
    .replace(NON_AGE_RANK_RE, (m, lead) => `${lead}0`)
    .replace(NON_AGE_PRODUCT_RE, (m, lead) => `${lead}0`)
    .replace(NON_AGE_APERTURE_RE, '0')
    .replace(NON_AGE_MARKED_RE, '0');
  return neutralizeMenuPrices(t);
}
// Emoji and pictographs read as a space for the age rules: "16 horny 😈"
// ends its clause exactly as "16 horny" does (round-19 accounts#7).
const EMOJI_RUN_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]+/gu;
// A separator run between two DIGITS ("10|12", "5 - 16") is a range or a
// list of numbers, never a label boundary, and stays as it is.
const BIO_SEPARATOR_RE = /\s*[|\u2022\u00b7\u2219\u22c5\u2661\u2665\u2764\u2606\u2605~*]+\s*|(?<=\S)\s+[/\\\-\u2013\u2014]+\s+(?=\S)/g;
function bioSeparatorsAsCommas(text) {
  return text.replace(BIO_SEPARATOR_RE, (m, offset) => {
    const prev = text.slice(0, offset).trimEnd().slice(-1);
    const next = text.slice(offset + m.length).trimStart().charAt(0);
    return /[0-9]/.test(prev) && /[0-9]/.test(next) ? m : ', ';
  });
}
// The text the pairing rule reads: "y.o." / "y/o" as "yo", the name mask
// applied, and "_" "." "-" joiners between letters (or a digit and a letter)
// read as spaces. A "." or "-" between two digits stays (a decimal, a range).
function pairTextOf(text) {
  return text
    .replace(/(?<![a-z])y\s?[./]\s?o(?:\.|(?![a-z]))/g, 'yo')
    .replace(PAIR_NAME_MASK_RE, ' ')
    .replace(/(?<=[a-z])[_.-]+(?=[a-z0-9])|(?<=[0-9])[_.-]+(?=[a-z])/g, ' ');
}

// Round 12 (accounts#0): round 11 dropped the WHOLE compound tier in name
// mode, not just the few terms real names collide with, so "@sexyschoolgirl",
// "@underagebabe", "@jailbaitbabe" and "@mylolita" published again. Two more
// slices come back:
//
//  1. Every compound term with NO real-name collision runs in full
//     (NAME_SAFE_COMPOUND). Left out, and why: "teen" (Steen, Kirsteen,
//     Justeen, Christeen), "rape" (Laura Peters, Kiara Perez), "loli" (Paulo
//     Lima, Danilo Lima), "incest" (Vince Stone, Vince Steele), "ageplay"
//     (Paige Playford).
//  2. Those five-minus-rape are caught glued to the everyday descriptors a
//     minor-suggestive handle is built from (NAME_DESCRIPTOR: "hotteen",
//     "teengirl", "cuteteen", "littleloli", "hotincest"), and "incest" also at
//     the START of a word ("incestlover") -- no name begins with it; Vince
//     Stone has it after a letter. Run on the allowlist-masked text, so
//     "steen", "jessteen" and "hotsteen" stay names.
const NAME_SAFE_COMPOUND_TERMS = new Set([
  'preteen', 'underage', 'jailbait', 'barely legal', 'schoolgirl', 'schoolboy', 'lolita', 'lolicon', 'shotacon',
  'pedophile', 'paedophile', 'pedophilia', 'paedophilia', 'child porn', 'nonconsent', 'nonconsensual',
  'bestiality', 'beastiality', 'zoophilia', 'zoophile', 'necrophilia',
  // (and the school and child pair groups, flagged nameSafeCompound: no first
  // name or surname glues into "highschoolgirl" / "kidporn")
]);
const NAME_SAFE_COMPOUND = COMPILED_COMPOUND.filter((t) => NAME_SAFE_COMPOUND_TERMS.has(t.term) || t.nameSafeCompound);
const compoundBody = (term) => [...term].map((ch) => COMPOUND_LEET[ch] || ch).join('');
// With the same digit swaps as the term ("h0tteen"). Round 13 (accounts#0):
// the round-12 list was twelve words, so "naughtyteen", "sweetteen",
// "teenqueen" and "teenlover" published while the same string as a tag was
// refused. Round 14 (accounts#1): round 13 claimed the PERSON_ADJ descriptors
// but left most of them out, so the commonest porn-category handles
// ("asianteen", "ebonyteen", "legalteen", "amateurteen") still published;
// they, "legal", "nubile" and the anime/hentai leads ("animeloli") are here
// now. Each is only ever tested GLUED to the term, on the allowlist-masked
// text, so a surname (Steen, Kirsteen) is never involved.
const NAME_DESCRIPTOR_WORDS = [
  'hot', 'sexy', 'cute', 'girl', 'boy', 'babe', 'model', 'petite', 'tiny', 'young', 'little', 'baby',
  'naughty', 'sweet', 'kinky', 'shy', 'innocent', 'fresh', 'busty', 'wet', 'pretty', 'slutty', 'dirty', 'tight',
  'virgin', 'skinny', 'naked', 'nude',
  'blonde', 'blond', 'brunette', 'redhead', 'ginger', 'amateur', 'thick', 'curvy', 'chubby', 'ebony', 'asian',
  'latina', 'freaky', 'nasty', 'brat', 'slim', 'wild', 'exotic', 'nubile', 'legal', 'real', 'perfect', 'horny',
  'anime', 'hentai',
  'queen', 'angel', 'doll', 'princess', 'lover', 'body', 'cutie', 'kitty',
];
const PLURAL_DESCRIPTORS = new Set(['girl', 'boy', 'babe', 'model', 'queen', 'angel', 'doll', 'lover', 'cutie']);
const NAME_DESCRIPTOR = `(?:${NAME_DESCRIPTOR_WORDS
  .map((w) => compoundBody(w) + (PLURAL_DESCRIPTORS.has(w) ? '(?:s)?' : '')).join('|')})`;
// "my" only at the start of a word ("myteen"): inside one it is the end of
// a first name (Amy, Jimmy).
const NAME_LEAD_MY = '(?<![a-z])my';
// "rape" and "ageplay" collide with real names too (Laura Peters, Paige
// Playford), so they get no descriptor list and no word-start rule -- only
// the few words a glued rape-/age-play handle is actually built from.
const NAME_PLAY_WORD = '(?:play|roleplay|fantasy|fantasies|fetish|lover|porn|sex|babe|girl|boy)';
// In front of the term, only words no surname ends in ("Essex Rapelje" must
// not read as "sex" + "rape").
const NAME_PLAY_LEAD = '(?:fantasy|fetish|porn|roleplay)';
const NAME_DESCRIPTOR_RES = [
  { term: 'teen', category: 'minor-suggestive' },
  { term: 'loli', category: 'minor-suggestive' },
  { term: 'incest', category: 'incest' },
].map((t) => {
  const body = compoundBody(t.term);
  // A term at the START of a word, followed by more letters: no real name
  // begins with "teen" (other than Teena, below), "loli" (Lolita and the
  // lolipop spelling are handled on their own) or "incest" -- the names that
  // contain them have them after a letter (Kirsteen, Paulo Lima, Vince
  // Stone). "Teena"-prefixed names ("teenamarie") are left alone, except
  // the "a" words no Teena name spells: "teenass", and (round-14 accounts#1)
  // "teenanal", "teenamateur", "teenasian", "teenaddict".
  const tail = t.term === 'teen'
    ? '(?:(?![a4@])[a-z0-9]|[a4@](?:[s5$]{2}|n[a4@]l|m[a4@]teur|[s5$]i[a4@]n|ddict))'
    : '[a-z0-9]';
  const startOfWord = `|(?<![a-z])${body}(?=${tail})`;
  return { ...t, re: new RegExp(`(?:${NAME_DESCRIPTOR}|${NAME_LEAD_MY})${body}|${body}${NAME_DESCRIPTOR}${startOfWord}`) };
}).concat([
  { term: 'rape', category: 'non-consensual' },
  { term: 'ageplay', category: 'minor-suggestive' },
].map((t) => ({ ...t, re: new RegExp(`${compoundBody(t.term)}${NAME_PLAY_WORD}|${NAME_PLAY_LEAD}${compoundBody(t.term)}`) })));

// Round 20 (accounts#2): ages UNDER TEN. Every rule above is built on 10-17,
// so "9yo girl", "8 year old girl", "7yo pussy" and "I'm 9 and horny" were
// screened nowhere -- the most unambiguous CSAM search shapes there are. A
// single digit is also most of ordinary English ("9 to 5", "my 5 year old
// car", "5 years of experience", "a 3 year old laptop"), so this rule is
// deliberately narrow and needs one of, in every context:
//   - an explicit age word (yo, y.o., y/o, year(s) old, yrs old) AND, next to
//     it in either order, a person or sexual word (optionally one adjective
//     between: "5 year old little girl");
//   - a self-description lead-in ("i'm 9", "she's 7 years old", "age: 8")
//     ending the clause (with or without an age word), or with "and" + a
//     sexual word;
//   - a bare digit and "and horny" / "and naked" / "and a virgin" ("9 and
//     horny").
// The family nouns (daughter, son, kid...) are NOT person words here: "my 5
// year old daughter" is a parent. "girl"/"boy" are, plural too -- the
// accepted cost is that "my 3 year old girls" has to say "daughters".
// In a tag or a name the bare "9yo" is refused as well (a label is only ever a
// person's age), glued forms included ("jess9yo", "9yogirl").
const SINGLE_AGE = '(?:(?<![0-9$\u00a3\u20ac.])(?<![0-9],)[1-9](?![0-9])|(?<![a-z])(?:one|two|three|four|five|six|seven|eight|nine)(?:(?![a-z])|(?=yo(?![a-z]))))';
const SINGLE_AGE_WORD = '[\\s-]{0,2}(?:yo|y\\.?o\\.?|y\\s?\\/\\s?o|years?[\\s-]{0,2}old|yrs?[\\s-]{0,2}old)(?![a-z])(?!\\s*mama)';
const SINGLE_AGE_PERSON = '(?:girls?|boys?|babes?|teens?|virgin|gf|bf|twink|schoolgirl|schoolboy|sluts?|whores?|bitch|hoe|cunt|cumslut'
  + '|porn|porno|pussy|nudes?|naked|sex|cum|fuck|horny|xx+)';
// Round 20 fix-up: the sexual ADJECTIVES, from the same SEXUAL_ADJ list the
// two-digit rules use (plus "tight", AGE_NOUN_ADJ's), so the two cannot drift:
// "sexy 9 year old", "9 yo wet" and "slutty 9yo" were refused at 16 and
// published at 9. Three SEXUAL_ADJ words are left out because a parent says
// them about a small child every day ("my dirty 3 year old after the park",
// "a needy 2 year old", "thirsty 4 year old") -- the same reason the family
// nouns are not person words above. An adjective next to the age counts only
// when no thing follows it (NOT_A_THING: "my wet 5 year old dog" is a dog) and,
// for "naughty" alone, no family noun either ("my naughty 5 year old son").
const SINGLE_AGE_EXCLUDED_ADJ = new Set(['dirty', 'thirsty', 'needy']);
const SINGLE_AGE_ADJ_WORDS = [...SEXUAL_ADJ.slice(3, -1).split('|').filter((w) => !SINGLE_AGE_EXCLUDED_ADJ.has(w)), 'tight'];
const SINGLE_FAMILY_AFTER = '(?![\\s-]{1,3}(?:sons?|daughters?|kids?|child|children|nieces?|nephews?|grandsons?|granddaughters?|toddlers?|twins?)(?![a-z]))';
const SINGLE_ADJ_GUARD = (adj) => `${NOT_A_THING}${adj === 'naughty' ? SINGLE_FAMILY_AFTER : ''}`;
// One alternative per adjective (so the family guard can apply to "naughty"
// only), in both orders: adjective then age ("sexy 9 year old") and age then
// adjective ("9 year old sexy").
const SINGLE_ADJ_ALTS = SINGLE_AGE_ADJ_WORDS.flatMap((adj) => [
  `(?<![a-z])${adj}[\\s_.,:-]{1,3}${SINGLE_AGE}${SINGLE_AGE_WORD}${SINGLE_ADJ_GUARD(adj)}`,
  `${SINGLE_AGE}${SINGLE_AGE_WORD}[\\s_.,:-]{1,3}${adj}(?![a-z])${SINGLE_ADJ_GUARD(adj)}`,
]);
const SINGLE_AND = '(?=\\s*(?:and|&|n)\\s+(?:(?:so|very|super|always|really)\\s+)?(?:horny|slutty|kinky|nude|naked|a\\s+(?:virgin|slut|whore|hoe|bitch))(?![a-z]))';
const SINGLE_DIGIT_AGE_RE = new RegExp([
  `${SINGLE_AGE}${SINGLE_AGE_WORD}[\\s_.,:-]{0,3}(?:${AGE_NOUN_ADJ}[\\s_.-]{1,3})?${SINGLE_AGE_PERSON}(?![a-z])`,
  `(?<![a-z])${SINGLE_AGE_PERSON}[\\s_.,:-]{1,3}${SINGLE_AGE}${SINGLE_AGE_WORD}`,
  // ...ending the clause ("i'm 9", "she's 7 years old.") or with "and" +
  // a sexual word -- never followed by anything else ("I'm 1 year old on
  // here" is an account anniversary).
  `${SELF_LEAD}${SINGLE_AGE}(?:${SINGLE_AGE_WORD})?(?:(?=\\s*(?:$|[.!?;,)]))|${SINGLE_AND})`,
  `(?<![0-9$\u00a3\u20ac./a-z])[1-9](?![0-9])${SINGLE_AND}`,
  ...SINGLE_ADJ_ALTS,
].join('|'));
const SINGLE_DIGIT_AGE_STRICT_RE = /(?<![0-9a-z])[1-9]\s?(?:yo|y\.?o\.?|y\s?\/\s?o)(?![a-z])/;
// The glued (tag / name) form of the same person, sexual and adjective words.
const SINGLE_SQUASHED_WORDS = `girl|boy|babe|teen|virgin|slut|whore|pussy|porn|nudes?|naked|sex|cum|fuck|${SINGLE_AGE_ADJ_WORDS.join('|')}`;
const SINGLE_DIGIT_AGE_SQUASHED_RE = new RegExp(`(?<![0-9])[1-9](?:yo|y(?:ea)?rs?old)(?:(?![a-z])|(?=(?:${SINGLE_SQUASHED_WORDS})))`
  + `|(?:${SINGLE_SQUASHED_WORDS})[1-9](?:yo|y(?:ea)?rs?old)(?![a-z])`);
// Round 20 fix-up: the single-digit LABEL ("Mia, 9, slut", "Mia | 9 | slut"
// once the bio separators read as commas; "9, horny"), in tags and names
// only. In free text a lone digit between commas is a list or a count ("Top
// 3, sexy"), so it is not screened there.
const SINGLE_LABEL_WORD = `(?:${SEXUAL_ADJ}|${STRICT_SINGULAR_PERSON_EARLY}|${SEXUAL_NOUN_SINGULAR}|${LABEL_SEXUAL_WORD})`;
const SINGLE_DIGIT_LABEL_STRICT_RE = new RegExp(`(?:^|,)\\s*(?<![0-9])[1-9](?![0-9])\\s*,\\s*${SINGLE_LABEL_WORD}(?![a-z])`
  + `|(?<![a-z])(?:${SEXUAL_ADJ}|${STRICT_SINGULAR_PERSON_EARLY}|${SEXUAL_NOUN_SINGULAR})\\s*,\\s*[1-9](?![0-9])(?=\\s*(?:$|[,.!?;]))`);

// Every under-18 age rule, on one reading of the text (curly apostrophes
// folded, non-age numbers already neutralized). True when any of them hits.
function minorAgeHit(ageText, { strictAge, squashWhole }) {
  // Handles, usernames and tags join words with "_" and "." ("hot_16_yo",
  // "jess.16.yo", "im_16"). Read those as spaces for the age rules -- except a
  // "." between two letters ("16 y.o") or two digits ("v1.16", a decimal) --
  // and, separately, with them removed for the glued forms (GLUED_AGE_RE).
  const spaced = ageText.replace(/(?<=[a-z0-9])_+(?=[a-z0-9])|(?<=[0-9])\.(?=[a-z])|(?<=[a-z])\.(?=[0-9])/g, ' ');
  const glued = ageText.replace(/(?<=[a-z0-9])[_.]+(?=[a-z0-9])/g, '');
  if (MINOR_AGE_RES.some((re) => re.test(ageText) || re.test(spaced)) || GLUED_AGE_RE.test(glued)) return true;
  // Round 20 (accounts#2): ages under ten (SINGLE_DIGIT_AGE_RE).
  if (SINGLE_DIGIT_AGE_RE.test(spaced) || SINGLE_DIGIT_AGE_RE.test(pairTextOf(spaced))) return true;
  if (strictAge && (SINGLE_DIGIT_AGE_STRICT_RE.test(spaced) || SINGLE_DIGIT_LABEL_STRICT_RE.test(spaced)
    || squashedForms(ageText, !squashWhole).some((f) => SINGLE_DIGIT_AGE_SQUASHED_RE.test(f)))) return true;
  // A minor age next to a sexual word, in EVERY mode (round-15 accounts#0):
  // tags, display names, bios, locations and listing copy as well as handles.
  // On the name mask (spelled minor ages kept, "nineteen" and the name
  // collisions blanked).
  // Round 16: the strict rule for name-like fields and tags, the narrower
  // free-text rule everywhere else (see MINOR_AGE_SEXUAL_FREE_RE), and
  // "barely" + a minor age in both.
  const ageMasked = ageText.replace(NAME_ALLOWLIST_RE, ' ').replace(NAME_COMPOUND_ALLOWLIST_RE, ' ');
  const ageRe = strictAge ? MINOR_AGE_SEXUAL_STRICT_RE : MINOR_AGE_SEXUAL_FREE_RE;
  const gluedAge = ageMasked.replace(/(?<=[a-z0-9])[_.]+(?=[a-z0-9])/g, '');
  // ...and with "-" joiners removed too, for the glued "and" forms only
  // ("16-and-horny", "jess-16-and-horny"; round-18 accounts#0).
  const gluedDash = ageMasked.replace(/(?<=[a-z0-9])[-_.]+(?=[a-z0-9])/g, '');
  return ageRe.test(ageMasked) || BARELY_MINOR_AGE_RE.test(ageMasked) || BARELY_MINOR_AGE_RE.test(gluedAge)
    || GLUED_AND_RE.test(gluedAge) || GLUED_AND_RE.test(gluedDash) || GLUED_AND_RE.test(glued)
    // Round 19: the pairing rule, in every context (MINOR_AGE_PAIR_RE).
    || MINOR_AGE_PAIR_RE.test(pairTextOf(ageMasked))
    || (strictAge && GLUED_AND_STRICT_RE.test(gluedAge))
    // Name-like values: the squashed rule (round 18), the whole value for a
    // name or a joined tag run, word by word for a single tag.
    || (strictAge && squashedForms(ageText, !squashWhole).some((f) => SQUASHED_MINOR_AGE_RE.test(f)));
}

function detectIn(normalized, add, { compound = true, strictAge = !compound, squashWhole = !compound } = {}) {
  if (!normalized) return;
  for (const t of COMPILED) {
    const { term, category, re, disclaimable } = t;
    if (t.words) {
      for (const m of normalized.matchAll(re)) {
        if (!/[a-z]/.test(m[0])) continue;
        const word = pairWordOf(t, m.groups.w);
        if (!strictAge && t.softWords?.has(word) && isSchoolReminiscence(normalized, m.index, m[0], m.groups.w)) continue;
        add(`${term} ${word}`, category);
        break;
      }
      continue;
    }
    if (disclaimable) {
      for (const m of normalized.matchAll(re)) {
        if (/[a-z]/.test(m[0]) && !isDisclaimed(normalized, m.index, m.index + m[0].length)) {
          add(term, category);
          break;
        }
      }
      continue;
    }
    const m = normalized.match(re);
    // A term still has to contain a real letter -- "7337" is a number.
    if (m && /[a-z]/.test(m[0])) add(term, category);
  }
  if (GRADE_PAIR_RE.test(normalized) || (strictAge && GRADE_BARE_STRICT_RE.test(normalized))) {
    add('school grade', 'minor-suggestive');
  }
  if (strictAge && CHILD_PAIR_STRICT_RE.test(normalized)) add('child content label', 'minor-suggestive');
  // Curly apostrophes (the iOS default) read as straight ones for the
  // self-description lead-ins.
  const ageBase = normalized.replace(/[\u2018\u2019\u02bc]/g, "'");
  // Round 19: every age rule reads the text twice -- as typed, and with emoji
  // read as spaces (so "16 horny" plus an emoji ends its clause like "16 horny") -- and
  // both times with the numbers that are never an age neutralized first
  // (neutralizeNonAges: ranks, sizes, heights, ratings, price menus).
  // Round 20 (accounts#0): the emoji-as-space reading is made from the
  // NEUTRALIZED as-typed text (and neutralized again), so a price the
  // decorated menu showed to be a price ("Sexting 15 💬 Nudes 12") stays one:
  // with the emoji already spaces the item separator was gone.
  const ageVariants = [ageBase];
  const noEmoji = ageBase.replace(EMOJI_RUN_RE, ' ');
  if (noEmoji !== ageBase) ageVariants.push(noEmoji);
  // Round 20 (accounts#4): and once more with the bio separators read as
  // commas, AFTER the non-ages are neutralized (so a "Nudes 15 | Videos 25"
  // menu, a "5 - 10" height or a "10/10" rating is already a 0): "Jess | 16 |
  // horny", "Mia · 15 · horny girl", "jess ♡ 16 ♡ slut", "horny | 16", "16 |
  // horny | dm me" are the "Jess, 16, horny" profile shape every comma rule
  // already refuses. "/" and "-" count only padded with spaces ("Jess / 16 /
  // horny"): unpadded they are a rating, a range or an "f/16" label.
  const typed = neutralizeNonAges(ageBase, { strictAge });
  const neutralized = [typed];
  if (ageVariants.length > 1) neutralized.push(neutralizeNonAges(typed.replace(EMOJI_RUN_RE, ' '), { strictAge }));
  if (neutralized.some((n) => {
    if (minorAgeHit(n, { strictAge, squashWhole })) return true;
    const bio = bioSeparatorsAsCommas(n);
    return bio !== n && minorAgeHit(neutralizeNonAges(bio, { strictAge }), { strictAge, squashWhole });
  })) {
    add('under-18 age', 'minor-suggestive');
  }
  const masked = normalized.replace(NAME_ALLOWLIST_RE, ' ').replace(COMPOUND_ALLOWLIST_RE, ' ');
  if (!compound) {
    // On masked text too (round-13 accounts#3): "kirsteendickson" and
    // "justeencummings" are a first name and a surname, not "teen" + "dick".
    // But NOT with the spelled minor ages blanked (round-14 accounts#0):
    // "sixteenslut" must still read as "teen" + "slut".
    const nameMasked = normalized.replace(NAME_ALLOWLIST_RE, ' ').replace(NAME_COMPOUND_ALLOWLIST_RE, ' ');
    for (const { term, category, re } of NAME_COMPOUND_RES) if (re.test(nameMasked)) add(term, category);
    for (const { term, category, re } of NAME_DESCRIPTOR_RES) if (re.test(nameMasked)) add(term, category);
  }
  for (const t of compound ? COMPILED_COMPOUND : NAME_SAFE_COMPOUND) {
    const { term, category, re, disclaimable } = t;
    for (const m of masked.matchAll(re)) {
      if (disclaimable && isDisclaimed(masked, m.index, m.index + m[0].length)) continue;
      if (/[a-z]/.test(m[0])) {
        add(t.words ? `${term} ${pairWordOf(t, m.groups.w)}` : term, category);
        break;
      }
    }
  }
}

// Round 20 (accounts#9): a school GRADE (6th..12th, "grade 7".."grade 12")
// beside a person or sexual word, in every context: "9th grade girl", "8th
// grader slut", "grade 9 nudes", "horny 10th grader". Only a singular person
// word ("9th grade girls basketball" is a team) and never "sex ed". "my 9th
// grade teacher" and "I teach 8th graders" pass -- the teacher, and the plural
// grader with no such word.
const GRADE = '(?:(?<![0-9])(?:[6-9]|1[0-2])(?:st|nd|rd|th)[\\s_.-]{0,2}grade(?:rs?)?|(?<![a-z])grade[\\s_.-]{0,2}(?:[6-9]|1[0-2])(?![0-9]))';
const GRADE_WORD = `(?:girl|boy|babe|teen|virgin|gf|bf|twink|daughter|slut|whore|bitch|hoe|cunt|nudes?|porn|pussy|horny|cum|naked|fuck|sex${SEX_EDUCATION_AFTER})`;
const GRADE_PAIR_RE = new RegExp(`${GRADE}(?![a-z])[^a-z0-9]{0,3}(?:${AGE_NOUN_ADJ}[^a-z0-9]{1,3})?${GRADE_WORD}(?![a-z])`
  + `|(?<![a-z])${GRADE_WORD}[^a-z0-9]{1,3}(?:${AGE_NOUN_ADJ}[^a-z0-9]{1,3})?${GRADE}(?![a-z])`
  // glued in a label: "9thgradegirl", "9thgraderslut"
  + `|${GRADE}(?:and|n)?${GRADE_WORD}(?![a-z])`);
// ...and in a TAG or a NAME a grade-level person noun on its own ("8th
// grader", "8thgrader") or "high/middle schooler" -- as a label it can only
// describe the person.
const GRADE_BARE_STRICT_RE = /(?<![0-9a-z])(?:[6-9]|1[0-2])(?:st|nd|rd|th)[\s_.-]{0,2}graders?(?![a-z])|(?<![a-z])(?:high|middle|jr|junior)[\s_.-]{0,2}(?:schoolers?|high[\s_.-]{0,2}schoolers?)(?![a-z])/;

// The screenPublicText contexts that are a single name token.
export const NAME_LIKE_CONTEXTS = new Set(['handle', 'username']);

// A social handle (the twitter/instagram/tiktok/reddit link fields) is just
// as often firstnamelastname as a platform handle is, so it is judged the
// same way (round-13 accounts#1: "clarapearson" as an Instagram was refused
// and logged as "rape"). The website field is a full URL: full mode.
export function isNameLikeContext(context) {
  if (typeof context !== 'string') return false;
  return NAME_LIKE_CONTEXTS.has(context) || (context.startsWith('social_') && context !== 'social_website');
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
export function screenPublicText(text, { context = null } = {}) {
  if (text === null || text === undefined || text === '') return null;
  // A handle, a fan's username or a social handle is judged word by word
  // (splitNameWords).
  // A tag is a short label like a handle for the minor-age rule (round-16
  // accounts#0-#3: strict for name-like fields and each individual tag), but
  // otherwise judged as full text.
  const nameLike = isNameLikeContext(context);
  const prohibited = detectProhibitedTerms(text, { nameLike, strictAge: nameLike || context === 'tag' });
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
  return raw
    .filter((t) => typeof t === 'string' && t.trim())
    .slice(0, 50)
    .map((t) => compactPadding(t.trim()).slice(0, 100));
}

// Runs of whitespace fold to one space and runs of four or more punctuation
// characters to their first three, BEFORE the 100-character cap: otherwise a
// tag padded with 100+ "!" or spaces in front of the real word ("!!!...school")
// is screened as punctuation only while sanitizeTags publishes the word. Both
// replaces are linear (no end anchor, one greedy class per match).
function compactPadding(text) {
  return text.replace(/\s+/g, ' ').replace(/([^\p{L}\p{N}\s]{3})[^\p{L}\p{N}\s]+/gu, '$1');
}
