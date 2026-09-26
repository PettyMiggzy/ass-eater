// Blocks messages/posts that look like an attempt to move a payment off-platform
// (Cash App, Venmo, Zelle, a phone number, an email address, ...) so creators
// can't route fans around the platform's fee. Applies to everyone, no bypass --
// a paid way around this would just be a paid way to dodge the fee it protects.
//
// Deliberately does NOT flag crypto wallet addresses (0x..., bc1..., etc.) --
// deposits, payouts and $ONLYONE holding/token-gating all happen on-chain
// here (see lib/brand.js), so wallet addresses show up in completely
// legitimate on-platform conversations, unlike a typical fiat-only OnlyFans
// clone. Note $ONLYONE itself is never the payment -- fans pay in USDC and
// spend credits -- but a fan or creator still legitimately pastes a wallet
// address for deposits, payouts, or proving they hold enough to unlock a
// gated creator.
//
// Two rules shape everything below, because a filter that blocks innocent
// people AND is trivial to step around is the worst of both:
//
//   1. Match against a NORMALIZED copy of the text -- lookalike letters from
//      other alphabets folded to Latin, zero-width characters stripped, leet
//      spellings and letters spaced apart tolerated -- so "vеnmo" (Cyrillic
//      е), "v e n m o" and "ca$h app" read the same to us as "venmo"/"cash
//      app". Matching the raw string is what made the old version a one-space
//      bypass.
//   2. Anything that is also ordinary English or ordinary $ONLYONE talk -- the
//      word "chime", a bare run of ten digits, a "$TICKER", the word "at" --
//      needs real CONTEXT nearby before it counts. Flagging those outright is
//      what blocked innocent users (a "wind chime", a 10-digit order number,
//      every listing priced "1M $ONLYONE", "new set drops at midnight. Link in
//      bio") and logged them to the admin violations queue as fee-dodgers.

const ZERO_WIDTH_RE = /[­​-‏⁠﻿]/g;

// Letters from other alphabets that render identically to a Latin letter, so a
// single pasted Cyrillic character can't hide a payment app's name. Keys are
// lowercase -- normalize() lowercases before mapping. The dashes are here for
// the phone patterns, which only understand an ASCII "-".
const HOMOGLYPHS = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
  'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's',
  'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w',
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p',
  'τ': 't', 'υ': 'u', 'χ': 'x', 'ζ': 'z', 'η': 'n',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-',
};
const HOMOGLYPH_RE = new RegExp(
  `[${Object.keys(HOMOGLYPHS).map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}]`,
  'g',
);

// Latin letters with NO compatibility decomposition, so NFKD leaves them
// alone: the small capitals every "fancy text" generator emits (ᴛᴇᴇɴ, ᴠᴇɴᴍᴏ,
// ꜱ, ʀ, ɢ, ʜ, ɪ, ʟ, ɴ, ʏ...), the dotless ı and ȷ, and a few reversed/turned
// letters from the same block. Without this, "ᴛᴇᴇɴ" was published as a tag
// and "Tip me on ᴠᴇɴᴍᴏ" was sent -- both read as plain words to any person.
// Mapped AFTER lowercasing (they are lowercase letters already).
const LETTER_FOLDS = {
  'ᴀ': 'a', 'ᴁ': 'ae', 'ᴂ': 'ae', 'ᴃ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴆ': 'd', 'ᴇ': 'e',
  'ᴈ': 'e', 'ᴉ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ᴌ': 'l', 'ᴍ': 'm', 'ᴎ': 'n', 'ᴏ': 'o',
  'ᴐ': 'o', 'ᴑ': 'o', 'ᴒ': 'o', 'ᴓ': 'o', 'ᴔ': 'oe', 'ᴕ': 'ou', 'ᴖ': 'o', 'ᴗ': 'o',
  'ᴘ': 'p', 'ᴙ': 'r', 'ᴚ': 'r', 'ᴛ': 't', 'ᴜ': 'u', 'ᴝ': 'u', 'ᴞ': 'u', 'ᴟ': 'm',
  'ᴠ': 'v', 'ᴡ': 'w', 'ᴢ': 'z', 'ᴣ': 'z', 'ᴩ': 'p',
  'ʙ': 'b', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ʟ': 'l', 'ɴ': 'n', 'ʀ': 'r', 'ʏ': 'y',
  'ꜰ': 'f', 'ꜱ': 's', 'ꞯ': 'q', 'ɶ': 'oe', 'ı': 'i', 'ȷ': 'j',
};
const LETTER_FOLD_RE = new RegExp(`[${Object.keys(LETTER_FOLDS).join('')}]`, 'gu');

// Enclosed letters NFKD also leaves alone, which fancy-text generators emit
// next to the small capitals: the NEGATIVE circled letters 🅐-🅩 (U+1F150-69),
// the NEGATIVE squared letters 🅰-🆉 (U+1F170-89) and the regional-indicator
// letters 🇦-🇿 (U+1F1E6-FF). Plain circled (ⓣ) and squared (🅃) forms already
// decompose; these did not, so "🆃🅴🅴🅽" and "🆅🅴🅽🅼🅾" read as plain words to
// every person and as nothing to the screens (round-10 accounts#1). Folded by
// code-point arithmetic, not a 78-entry table.
//
// A regional indicator folds to its letter AND a space: two of them side by
// side render as a flag (🇺🇸), and gluing the flag's letters onto the next
// word would read "🇮🇹aly" as "italy" and a flag as a word. Spaced, a word
// spelled out in indicators ("🇹 🇪 🇪 🇳", or unspaced "🇹🇪🇪🇳") is letters
// spaced apart, which the screens already read as the word.
const ENCLOSED_LETTER_RE = /[\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}\u{1F1E6}-\u{1F1FF}]/gu;
function foldEnclosedLetter(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x1f1e6) return `${String.fromCharCode(97 + cp - 0x1f1e6)} `;
  if (cp >= 0x1f170) return String.fromCharCode(97 + cp - 0x1f170);
  return String.fromCharCode(97 + cp - 0x1f150);
}

/**
 * Small capitals, dotless letters and the enclosed letters above folded to
 * plain Latin, and nothing else. Exported for lib/creator-status.js
 * sanitizeTags, so a tag typed in small capitals is STORED as the plain word
 * the screen judged it as.
 */
// A PAIR of regional indicators that is a real country flag (ISO 3166
// alpha-2, plus the few extra flags emoji fonts draw) reads as a flag, not as
// two letters: folded to a space, so adjacent flags never spell a
// letter-spaced word -- "🇵🇪🇩🇴" (Peru + Dominican Republic) read as "p e d o"
// and was refused as minor-suggestive (round-11 accounts#5). Runs are paired
// from the left, the way renderers pair them. A pair that is NOT a flag
// ("🇹🇪🇪🇳" is TE + EN, neither a country) still folds to spaced letters, so
// spelling a word out in indicators is still read as the word.
const FLAG_CODES = new Set((
  'AC AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CP CR CU CV CW CX CY CZ DE DG DJ DK DM DO DZ EA EC EE EG EH ER ES ET EU '
  + 'FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU IC ID IE IL IM IN IO '
  + 'IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH '
  + 'MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM '
  + 'PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TA TC TD TF '
  + 'TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM UN US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'
).toLowerCase().split(' '));
const REGIONAL_RUN_RE = /[\u{1F1E6}-\u{1F1FF}]{2,}/gu;
function foldRegionalRun(run) {
  const letters = [...run].map((ch) => String.fromCharCode(97 + ch.codePointAt(0) - 0x1f1e6));
  let out = '';
  let i = 0;
  for (; i + 1 < letters.length; i += 2) {
    const pair = letters[i] + letters[i + 1];
    out += FLAG_CODES.has(pair) ? ' ' : `${letters[i]} ${letters[i + 1]} `;
  }
  if (i < letters.length) out += `${letters[i]} `;
  return out;
}

export function foldLookalikeLetters(text) {
  return String(text ?? '')
    .replace(REGIONAL_RUN_RE, foldRegionalRun)
    .replace(ENCLOSED_LETTER_RE, foldEnclosedLetter)
    .replace(LETTER_FOLD_RE, (ch) => LETTER_FOLDS[ch]);
}

/**
 * Everything below matches against this, never the raw text. Exported so
 * lib/prohibited-terms.js folds lookalikes the same way -- two filters that
 * disagree about what "the same text" means are two bypasses.
 */
export function normalizeForMatching(raw) {
  return normalize(String(raw ?? ''));
}

/**
 * The readings of one text a filter has to judge: the plain normalised form,
 * plus -- only when the text has one -- a second reading in which a capital
 * "I" written straight after a lowercase letter is an "l" ("PaypaI",
 * "OnIyFans", "LoIita", "ZeIIe"). In most fonts the two are the same glyph.
 * It is a SECOND reading, not a replacement, because the same shape is also
 * an honest capital I ("McIntyre", "iPhoneI"): the plain reading keeps
 * everything it already caught, and the l-reading adds what only it spells.
 */
export function normalizedReadings(raw) {
  const text = String(raw ?? '');
  const plain = normalize(text);
  const lForI = preFold(text).replace(/(?<=\p{Ll}I*)I/gu, 'l');
  const alt = postFold(lForI);
  return alt === plain ? [plain] : [plain, alt];
}

function preFold(raw) {
  return raw
    .normalize('NFKD') // fullwidth and styled unicode (ｖｅｎｍｏ, 𝗩𝗲𝗻𝗺𝗼) collapse to plain letters
    .replace(/[̀-ͯ]/g, '') // drop the combining accents NFKD just split off (venmo with an accent -> venmo)
    .replace(ZERO_WIDTH_RE, '')
    .replace(REGIONAL_RUN_RE, foldRegionalRun) // a real flag pair is a flag, not two letters
    .replace(ENCLOSED_LETTER_RE, foldEnclosedLetter); // 🆅🅴🅽🅼🅾 -> venmo (no NFKD decomposition)
}

function postFold(text) {
  return text
    .toLowerCase()
    .replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch])
    .replace(LETTER_FOLD_RE, (ch) => LETTER_FOLDS[ch]);
}

function normalize(raw) {
  return postFold(preFold(raw));
}

// Digit/symbol substitutions people reach for first (v3nm0, ca$happ, payp4l).
const LEET_CLASSES = {
  a: '[a@4]', b: '[b8]', e: '[e3]', g: '[g9]', i: '[i1!|]', l: '[l1|]',
  o: '[o0]', s: '[s5$]', t: '[t7+]', z: '[z2]',
};
// Punctuation/whitespace allowed between the letters of ONE word, so
// "v e n m o" and "v-e-n-m-o" match while ordinary prose can't accidentally
// line up (only non-alphanumerics are allowed through, so any real letter in
// between breaks the run).
const LETTER_GAP = '[^a-z0-9]{0,3}';
// The break between the two halves of a two-word name ("cash app", "apple
// pay") is deliberately much tighter than LETTER_GAP: whitespace on its own,
// or exactly one joining character. Reusing LETTER_GAP across that break is
// what let "I only take cash. Apps are a hassle" and "no cash / apps, crypto
// only" read as "cash app" -- prose puts PUNCTUATION at a clause break, and
// punctuation plus a space is two characters, while every real spelling of the
// name is "cashapp", "cash app", "cash-app" or "cash_app".
const WORD_BREAK_GAP = '(?:\\s{0,3}|[_.+\\-])';

/**
 * A word-boundaried, evasion-tolerant matcher for one payment-app name. A
 * space in `word` marks the name's own word break (see WORD_BREAK_GAP).
 *
 * The boundaries reject an adjacent LETTER but allow an adjacent digit: that
 * is still what keeps "gazelle"/"chimera"/"paypalm" from matching, while a
 * handle with a number stuck on it -- "zelle4me", "venmo2024", "paypal1",
 * which is how people actually write these -- stays caught. A letters-and-
 * digits boundary made appending one character a complete bypass. The suffix
 * group keeps "venmoed"/"cashapped" matching.
 */
function buildKeywordRe(word) {
  const body = word
    .split(' ')
    .map((part) => [...part].map((ch) => LEET_CLASSES[ch] || ch).join(LETTER_GAP))
    .join(WORD_BREAK_GAP);
  return new RegExp(`(?<![a-z])${body}(?:s|es|ed|ing)?(?![a-z])`, 'g');
}

// A leet spelling still has to be a WORD. Every letter of "zelle" has a digit
// lookalike (z->2, e->3, l->1), so without this the ZIP code 23113, the price
// "$231.13" and "2-3-1-1-3" all read as `mentions "zelle"` -- and numbers are
// everywhere on a platform priced in tokens and shipping physical listings.
// Leet spellings are still caught; they just have to keep one real letter.
function isWordNotNumber(match) {
  return /[a-z]/.test(match);
}

// Names that mean a payment rail and nothing else -- flagged on sight.
const PAYMENT_KEYWORDS = [
  { word: 'cash app', label: 'cash app' },
  { word: 'venmo', label: 'venmo' },
  { word: 'zelle', label: 'zelle' },
  { word: 'pay pal', label: 'paypal' },
  { word: 'apple pay', label: 'apple pay' },
  { word: 'google pay', label: 'google pay' },
  { word: 'western union', label: 'western union' },
  { word: 'money gram', label: 'moneygram' },
].map((k) => ({ ...k, re: buildKeywordRe(k.word) }));

// Payment apps whose name is also an ordinary English word -- a wind chime,
// chiming in, a clock chiming the hour. Only counts with STRONG payment
// context nearby, otherwise every innocent use of the word is a logged
// violation.
const AMBIGUOUS_PAYMENT_KEYWORDS = [
  { word: 'chime', label: 'chime' },
].map((k) => ({ ...k, re: buildKeywordRe(k.word) }));

// Rails that exist to take the transaction somewhere else. These are names
// with no ordinary-English reading and no legitimate use in a message on this
// platform: naming a competing creator platform or a link-in-bio aggregator IS
// the circumvention, whether or not a price is mentioned in the same breath.
const OFF_PLATFORM_KEYWORDS = [
  { word: 'revolut', label: 'revolut' },
  { word: 'linktree', label: 'linktree' },
  { word: 'linktr ee', label: 'linktree' },
  { word: 'onlyfans', label: 'onlyfans' },
  { word: 'fansly', label: 'fansly' },
  { word: 'patreon', label: 'patreon' },
  { word: 'wishtender', label: 'wishtender' },
  { word: 'throne me', label: 'throne' },
  { word: 'skrill', label: 'skrill' },
  { word: 'payoneer', label: 'payoneer' },
  // Adult-creator stores and cam sites. Single names with no English reading
  // take the evasion-tolerant matcher like everything above.
  { word: 'fancentro', label: 'fancentro' },
  { word: 'fanvue', label: 'fanvue' },
  { word: 'clips4sale', label: 'clips4sale' },
  { word: 'chaturbate', label: 'chaturbate' },
  // Tip jars, digital-goods stores and adult clip stores: a creator's public
  // website link is any https URL, so this list is all that keeps "buy it on
  // my Gumroad" off a profile.
  { word: 'gumroad', label: 'gumroad' },
  { word: 'sextpanther', label: 'sextpanther' },
  { word: 'modelhub', label: 'modelhub' },
  { word: 'pornhub', label: 'pornhub' },
  { word: 'onlyfanz', label: 'onlyfanz' },
  { word: 'amazon wish list', label: 'amazon wishlist' },
  // Paid Snapchat ("premium snap", "SC premium") is sold off-platform by
  // definition. A bare "snap" stays a contact-rail word (below).
  { word: 'snapchat premium', label: 'snapchat premium' },
  { word: 'premium snapchat', label: 'snapchat premium' },
  { word: 'premium snap', label: 'snapchat premium' },
  { word: 'sc premium', label: 'snapchat premium' },
].map((k) => ({ ...k, re: buildKeywordRe(k.word) }));

// Names that are ALSO an ordinary phrase once a space goes in -- "thank you to
// my loyal fans", "many vids coming", "just for fans", "strip chat", "I want
// clips" -- so the letter-gap tolerance above would flag honest sentences.
// These match only glued (digit lookalikes still count), or as a domain.
function buildGluedRe(word) {
  const body = [...word].map((ch) => LEET_CLASSES[ch] || ch).join('');
  return new RegExp(`(?<![a-z])${body}(?:s)?(?![a-z])`, 'g');
}
const GLUED_OFF_PLATFORM_KEYWORDS = [
  { word: 'manyvids', label: 'manyvids' },
  { word: 'loyalfans', label: 'loyalfans' },
  { word: 'justforfans', label: 'justforfans' },
  { word: 'iwantclips', label: 'iwantclips' },
  { word: 'stripchat', label: 'stripchat' },
  { word: 'myfreecams', label: 'myfreecams' },
  { word: 'fansone', label: 'fansone' },
  { word: 'unlockd', label: 'unlockd' },
  // Competing subscription platforms (their domains are in OFF_PLATFORM_LINK_RE).
  { word: 'fanfix', label: 'fanfix' },
  { word: 'fanhouse', label: 'fanhouse' },
  { word: 'fancentro', label: 'fancentro' },
  // "check all my links" is ordinary; only the glued name or the
  // allmylinks.com domain (OFF_PLATFORM_LINK_RE) counts.
  { word: 'allmylinks', label: 'allmylinks' },
  // "buy me a coffee" is ordinary; the glued store name is not.
  { word: 'buymeacoffee', label: 'buymeacoffee' },
  // Google Pay's own short name. Glued only: "e.g. pay attention" must not
  // read as "g pay".
  { word: 'gpay', label: 'google pay' },
].map((k) => ({ ...k, re: buildGluedRe(k.word) }));

// Link-in-bio aggregators whose bare name is an ordinary word ("beacons",
// "throne", "bio link"): only the domain form counts.
// Ko-fi is written with its separator ("ko-fi", "ko fi"); a bare "kofi" is a
// common given name and is not flagged. An Amazon wish list is recognised by
// its URL path.
// Competing subscription storefronts whose bare names are ordinary words
// ("passes", "mym") are recognised by their domain only, for the same reason.
const OFF_PLATFORM_LINK_RE = /(?<![a-z0-9])(?:beacons\.ai|bio\.link|lnk\.bio|linkin\.bio|throne\.com|linktr\.ee|allmylinks\.com|fanvue\.com|manyvids\.com|mym\.fans|fanfix\.io|passes\.com|fanhouse\.app|4based\.com|fancentro\.com|admireme\.vip|justfor\.fans|ko[\s._-]fi|amazon\.[a-z.]{2,7}\/(?:[a-z-]{2,5}\/)?(?:hz\/)?wishlist)(?![a-z0-9])/;

// Messaging apps. Naming one is not itself circumvention -- people talk about
// where they are -- but handing over an account name on one is how a fan gets
// moved off-platform, so these count only next to a handle or payment context.
const CONTACT_RAIL_KEYWORDS = [
  { word: 'telegram', label: 'telegram' },
  { word: 'snapchat', label: 'snapchat' },
  // "snap" is also "oh snap" / "snap a pic": only in THOSE phrasings is an
  // @mention nearby not a handover (ordinaryRe -> adjacentAtOnly for that one
  // match; round-11 accounts#1). Everywhere else "snap" keeps the full
  // 40-character @ radius like any contact app -- "my snap is @jane", "snap
  // me @jane_doe", "@jane_doe on snap" are handovers.
  { word: 'snap', label: 'snapchat', ordinary: { before: /(?:^|[^a-z0-9])(?:oh|aw|ah)[^a-z0-9]{1,3}$/, after: /^[^a-z0-9]{1,3}(?:(?:a|the|some|my|your|more|new)[^a-z0-9]{1,3})?(?:pic|pics|picture|pictures|photo|photos|shot|shots|selfie|selfies)(?![a-z])/ } },
  { word: 'kik', label: 'kik' },
  { word: 'wickr', label: 'wickr' },
  { word: 'discord', label: 'discord' },
  { word: 'instagram', label: 'instagram' },
  { word: 'insta', label: 'instagram' },
  { word: 'ig', label: 'instagram' },
  { word: 'whatsapp', label: 'whatsapp' },
  { word: 'skype', label: 'skype' },
  { word: 'facetime', label: 'facetime' },
  // Ordinary words as well ("the signal dropped", "paid, signal me later"),
  // so these count ONLY on a handover -- a payment word nearby is not enough.
  // "wa" is deliberately absent: with the plural suffix it is "was", and
  // wa.me links are already caught by CONTACT_LINK_RE.
  { word: 'signal', label: 'signal', handoverOnly: true, adjacentAtOnly: true },
  { word: 'tg', label: 'telegram', handoverOnly: true, adjacentAtOnly: true },
  // Snapchat's standard abbreviation on adult platforms ("SC @jane", "my sc
  // is jane_doe99"), and messengers that were only phone-number cues, so a
  // handle handed over on them was never screened (round-10 accounts#4).
  // "sc" (South Carolina, "sc premium" above) and "line" (drop me a line,
  // bottom line) are ordinary, so they count ONLY on a handover.
  { word: 'sc', label: 'snapchat', handoverOnly: true, adjacentAtOnly: true },
  { word: 'line', label: 'line', handoverOnly: true, adjacentAtOnly: true, handleLikeOnly: true },
  // Round-11 accounts#1: these words are ordinary prose ("my new lingerie
  // line with @jess_rose", "Charleston, SC | collab w/ @mia", "signal boost
  // for @jess_rose"), and "@handle" is how every creator on this platform is
  // named. adjacentAtOnly: an @handle counts only DIRECTLY after the word
  // ("sc @jane", "line: @jane"), never anywhere in the 40-character radius.
  // handleLikeOnly ("line" only): after a colon the token must LOOK like a
  // handle (a digit, or an inner "_"/".") unless a handle noun introduces it
  // ("line id: janedoe") -- "Spring line: bikinis" is a product line.
  { word: 'wechat', label: 'wechat' },
  { word: 'viber', label: 'viber' },
].map((k) => ({ ...k, re: buildKeywordRe(k.word) }));

// Money-movement words that are NOT also ordinary vocabulary on an adult
// creator platform. "tip", "handle", "tag", "account" and "discount" are
// deliberately absent: a creator writing "Tips appreciated! wind chime asmr
// set" was being blocked and logged as a fee-dodger by the ambiguous-keyword
// gate below, which is exactly the false positive that makes moderators stop
// trusting the queue.
const STRONG_PAYMENT_CUE_RE = new RegExp(
  '\\$\\d'
  + '|(?<![a-z0-9])(?:'
  + 'pay|pays|paid|paying|payment|payments|transfer|transfers|'
  + 'cashtag|funds|invoice|billing|'
  + 'off ?platform|off ?site|cheaper'
  + ')(?![a-z0-9])',
);

// Words that mean money is actually changing hands. Used only as a gate on the
// ambiguous signals below -- never as a reason to flag on its own.
const PAYMENT_CUE_RE = new RegExp(
  '\\$\\d' // a plain dollar amount ("chime $50") is payment context by itself
  + '|(?<![a-z0-9])(?:'
  + 'pay|pays|paid|paying|payment|payments|send|sends|sent|sending|transfer|transfers|'
  + 'deposit|deposits|tip|tips|tipped|money|cash|cashtag|funds|charge|invoice|billing|'
  + 'handle|username|tag|account|acct|hmu|hit me up|off ?platform|off ?site|'
  + 'directly|instead|cheaper|discount'
  + ')(?![a-z0-9])',
);
const CUE_RADIUS = 60;

function hasPaymentCueNear(text, start, end) {
  return PAYMENT_CUE_RE.test(text.slice(Math.max(0, start - CUE_RADIUS), end + CUE_RADIUS));
}

function hasStrongPaymentCueNear(text, start, end) {
  return STRONG_PAYMENT_CUE_RE.test(text.slice(Math.max(0, start - CUE_RADIUS), end + CUE_RADIUS));
}

// Contact apps (instagram, snapchat, telegram...) are named in ordinary text
// here all the time, right next to how THIS platform describes itself: "Ex-
// Instagram model | Paid DMs open", "Found you on insta! Just paid for your
// set", "Snapchat filters are cheaper than makeup". A strong cue anywhere in a
// 60-character radius refused and logged every one of those as fee-dodging
// (round-12 accounts#1). For a contact app a payment word now counts only
// when it reads as an INSTRUCTION about paying through that app: the cue
// directly before the app with nothing but connector words between ("pay me
// on insta", "payment via whatsapp", "cheaper on my snap", "$20 on snap"),
// or a describing-only cue a few words before it in the same clause
// ("cheaper prices on my snap", see CUE_BRIDGE_BEFORE_RAIL_RE),
// or the app directly followed by the cue ("snap for cheaper", "telegram
// payments", "kik me for cheaper", "snap: $20"). A sentence break (. ! ?)
// ends the instruction. The platform's own product phrases ("paid DMs",
// "paid content", "pay per view") are never a cue here.
const INSTRUCTION_CUE = '(?:\\$\\d|(?<![a-z0-9])(?:pay|pays|paid|paying|payment|payments|transfer|transfers|cashtag|funds|invoice|billing|off ?platform|off ?site|cheaper)(?![a-z0-9]))';
const INSTRUCTION_SEP = '[^a-z0-9$.!?]{1,3}';
const CONNECTOR_BEFORE = '(?:me|us|you|u|on|via|with|through|thru|at|to|in|over|using|by|only|my|our|your|the|it|them|directly|instead)';
const CONNECTOR_AFTER = '(?:me|us|is|has|have|got|its|it\'?s|for|and|only|much|way|even|so|u|you|to|i|also|do|does|take|takes|accept|accepts|accepting|a lot|lot|instead|directly)';
const CUE_BEFORE_RAIL_RE = new RegExp(`${INSTRUCTION_CUE}[0-9,.]*(?:${INSTRUCTION_SEP}${CONNECTOR_BEFORE}){0,3}${INSTRUCTION_SEP}$`);
// The connector list alone let the most natural fee-dodging phrasings through
// ("cheaper prices on my snap", "payment accepted through my telegram",
// "customs are cheaper if you message me on telegram"). For the cues that
// only ever describe paying -- a present-tense "pay", "payment(s)",
// "cheaper", or a $amount -- up to five arbitrary words may sit between the
// cue and the app, as long as they stay in one clause (no . ! ? , ; | or line
// break). Past-tense "paid" is deliberately not a bridging cue: "Just paid
// for your set, found you on insta" reports a purchase, it routes nothing.
// "cheaper than insta" compares prices; it is never an instruction.
// Round 13 (accounts#4): "pay attention" is an idiom, not a cue. And the
// bridge may not cross "here" (the platform itself) or a clause-joining
// "and"/"then"/"but"/"so"/"while" when what follows it, up to the app, starts
// a NEW statement -- a possessive or any other verb: "Sets from $9 on here and
// my insta has previews", "pay my rent then post on insta". It still bridges
// when the app follows the joiner directly or after only a contact tail
// (pronoun, contact verb, connector): "$20 and snap", "$20 then telegram",
// "send $20 and I send on snap", "pay 20 and hit me up on snap", "pay me
// here telegram" -- those are instructions to pay and then go to the app.
const BRIDGE_CUE = '(?:\\$\\d[0-9,.]*|(?<![a-z0-9])(?:pay(?![a-z0-9])(?!\\s+attention(?![a-z0-9]))|payment|payments|cheaper(?![a-z0-9])(?!\\s+than(?![a-z0-9])))(?![a-z0-9]))';
const CLAUSE_SEP = '[^a-z0-9$.!?,;|\\n]{1,3}';
const BRIDGE_W = (alt) => `${CLAUSE_SEP}(?:${alt})(?![a-z0-9'])`;
const BRIDGE_TAIL_LEAD = 'i|we|u|you|and|then|also|just';
const BRIDGE_TAIL_VERB = 'send|sends|sending|dm|text|message|msg|hit|add|contact|reach|pay|tip|find';
const BRIDGE_TAIL_CONN = 'me|us|up|on|via|at|in|over|thru|through|to';
// What may follow a joiner up to the app without making it a new statement:
// leading pronouns/joiners, then either a contact verb (which may take "my":
// "and hit my snap") or bare connectors (which may not: "and my insta" is a
// new subject).
const BRIDGE_CONTACT_TAIL = `(?:${BRIDGE_W(BRIDGE_TAIL_LEAD)})*`
  + `(?:${BRIDGE_W(BRIDGE_TAIL_VERB)}(?:${BRIDGE_W(`${BRIDGE_TAIL_CONN}|my|our|the`)})*|(?:${BRIDGE_W(BRIDGE_TAIL_CONN)})*)`
  + `${CLAUSE_SEP}$`;
const BRIDGE_STOP = `(?:here|and|then|but|so|while)(?![a-z0-9'])(?!${BRIDGE_CONTACT_TAIL})`;
const CUE_BRIDGE_BEFORE_RAIL_RE = new RegExp(`${BRIDGE_CUE}(?:${CLAUSE_SEP}(?!${BRIDGE_STOP})[a-z0-9']{1,15}){1,5}${CLAUSE_SEP}$`);
const CUE_AFTER_RAIL_RE = new RegExp(`^(?:${INSTRUCTION_SEP}${CONNECTOR_AFTER}(?![a-z0-9])){0,3}${INSTRUCTION_SEP}${INSTRUCTION_CUE}`);
// Masked to spaces (same length, so match offsets stay valid) before the
// instruction test. "pay per view" is ONE phrase, never "pay" + an app.
const PLATFORM_PAYMENT_PHRASE_RE = /(?<![a-z0-9])(?:paid[\s-]{0,2}(?:dms?|content|messages?|msgs?|posts?|sets?|pics?|photos?|videos?|vids?|subscriptions?|subs|unlocks?)|pay[\s-]{0,2}per[\s-]{0,2}(?:view|message|msg|minute|min)|ppv)(?![a-z0-9])/g;

function hasPaymentInstructionAt(text, start, end) {
  const masked = text.replace(PLATFORM_PAYMENT_PHRASE_RE, (m) => ' '.repeat(m.length));
  const before = masked.slice(Math.max(0, start - CUE_RADIUS), start);
  return CUE_BEFORE_RAIL_RE.test(before)
    || CUE_BRIDGE_BEFORE_RAIL_RE.test(before)
    || CUE_AFTER_RAIL_RE.test(masked.slice(end, end + CUE_RADIUS));
}

// A tag whose LAST words are a strong payment cue, optionally followed by up
// to two connecting words: "pay", "pay me", "pay me on", "pay via",
// "payment", "cheaper on". Used by the cross-tag screen
// (lib/listings-store.js findCircumventionInTags): a cue that ends one tag and
// directly abuts a contact-app tag ("pay me on" + "snapchat") is an
// instruction across the chip boundary, while a cue buried inside a category
// tag ("pay pig", "pay per view") is not.
const TAG_ENDS_WITH_PAYMENT_CUE_RE = new RegExp(
  '(?<![a-z0-9])(?:'
  + 'pay|pays|paid|paying|payment|payments|transfer|transfers|'
  + 'cashtag|funds|invoice|billing|'
  + 'off ?platform|off ?site|cheaper'
  + ')(?:[^a-z0-9]{1,3}(?:me|us|on|via|with|through|thru|at|to|in|over|using|by|only)){0,2}[^a-z0-9]*$',
);
export function tagEndsWithPaymentCue(tag) {
  return TAG_ENDS_WITH_PAYMENT_CUE_RE.test(normalize(String(tag || '')));
}

// Handing over an account name, as opposed to merely naming a service.
// "we chatted on telegram about the shoot" is conversation; "telegram
// @janedoe", "snapchat: janedoe99" and "add me on kik jane_doe" are routing
// a fan off-platform.
//
// The shapes that count, each deliberately narrow because the alternative is
// blocking ordinary sentences:
//
//   1. An @handle anywhere nearby.
//   2. The service name followed straight away by ":", "=" or "@" and a
//      handle -- the canonical "snapchat: janedoe99". No possessive needed;
//      nobody writes "kik:" in front of anything but an account name. A plain
//      word after the colon only counts when it ends the clause ("kik:
//      janedoe" but not "Discord: private server only").
//   3. An invitation in front ("add me on", "hmu on", "dm me on") and a
//      handle-looking token right after the service name.
//   3b. The service name, one or two plain spaces, and a token that LOOKS like
//      a handle -- "snapchat jane99", "Telegram jane_doe for customs". Dropping
//      the colon from shape 2 was a complete bypass. A plain word never counts
//      here ("snap a pic", "signal strength"), and neither does a number with
//      a unit on it ("snap 100pics", "telegram 2fa"): the token needs a letter
//      AND a digit or an inner "_"/".", and must not be digits-then-letters.
//   4. A possessive in front ("my snap", not "that snap") AND a handover after
//      it. After a bare "is" the token must LOOK like a handle -- a digit, or
//      an inner "_"/"." -- or come after a word that means handle ("my snap
//      tag is jdoe"). Accepting any word after "is" is what flagged "my snap
//      is cute", "her telegram is down again" and "our discord is private",
//      all of which people here actually write.
const HANDLE_RADIUS = 40;
const AT_HANDLE_RE = /(?<![a-z0-9])@[a-z0-9_.]{3,30}/;
// "Looks like a handle": has a digit, or a "_"/"." with something after it
// (so the full stop ending "is private." doesn't count).
const HANDLE_LIKE = '(?=[a-z0-9_.]*(?:[0-9]|[_.][a-z0-9]))[a-z0-9_.]{3,30}';
const HANDLE_NOUN = '(?:tag|handle|username|user ?name|name|id|acct|account|addy)';
// The nouns that can sit between a service name and its separator ("Snapchat
// username: jane_doe", "LINE ID: jane_doe", "snap user: jane_doe") -- shape 2
// used to take only ":"/"="/"@" directly after the name (round-11
// accounts#0). "user ?name" before "user" so the longer one is taken.
const DIRECT_HANDLE_NOUN = '(?:user ?name|user|handle|tag|name|id|addy|acct|account)';
const POSSESSIVE_BEFORE_RE = /(?<![a-z0-9])(?:my|our|her|his|their)(?:\s+[a-z]{1,12}){0,2}\s*$/;
// The words between the possessive's service name and a ":"/"=" never
// swallow that ":"/"=" themselves: "my snap tag: jdoe" has only the one colon,
// and a separator class that included it could never match (round-11
// accounts#0).
function buildHandoverAfterRe({ strict }) {
  return new RegExp(
    '^[^a-z0-9]{0,3}(?:'
    // "my snap: jdoe", "my kik = jdoe", "my snap tag: jdoe". handleLikeOnly
    // rails need a handle-looking token after the colon, or a handle noun
    // before it.
    + (strict
      ? `(?:[a-z]{1,10}[^a-z0-9:=]{0,3}){0,2}[:=][^a-z0-9]{0,3}${HANDLE_LIKE}`
        + `|(?:[a-z]{1,10}[^a-z0-9:=]{1,3}){0,1}${DIRECT_HANDLE_NOUN}[^a-z0-9:=]{0,3}[:=][^a-z0-9]{0,3}[a-z0-9_.]{3,30}`
      : `(?:[a-z]{1,10}[^a-z0-9:=]{0,3}){0,2}[:=][^a-z0-9]{0,3}[a-z0-9_.]{3,30}`)
    // "my chime tag is jdoe", "my snap username is jane"
    + `|(?:[a-z]{1,10}[^a-z0-9]{1,3}){0,1}${HANDLE_NOUN}[^a-z0-9]{1,3}is[^a-z0-9]{1,3}[a-z0-9_.]{3,30}`
    // "my snap is jane_doe99" -- but not "my snap is cute"
    + `|(?:[a-z]{1,10}[^a-z0-9]{1,3}){0,2}is[^a-z0-9]{1,3}${HANDLE_LIKE}`
    + ')',
  );
}
const HANDOVER_AFTER_RE = buildHandoverAfterRe({ strict: false });
const HANDOVER_AFTER_STRICT_RE = buildHandoverAfterRe({ strict: true });
// Shape 2: straight after the service name.
// A plain word that ends the clause counts as a handle ("kik: janedoe"),
// except the words people put there to say there ISN'T one: "Instagram:
// private", "Snapchat: soon", "kik: none" (a sentence-ending full stop after
// the word does not turn it into a handle).
const NOT_A_HANDLE = '(?!(?:private|soon|none|nope|coming|later|tbd|tba|ask|dms?|deleted|closed|inactive|here|below|above|same|off|na|n\\/a)(?![a-z0-9_]|\\.[a-z0-9_]))';
const PLAIN_WORD_HANDLE = `${NOT_A_HANDLE}[a-z0-9_.]{3,30}(?=\\s*(?:$|[^a-z0-9\\s]))`;
// Shape 3b: plain spaces, then a handle-looking token with a letter in it
// that is not a number with a unit ("100pics", "2fa", "5min").
const SPACED_HANDLE = `(?![0-9]+[a-z]{1,6}(?![a-z0-9_.]))(?=[a-z0-9_.]*[a-z])${HANDLE_LIKE}`;
// An optional handle noun may sit between the name and the separator
// ("Snapchat username: jane_doe", "Snapchat ID - jane_doe").
const DIRECT_NOUN = `(?:\\s{1,2}${DIRECT_HANDLE_NOUN})?`;
// Round-12 accounts#2: two everyday separators were missing.
//  - A pointer: an arrow or pointing emoji, or an ASCII arrow ("snap 👉
//    jessxo99", "insta ➡️ jess_xo", "kik >> jess99"), optionally with a
//    skin-tone modifier or the emoji variation selector. The token after the
//    pointer must LOOK like a handle (a digit, or an inner "_"/"."): an arrow
//    is how ordinary bios point at things too ("insta → reels", "snap →
//    stories", "check insta -> photos"), so a plain word after one is not a
//    handle. After a possessive ("my snap -> jessxo") a plain word ending the
//    clause does count, like the possessive colon form.
//  - The app used as a verb with "me" ("snap me jess_xo", "kik me jess99",
//    "telegram me at jane99"). Only a handle-looking token counts: a plain
//    word there is usually just a word ("snap me later", "snap me gorgeous",
//    "telegram me honey"), and no list of such words could ever be complete.
//    "snap me jessxo" (no digit, no inner "_"/".") therefore passes, exactly
//    as "snap jessxo" does.
const POINTER = '(?:(?:\u{1F449}|\u27A1|\u2192|\u21D2|\u{1F447}|\u2B07|\u27F6|\u279C|\u27A4)(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?|->|=>|-->|>>|~)';
const ME_HANDLE = `\\s{1,2}me(?:\\s{1,2}(?:at|on))?\\s{0,2}:?\\s{0,3}(?:@\\s{0,2})?${HANDLE_LIKE}`;
const DIRECT_HANDOVER_RE = new RegExp(
  `^(?:${DIRECT_NOUN}\\s{0,2}(?:[:=@]\\s{0,3}(?:${HANDLE_LIKE}|${PLAIN_WORD_HANDLE})|-\\s{0,3}${HANDLE_LIKE})`
  + `|${DIRECT_NOUN}\\s{0,2}${POINTER}{1,3}\\s{0,3}(?:@\\s{0,2})?${HANDLE_LIKE}`
  + `|${ME_HANDLE}`
  + `|\\s{1,2}${SPACED_HANDLE})`,
  'u',
);
// After a possessive ("my snap -> jessxo", "my insta 👉 jess"): a pointer
// then a handle, or a plain word that ends the clause (round-12 accounts#2).
const POSSESSIVE_POINTER_RE = new RegExp(`^\\s{0,2}${POINTER}{1,3}\\s{0,3}(?:@\\s{0,2})?(?:${HANDLE_LIKE}|${PLAIN_WORD_HANDLE})`, 'u');
// adjacentAtOnly rails: an @handle directly after the word ("sc @jane",
// "line: @jane", "signal - @jane"), or after at most two short connectors
// ("sc me @jane_doe", "my sc is @jane", "line me at @jane") -- "for" and
// "with" deliberately not among them ("lingerie line with @jess_rose",
// "signal boost for @jess_rose").
const ADJACENT_AT_RE = /^[^a-z0-9@]{0,3}(?:(?:me|is|at|im|i'?m|on)[^a-z0-9@]{1,3}){0,2}@[a-z0-9_.]{3,30}/;
// ...or an @handle directly BEFORE it, pointed at the app ("@jane_doe on
// sc", "@jane via my tg").
const AT_BEFORE_RE = /(?<![a-z0-9])@[a-z0-9_.]{3,30}[^a-z0-9]{1,3}(?:on|at|via)[^a-z0-9]{1,3}(?:my[^a-z0-9]{1,3})?$/;
// handleLikeOnly rails: a handle-looking token after a separator, or any
// handle after a handle noun ("line id: janedoe"). A plain word after a bare
// colon is not a handle there.
const DIRECT_HANDOVER_STRICT_RE = new RegExp(
  `^(?:\\s{0,2}[:=@-]\\s{0,3}${HANDLE_LIKE}`
  + `|\\s{1,2}${DIRECT_HANDLE_NOUN}\\s{0,2}(?:[:=@]\\s{0,3}(?:${HANDLE_LIKE}|${PLAIN_WORD_HANDLE})|-\\s{0,3}${HANDLE_LIKE})`
  + `|\\s{1,2}${SPACED_HANDLE})`,
);
// Shape 3: an invitation in front, a handle-looking token after.
const INVITE_BEFORE_RE = /(?<![a-z0-9])(?:add|follow|find|message|msg|dm|hmu|hit me up|reach me|reach out|contact me|talk to me|chat with me)(?:\s+me)?\s+(?:on|at|via|over)\s*$/;
const INVITE_AFTER_RE = new RegExp(`^[^a-z0-9]{0,3}(?:${HANDLE_LIKE}|${PLAIN_WORD_HANDLE})`);

function isHandover(text, start, end, { adjacentAtOnly = false, handleLikeOnly = false } = {}) {
  const after = text.slice(end, end + 50);
  if (adjacentAtOnly) {
    // No 40-character @ radius for an ordinary word: the "@" has to sit
    // right next to it.
    if (ADJACENT_AT_RE.test(after)) return true;
    if (AT_BEFORE_RE.test(text.slice(Math.max(0, start - HANDLE_RADIUS), start))) return true;
  } else if (AT_HANDLE_RE.test(text.slice(Math.max(0, start - HANDLE_RADIUS), end + HANDLE_RADIUS))) {
    return true;
  }
  if ((handleLikeOnly ? DIRECT_HANDOVER_STRICT_RE : DIRECT_HANDOVER_RE).test(after)) return true;
  const before = text.slice(Math.max(0, start - 30), start);
  if (INVITE_BEFORE_RE.test(before) && INVITE_AFTER_RE.test(after)) return true;
  if (!POSSESSIVE_BEFORE_RE.test(before)) return false;
  if (handleLikeOnly) return HANDOVER_AFTER_STRICT_RE.test(after);
  return HANDOVER_AFTER_RE.test(after) || POSSESSIVE_POINTER_RE.test(after);
}

// Links whose only purpose is opening a chat with someone somewhere else.
// Flagged on sight, like the payment-app names: "t.me/janedoe" and
// "wa.me/16175551234" carry no other meaning.
// wa.link is a widely used WhatsApp click-to-chat link service (round-10
// accounts#4) -- a creator's public "website" field is any https URL.
const CONTACT_LINK_RE = /(?<![a-z0-9])(?:t\.me|telegram\.me|wa\.me|wa\.link|api\.whatsapp\.com\/send|snapchat\.com\/add|kik\.me)\/[a-z0-9_+?=]/;

// A cashtag is written exactly like a token ticker, and tickers get talked
// about here. So a bare "$word" is not evidence of anything on its own; it
// needs payment context next to it. The platform's own tickers are exempt
// outright for the same reason wallet addresses are (see the header).
const CASHTAG_RE = /(?<![a-z0-9$])\$([a-z][a-z0-9_]{1,19})(?![a-z0-9_])/g;
//
// The chain assets the site itself tells people to use are exempt too: the
// credits page says to buy credits with $USDG, and bridging/gas talk names
// $ETH and $USDC. Reading "buy them with $USDG on the Credits page" as a
// Cash App cashtag blocked creators for describing the platform's own
// checkout and logged them as fee-dodgers.
const EXEMPT_TICKERS = new Set(
  ['onlyone', 'onlyass', 'usdg', 'usdc', 'eth', 'weth', String(process.env.NEXT_PUBLIC_MARKETPLACE_STABLE_SYMBOL || '').toLowerCase()]
    .filter(Boolean),
);

// A phone number written with punctuation only phone numbers use: dots or
// dashes between the groups, parens around the area code, a leading + country
// code. Those are flagged on sight. Note the 3-3-4 alternative takes "." or
// "-" but NOT a space -- a space-separated 3-3-4 is also how ordinary copy
// lists numbers ("Bundle: 250 500 1000 tokens"), so it moved down to the
// cue-gated group below.
//
// The lookbehinds refuse only a preceding DIGIT, or a digit plus one "."/"-"
// (so a group inside a longer run of numbers is not read as its own phone).
// They used to refuse any preceding "-" or ".", which let one glued separator
// hide the whole number: "text me -617-555-1234", "tel.617.555.1234".
const PHONE_FORMATTED_RE = /(?<!\d)(?<!\d[.\-])(?:\+?\d{1,2}[\s.\-]?)?(?:\(\d{3}\)[\s.\-]?\d{3}[\s.\-]?\d{4}|\d{3}[.\-]\d{3}[.\-]\d{4})(?![\d\-])/;
// A leading "+" in front of 9-15 digits is phone notation in a way a bare
// number isn't. An amount written "+1000000000" would trip this, which is the
// one accepted false positive here -- amounts on this platform are written
// with separators ("1,000,000,000") or a suffix ("1B"), which don't match.
// This is also what still catches "+1 617 555 1234".
const PHONE_INTERNATIONAL_RE = /(?<![\w+])\+(?:[\s.\-]?\d){9,15}(?![\d])/;
// Deliberately excludes a bare "number" -- "order number 1234567890" is not
// someone handing out their phone.
// Messaging apps that run on a phone number (signal, facetime, skype,
// telegram) count as cues too: "signal me 6175551234" is the same message as
// "text me 6175551234".
// The cue may be glued straight onto the number ("text6175551234",
// "textme.6175551234"): only a following LETTER breaks it.
// Phone-number messengers other than WhatsApp count the same way: Viber,
// WeChat and LINE ("line id", "line me" -- a bare "line" is ordinary prose and
// never a cue), plus WhatsApp's misspellings and its wa.me link. A bare "wa"
// is not a cue: it is also the state abbreviation in every Washington address.
const PHONE_CUE_RE = /(?<![a-z0-9])(?:call|text|txt|whatsapp|whats ?app|whatsap|wh?att?s?app|wapp|wa\.me|sms|imessage|hmu|phone|cell|cellphone|mobile|signal|facetime|skype|telegram|viber|we ?chat|line (?:id|me)|tel|ph|callme|textme|txtme|my (?:number|digits|line))(?![a-z])/;
// "reach me / hit me / dm me" are much weaker: they are also how a creator
// says "dm me about order 1234567890". So they only count when the number
// comes DIRECTLY after them ("dm me 6175551234", "hit me up at 617-555 1234"),
// with at most "up"/"at"/"on" and a separator in between -- never anywhere in
// the 40-character radius the strong cues get.
const PHONE_INVITE_BEFORE_RE = /(?<![a-z0-9])(?:reach me|hit me|dm me)(?:\s{1,2}(?:up|at|on)){0,2}[\s:,\-@]{0,3}$/;
// The two phone shapes that are ALSO ordinary copy here: a bare run of digits
// (order ids, epoch timestamps, $ONLYONE amounts) and a 3-3-4 grouping split
// by spaces ("sizes: 120 180 2400", "ratios ... 720 480 1920"). Neither counts
// without a "call/text me" cue beside it. The bare run must be CONTIGUOUS:
// letting the character class swallow spaces glued two unrelated numbers into
// one run, so "Phone wallpaper pack, 1920 1080" read as an 8-digit phone.
//
// Also cue-gated, and the most common way a US number is actually written:
// the 3-3-4 groups split by ANY mix of single separators -- "617 555-1234",
// "617-555 1234", "617/555/1234". PHONE_FORMATTED_RE only takes "."/"-" in
// both slots, so a mixed one walked past even right next to "text me".
// Last, PHONE_SPACED_DIGITS_RE's split-up forms ("617 555 12 34",
// "6 1 7 5 5 5 1 2 3 4"). Commas are deliberately not a
// separator, or "1,000,000,000" near the word "call" would be a phone.
const PHONE_AMBIGUOUS_RE = /(?<![\d$])(?<![\d$][.\-])(?:\d{3}\s\d{3}\s\d{4}|\d{3}[\s.\-/]\d{3}[\s.\-/]\d{4}|\+?\d{7,15})(?![\d\-])/g;
// Two shapes only, both of which read as ONE number: every digit split off by
// the SAME separator ("6 1 7 5 5 5 1 2 3 4"), or the US 3-3-2-2 grouping
// ("617 555 12 34"). Any 10-11 digits with optional gaps used to count, which
// read a list of dates ("10 11 12 13 14") or a count to ten as a phone.
const PHONE_SPACED_DIGITS_RE = /(?<![\d$][ .\-/()]?)(?<![\d$])(?:\d([ .\-/])\d(?:\1\d){8,9}|(?:1[ .\-/])?\d{3}[ .\-/]\d{3}[ .\-/]\d{2}[ .\-/]\d{2})(?![ .\-/()]?\d)/g;
// Non-US mobiles, the way they are actually written: UK 5-6 / 5-3-3
// ("07700 900123"), Australian 4-3-3 ("0412 345 678"), French 2-2-2-2-2 ("06
// 12 34 56 78"), German 4-4-4 ("0151 2345 6789") -- 9 to 15 digits in groups
// of two to six, split by single spaces, dots or dashes, starting with the
// trunk "0" every one of those is dialled with (round-10 accounts#5). The
// leading 0 is what tells it apart from a price list next to a cue ("text me
// for prices: 10 20 30 50 100 250"); the "+44 ..." form is already
// PHONE_INTERNATIONAL_RE's. Cue-gated like the rest of this group.
const PHONE_GROUPED_RE = /(?<![\d$])(?<![\d$][.\-])0\d{1,5}(?:[ .\-]\d{2,6}){1,5}(?![\d])(?![.\-]\d)/g;
function groupedPhoneDigits(match) {
  const n = (match.match(/\d/g) || []).length;
  return n >= 9 && n <= 15;
}
// Tighter than CUE_RADIUS on purpose: the cue and the number have to be in the
// same breath, not merely the same paragraph, or every token amount posted
// near the word "call" becomes a violation. Checked in BOTH directions --
// "6175551234 call me" is the same message as "call me 6175551234".
const PHONE_CUE_RADIUS = 40;

function hasPhoneCueNear(text, start, end) {
  if (PHONE_CUE_RE.test(text.slice(Math.max(0, start - PHONE_CUE_RADIUS), end + PHONE_CUE_RADIUS))) return true;
  return PHONE_INVITE_BEFORE_RE.test(text.slice(Math.max(0, start - 24), start));
}

// "five five five one two three four" -- digits spelled out to walk past every
// digit-based pattern above. Seven in a row is a long run, but it is NOT past
// what ordinary writing does: counting ("one two three four five six seven
// eight nine ten"), numbering photos, and -- on a surface that is mostly adult
// DMs -- a moan ("oh oh oh oh oh oh oh") all get there. So this gets the same
// cue gate as a bare run of digits instead of flagging on sight.
const SPELLED_DIGIT = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|niner)';
const SPELLED_PHONE_RE = new RegExp(
  `(?<![a-z0-9])${SPELLED_DIGIT}(?:[^a-z0-9]{1,3}${SPELLED_DIGIT}){6,}(?![a-z0-9])`,
  'g',
);

// The lengths are capped rather than left open (`+`/`{2,}`) on purpose: an
// unbounded run of a class that contains "." backtracks once per starting
// position on a wall of punctuation, which turns a pasted bio into seconds of
// CPU. 64 is the RFC limit for a local part anyway.
const EMAIL_RE = /[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]{1,96}\.[a-z]{2,24}/g;
// The most common handover leaves the TLD off: "janedoe@gmail", "dm me
// janedoe@protonmail", "janedoe(at)gmail". A mail-provider name after the @
// is an address with or without ".com". A bare English "at" only counts in
// front of a provider name when the local part looks like a username rather
// than an ordinary word: "janedoe at gmail" counts, but "email me at gmail",
// "she is at gmail right now" and "we at yahoo" name no address. So with a
// bare "at" the local part must not be a pronoun/common word and must be at
// least 4 characters or carry a digit or . _ - +.
const MAIL_PROVIDER = '(?:gmail|googlemail|yahoo|outlook|hotmail|icloud|proton|protonmail|pm|aol|gmx|yandex|zoho|tutanota)';
const PROVIDER_EMAIL_RE = new RegExp(
  `(?<![a-z0-9])([a-z0-9._%+\\-]{2,64})\\s{0,3}(@|\\(at\\)|\\[at\\]|\\{at\\}|\\bat\\b)\\s{0,3}${MAIL_PROVIDER}(?![a-z])`,
  'g',
);
const PRONOUNS = new Set([
  'me', 'us', 'you', 'him', 'her', 'them', 'it', 'email', 'mail', 'dm', 'msg',
  'i', 'im', 'we', 'he', 'she', 'they', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'not', 'all', 'also', 'still', 'just', 'now', 'here', 'there', 'back', 'home', 'stay', 'stays',
  'staying', 'work', 'works', 'worked', 'working', 'job', 'jobs', 'intern', 'interned', 'interning',
  'someone', 'somebody', 'friend', 'friends', 'people', 'folks', 'guys', 'team', 'engineer',
  'engineers', 'employees', 'employee', 'even', 'only', 'right', 'over', 'used', 'started', 'hired',
  'currently', 'formerly', 'mom', 'dad', 'sister', 'brother', 'wife', 'husband', 'bf', 'gf',
]);

function looksLikeUsername(local) {
  return local.length >= 4 || /[0-9._+\-]/.test(local);
}
// An address on one of our own domains isn't taking anyone off-platform.
// Every domain this platform actually serves from. joinonlyone.com was
// missing, so the site's own footer contact address -- team@onlyone1.fun on
// joinonlyone.com -- was being flagged as off-platform routing and written to
// the admin violations queue.
const PLATFORM_EMAIL_DOMAINS = [
  'joinonlyone.com',
  'shoponeonly.com',
  'onlyone1.fun',
  'onlyass.fun',
  'onlyass.xyz',
  'onlyass.online',
  'onlyass.shop',
];
// "john at gmail dot com", "john (at) gmail [dot] com" -- the @ and the dot
// written out to slip past EMAIL_RE. Both separators are captured because
// which spelling was used decides whether this is an address at all (see the
// check in detectPaymentCircumvention).
const SPELLED_EMAIL_RE = /(?<![a-z0-9])([a-z0-9._%+\-]{2,64})\s{0,4}(@|\(at\)|\[at\]|\{at\}|\bat\b)\s{0,4}([a-z0-9\-]{2,63})\s{0,4}(\.|\(dot\)|\[dot\]|\{dot\}|\bdot\b)\s{0,4}([a-z]{2,6})(?![a-z0-9])/g;
// Without this, "meet me at the dot com boom" reads as an email address.
const NON_DOMAIN_WORDS = new Set(['the', 'a', 'an', 'my', 'your', 'our', 'his', 'her', 'their', 'its', 'this', 'that', 'some', 'any', 'no', 'one', 'it']);
const EMAIL_TLDS = new Set(['com', 'net', 'org', 'io', 'co', 'me', 'info', 'mail', 'edu', 'us', 'uk', 'ca', 'de', 'ru', 'fr', 'xyz', 'fun', 'online', 'live', 'link', 'app', 'shop', 'site', 'email']);

function isPlatformDomain(domain) {
  return PLATFORM_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * `crossTag: true` is for text that was JOINED from several separate tags
 * (lib/listings-store.js findCircumventionInTags). There, a strong payment
 * word always sits inside some OTHER tag than the contact-app name -- a tag
 * that says the same app name next to a payment word on its own was already
 * screened whole -- and a category tag like "pay pig", "pay per view" or
 * "cheaper" is not an instruction to pay on that app. So in this mode the
 * contact apps and the ambiguous payment names count only on a HANDOVER (an
 * @handle, a handle-shaped next tag, "add me on ..."), never on a payment
 * word nearby. Everything else is screened exactly as usual. The one cue that
 * DOES count across tags -- a tag ending in a payment cue directly followed
 * by the app's tag ("pay me on" + "snapchat") -- is checked pair by pair by
 * the caller with tagEndsWithPaymentCue, in the normal mode.
 */
export function detectPaymentCircumvention(text, { crossTag = false } = {}) {
  const reasons = [];
  const add = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  // Every reading of the text (see normalizedReadings: a capital-I-for-l
  // spelling is judged both ways), reasons merged.
  for (const normalized of normalizedReadings(text || '')) detectIn(normalized, crossTag, add, reasons);
  return { flagged: reasons.length > 0, reasons };
}

function detectIn(normalized, crossTag, add, reasons) {

  for (const { label, re } of PAYMENT_KEYWORDS) {
    for (const m of normalized.matchAll(re)) {
      if (!isWordNotNumber(m[0])) continue;
      add(`mentions "${label}"`);
      break;
    }
  }

  for (const { label, re } of AMBIGUOUS_PAYMENT_KEYWORDS) {
    for (const m of normalized.matchAll(re)) {
      if (!isWordNotNumber(m[0])) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      if ((!crossTag && hasStrongPaymentCueNear(normalized, start, end)) || isHandover(normalized, start, end)) {
        add(`mentions "${label}" in a payment context`);
        break;
      }
    }
  }

  for (const { label, re } of OFF_PLATFORM_KEYWORDS) {
    for (const m of normalized.matchAll(re)) {
      if (!isWordNotNumber(m[0])) continue;
      add(`mentions "${label}"`);
      break;
    }
  }

  for (const { label, re } of GLUED_OFF_PLATFORM_KEYWORDS) {
    for (const m of normalized.matchAll(re)) {
      if (!isWordNotNumber(m[0])) continue;
      add(`mentions "${label}"`);
      break;
    }
  }
  if (OFF_PLATFORM_LINK_RE.test(normalized)) add('links to an off-platform store or link page');

  for (const { label, re, handoverOnly, adjacentAtOnly, handleLikeOnly, ordinary } of CONTACT_RAIL_KEYWORDS) {
    for (const m of normalized.matchAll(re)) {
      if (!isWordNotNumber(m[0])) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      // An ordinary phrasing of the word ("oh snap", "snap a pic") is judged
      // like an adjacentAtOnly rail for this one match.
      const ordinaryHere = !!ordinary && (ordinary.before.test(normalized.slice(Math.max(0, start - 10), start))
        || ordinary.after.test(normalized.slice(end, end + 30)));
      if (isHandover(normalized, start, end, { adjacentAtOnly: !!adjacentAtOnly || ordinaryHere, handleLikeOnly: !!handleLikeOnly }) || (!handoverOnly && !crossTag && hasPaymentInstructionAt(normalized, start, end))) {
        add(`points to "${label}" off-platform`);
        break;
      }
    }
  }

  if (CONTACT_LINK_RE.test(normalized)) {
    add('links to an off-platform chat');
  }

  for (const m of normalized.matchAll(CASHTAG_RE)) {
    if (EXEMPT_TICKERS.has(m[1])) continue;
    if (hasPaymentCueNear(normalized, m.index, m.index + m[0].length)) {
      add('looks like a Cash App cashtag');
      break;
    }
  }

  if (PHONE_FORMATTED_RE.test(normalized) || PHONE_INTERNATIONAL_RE.test(normalized)) {
    add('looks like a phone number');
  } else {
    for (const re of [PHONE_AMBIGUOUS_RE, PHONE_SPACED_DIGITS_RE, PHONE_GROUPED_RE]) {
      for (const m of normalized.matchAll(re)) {
        if (re === PHONE_GROUPED_RE && !groupedPhoneDigits(m[0])) continue;
        if (hasPhoneCueNear(normalized, m.index, m.index + m[0].length)) {
          add('looks like a phone number');
          break;
        }
      }
      if (reasons.includes('looks like a phone number')) break;
    }
  }
  for (const m of normalized.matchAll(SPELLED_PHONE_RE)) {
    if (hasPhoneCueNear(normalized, m.index, m.index + m[0].length)) {
      add('looks like a phone number written out in words');
      break;
    }
  }

  for (const m of normalized.matchAll(EMAIL_RE)) {
    if (!isPlatformDomain(m[0].slice(m[0].indexOf('@') + 1))) {
      add('looks like an email address');
      break;
    }
  }
  if (!reasons.includes('looks like an email address')) {
    for (const m of normalized.matchAll(PROVIDER_EMAIL_RE)) {
      const [, local, at] = m;
      if (at === 'at' && (PRONOUNS.has(local) || !looksLikeUsername(local))) continue;
      if (!/[a-z]/.test(local)) continue;
      add('looks like an email address');
      break;
    }
  }
  if (!reasons.includes('looks like an email address')) {
    for (const m of normalized.matchAll(SPELLED_EMAIL_RE)) {
      const [, , at, domain, dot, tld] = m;
      // "<word> at <word>. <word>" is an ordinary English sentence, not an
      // address: "new set drops at midnight. Link in bio", "look at
      // instagram.com for the rest", "the auction is at kekfun.xyz". Nobody
      // spells out the "at" but then writes a literal "." -- if they were
      // willing to write the real dot they'd have written the real "@", and
      // EMAIL_RE above already catches that. So the bare English word only
      // counts opposite a spelled-out or bracketed dot ("john at gmail dot
      // com"); a bracketed "(at)"/"[at]"/"{at}" or a real "@" still counts
      // against either.
      if (at === 'at' && dot === '.') continue;
      if (NON_DOMAIN_WORDS.has(domain) || !EMAIL_TLDS.has(tld)) continue;
      if (isPlatformDomain(`${domain}.${tld}`)) continue;
      add('looks like an email address');
      break;
    }
  }
}

export const PAYMENT_CIRCUMVENTION_MESSAGE =
  "That message wasn't sent -- it looks like it's trying to move a payment off-platform (Cash App, a phone number, an email, etc.), which isn't allowed here.";
