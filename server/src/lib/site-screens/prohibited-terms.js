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

function buildRe({ term, suffixes = '(?:s|es|ed|er|ers|ing)?' }, flags = '') {
  const body = term.split(' ').map(wordPattern).join(WORD_GAP);
  // Plural/verb suffixes stay matched ("teens"); an adjacent LETTER breaks the
  // match so "eighteen", "canteen" and "grape" never do.
  return new RegExp(`(?<![a-z])${body}${suffixes}(?![a-z])`, flags);
}

const COMPILED = PROHIBITED_TERMS.map((t) => ({ ...t, re: buildRe(t, t.disclaimable ? 'g' : '') }));

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
const SEXUAL_AND = '(?=\\s*(?:and|&|n)\\s+(?:(?:so|very|super|always|really)\\s+)?(?:' + SEXUAL_ADJ + '|' + PERSON_OR_SEXUAL_NOUN + ')(?![a-z]))';
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
  // A sexual noun directly before a bare digit age ("slut 16", "slut, 16"),
  // unless a unit or a counted thing follows ("babes 10 pics").
  new RegExp('(?<![a-z])' + SEXUAL_NOUN + '[\\s,:-]{1,3}' + MINOR_AGE_DIGITS + NOT_A_COUNT),
  // A bare digit age joined to a sexual word: "16 and horny", "Emma, 16,
  // horny" (the comma-separated profile shape).
  new RegExp(MINOR_AGE_DIGITS + '(?![0-9])' + SEXUAL_AND),
  new RegExp(',\\s*' + MINOR_AGE_DIGITS + '\\s*,\\s*(?:' + SEXUAL_ADJ + '|' + PERSON_OR_SEXUAL_NOUN + ')(?![a-z])'),
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
export function detectProhibitedTerms(text, { nameLike = false, strictAge = nameLike } = {}) {
  const reasons = [];
  const add = (term, category) => {
    const reason = `prohibited term (${category}): "${term}"`;
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  // Every reading of the text (lib/payment-circumvention-filter.js
  // normalizedReadings: a capital I after a lowercase letter is ALSO read as
  // an "l", so "LoIita" is "lolita" while "McIntyre" is still judged as typed).
  if (!nameLike) {
    for (const reading of normalizedReadings(text)) detectIn(foldStretched(reading), add, { strictAge });
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
  `${NOT_A_RANK}${DIGIT_AGE}[^a-z0-9$]{1,2}horny${CLAUSE_END}`,
  // digits, sexual word first, glued or separated ("slut16", "porn, 15")
  `(?<![a-z])${DIGIT_SEXUAL_WORD}[^a-z0-9$\u00a3\u20ac]{0,2}${DIGIT_AGE}${DIGIT_NOT_A_COUNT}`,
  // a sexual word, then "at" / "aged" / "at age" and a minor age, not a clock time
  `${AT_AGE_LEAD}(?:${DIGIT_AGE}(?:${DIGIT_NOT_A_COUNT}${NOT_A_TIME}|[\\s-]{0,2}(?:years?|yrs?|yo)(?![a-z]))|${NAME_SPELLED_MINOR_ONLY}(?![a-z])${COUNTED_AFTER}${NOT_A_TIME})`,
  // the age with an age word after it, then the sexual word ("16 year old porn")
  `${NOT_A_RANK}${FREE_AGE}${AGE_OLD_AFTER}[^a-z0-9]{1,3}(?:${MINOR_SEXUAL_WORD}|${PERSON_SEXUAL_WORD})(?![a-z])`,
  // a spelled minor age, "and", a sexual adjective or noun ("sixteen and horny")
  `${NOT_A_RANK}(?<![a-z])${NAME_SPELLED_MINOR_ONLY}(?![a-z])${SEXUAL_AND}`,
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
  // sexual word, then a lead-in, then the age
  `(?<![a-z])${MINOR_SEXUAL_WORD}[^a-z0-9]{1,3}(?:(?:and|&)\\s+)?${AGE_LEAD}[^a-z0-9$\u00a3\u20ac]{1,3}(?:${FREE_AGE_DIGIT}${FREE_NOT_A_COUNT}|(?<![a-z])${NAME_SPELLED_MINOR_ONLY}(?![a-z])${COUNTED_AFTER}${NOT_A_TIME})`,
  // a lead-in, the age, then a singular sexual person word
  `(?<![a-z])${AGE_LEAD}[^a-z0-9$\u00a3\u20ac]{1,3}${FREE_AGE}[^a-z0-9]{1,2}${PERSON_SEXUAL_WORD}(?![a-z])`,
  // the age, then a singular sexual person word ("16 slut", "ten slut")
  `${FREE_NOT_A_RANK}${FREE_AGE_TEN}[^a-z0-9$]{1,2}${PERSON_SEXUAL_WORD}(?![a-z])`,
  // a sexual word, the age, then a singular person word ("horny 16 girl")
  `(?<![a-z])${MINOR_SEXUAL_WORD}${FREE_SEP}${FREE_AGE}[^a-z0-9]{1,2}${SINGULAR_PERSON}(?![a-z])`,
  // the age, "and", a sexual adjective or noun
  `${FREE_NOT_A_RANK}${FREE_AGE}${SEXUAL_AND}`,
  // the age and the sexual word ending the clause, both orders
  `(?<![a-z])${MINOR_SEXUAL_WORD}${FREE_SEP}${FREE_AGE}${FREE_END}`,
  `(?<![a-z])${NAME_TEN_SEXUAL_WORD}${FREE_SEP}ten(?![a-z])${FREE_END}`,
  `${FREE_NOT_A_RANK}${FREE_AGE_TEN}[^a-z0-9$]{1,2}${SINGULAR_SEXUAL}${FREE_END}`,
  // "at" / "aged" / "at age" (unchanged from the strict rule)
  `${AT_AGE_LEAD}(?:${DIGIT_AGE}(?:${DIGIT_NOT_A_COUNT}${NOT_A_TIME}|[\\s-]{0,2}(?:years?|yrs?|yo)(?![a-z]))|${NAME_SPELLED_MINOR_ONLY}(?![a-z])${COUNTED_AFTER}${NOT_A_TIME})`,
].join('|'));

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
]);
const NAME_SAFE_COMPOUND = COMPILED_COMPOUND.filter((t) => NAME_SAFE_COMPOUND_TERMS.has(t.term));
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

function detectIn(normalized, add, { compound = true, strictAge = !compound } = {}) {
  if (!normalized) return;
  for (const { term, category, re, disclaimable } of COMPILED) {
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
  // Curly apostrophes (the iOS default) read as straight ones for the
  // self-description lead-ins.
  const ageText = normalized.replace(/[\u2018\u2019\u02bc]/g, "'");
  // Handles, usernames and tags join words with "_" and "." ("hot_16_yo",
  // "jess.16.yo", "im_16"). Read those as spaces for the age rules -- except a
  // "." between two letters ("16 y.o") or two digits ("v1.16", a decimal) --
  // and, separately, with them removed for the glued forms (GLUED_AGE_RE).
  const spaced = ageText.replace(/(?<=[a-z0-9])_+(?=[a-z0-9])|(?<=[0-9])\.(?=[a-z])|(?<=[a-z])\.(?=[0-9])/g, ' ');
  const glued = ageText.replace(/(?<=[a-z0-9])[_.]+(?=[a-z0-9])/g, '');
  if (MINOR_AGE_RES.some((re) => re.test(ageText) || re.test(spaced)) || GLUED_AGE_RE.test(glued)) {
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
  // A minor age next to a sexual word, in EVERY mode (round-15 accounts#0):
  // tags, display names, bios, locations and listing copy as well as handles.
  // On the name mask (spelled minor ages kept, "nineteen" and the name
  // collisions blanked), with curly apostrophes folded.
  // Round 16: the strict rule for name-like fields and tags, the narrower
  // free-text rule everywhere else (see MINOR_AGE_SEXUAL_FREE_RE), and
  // "barely" + a minor age in both.
  const ageMasked = ageText.replace(NAME_ALLOWLIST_RE, ' ').replace(NAME_COMPOUND_ALLOWLIST_RE, ' ');
  const ageRe = strictAge ? MINOR_AGE_SEXUAL_STRICT_RE : MINOR_AGE_SEXUAL_FREE_RE;
  const gluedAge = ageMasked.replace(/(?<=[a-z0-9])[_.]+(?=[a-z0-9])/g, '');
  if (ageRe.test(ageMasked) || BARELY_MINOR_AGE_RE.test(ageMasked) || BARELY_MINOR_AGE_RE.test(gluedAge)) {
    add('under-18 age', 'minor-suggestive');
  }
  for (const { term, category, re, disclaimable } of compound ? COMPILED_COMPOUND : NAME_SAFE_COMPOUND) {
    for (const m of masked.matchAll(re)) {
      if (disclaimable && isDisclaimed(masked, m.index, m.index + m[0].length)) continue;
      if (/[a-z]/.test(m[0])) {
        add(term, category);
        break;
      }
    }
  }
}

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
