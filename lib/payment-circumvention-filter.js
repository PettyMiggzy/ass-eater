// Blocks messages/posts that look like an attempt to move a payment off-platform
// (Cash App, Venmo, Zelle, a phone number, an email address, ...) so creators
// can't route fans around the platform's fee. Applies to everyone, no bypass --
// a paid way around this would just be a paid way to dodge the fee it protects.
//
// Deliberately does NOT flag crypto wallet addresses (0x..., bc1..., etc.) --
// this platform's own tipping/payments are denominated in $ONLYASS, so those
// show up in completely legitimate on-platform conversations here, unlike a
// typical fiat-only OnlyFans clone.
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
//   2. Anything that is also ordinary English or ordinary $ONLYASS talk -- the
//      word "chime", a bare run of ten digits, a "$TICKER" -- needs real
//      payment CONTEXT nearby before it counts. Flagging those outright is
//      what blocked innocent users (a "wind chime", a 10-digit order number,
//      every listing priced "1M $ONLYASS") and logged them as violators.

const ZERO_WIDTH_RE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

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
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-',
};
const HOMOGLYPH_RE = new RegExp(
  `[${Object.keys(HOMOGLYPHS).map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}]`,
  'g',
);

/** Everything below matches against this, never the raw text. */
function normalize(raw) {
  return raw
    .normalize('NFKD') // fullwidth and styled unicode (ｖｅｎｍｏ, 𝗩𝗲𝗻𝗺𝗼) collapse to plain letters
    .replace(/[\u0300-\u036f]/g, '') // drop the combining accents NFKD just split off (venmo with an accent -> venmo)
    .replace(ZERO_WIDTH_RE, '')
    .toLowerCase()
    .replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch]);
}

// Digit/symbol substitutions people reach for first (v3nm0, ca$happ, payp4l).
const LEET_CLASSES = {
  a: '[a@4]', b: '[b8]', e: '[e3]', g: '[g9]', i: '[i1!|]', l: '[l1|]',
  o: '[o0]', s: '[s5$]', t: '[t7+]', z: '[z2]',
};
// Punctuation/whitespace allowed between letters, so "c a s h a p p" and
// "v-e-n-m-o" match while ordinary prose can't accidentally line up (only
// non-alphanumerics are allowed through, so any real letter in between breaks
// the run). This is also what lets one spelling cover "cashapp"/"cash app".
const LETTER_GAP = '[^a-z0-9]{0,3}';

/**
 * A word-boundaried, evasion-tolerant matcher for one payment-app name.
 * The leading boundary is what keeps "gazelle" from reading as "zelle"; the
 * suffix group keeps "venmoed"/"cashapped" matching without also matching a
 * longer unrelated word.
 */
function buildKeywordRe(word, flags = '') {
  const body = [...word].map((ch) => LEET_CLASSES[ch] || ch).join(LETTER_GAP);
  return new RegExp(`(?<![a-z0-9])${body}(?:s|es|ed|ing)?(?![a-z0-9])`, flags);
}

// Names that mean a payment rail and nothing else -- flagged on sight.
const PAYMENT_KEYWORDS = [
  { word: 'cashapp', label: 'cash app' },
  { word: 'venmo', label: 'venmo' },
  { word: 'zelle', label: 'zelle' },
  { word: 'paypal', label: 'paypal' },
  { word: 'applepay', label: 'apple pay' },
  { word: 'googlepay', label: 'google pay' },
  { word: 'westernunion', label: 'western union' },
  { word: 'moneygram', label: 'moneygram' },
].map((k) => ({ ...k, re: buildKeywordRe(k.word) }));

// Payment apps whose name is also an ordinary English word -- a wind chime,
// chiming in, a clock chiming the hour. Only counts with payment context
// nearby, otherwise every innocent use of the word is a logged violation.
const AMBIGUOUS_PAYMENT_KEYWORDS = [
  { word: 'chime', label: 'chime' },
].map((k) => ({ ...k, re: buildKeywordRe(k.word, 'g') }));

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

// A cashtag is written exactly like a token ticker, and this platform runs on
// tickers -- every listing is priced in "$ONLYASS" and the launchpad exists so
// creators can mint their own. So a bare "$word" is not evidence of anything
// here; it needs payment context next to it. $ONLYASS itself is exempt
// outright for the same reason wallet addresses are (see the header): it is
// this platform's own money. Add a creator's ticker here if one ever becomes
// common enough to keep tripping the cue check.
const CASHTAG_RE = /(?<![a-z0-9$])\$([a-z][a-z0-9_]{1,19})(?![a-z0-9_])/g;
const EXEMPT_TICKERS = new Set(['onlyass']);

// A phone number the way a human actually writes one: separators between the
// groups, or parens around the area code, or a leading + country code. A bare
// run of ten digits is NOT treated as a phone number -- order ids, epoch
// timestamps and $ONLYASS amounts are routinely 10+ digits here, and matching
// those was blocking ordinary posts. A bare run still counts when an explicit
// "call/text me" style cue sits right in front of it (see PHONE_CUE_RE).
const PHONE_FORMATTED_RE = /(?<![\d\-.])(?:\+?\d{1,2}[\s.\-]?)?(?:\(\d{3}\)[\s.\-]?\d{3}[\s.\-]?\d{4}|\d{3}[\s.\-]\d{3}[\s.\-]\d{4})(?![\d\-])/;
// A leading "+" in front of 9-15 digits is phone notation in a way a bare
// number isn't. An amount written "+1000000000" would trip this, which is the
// one accepted false positive here -- amounts on this platform are written
// with separators ("1,000,000,000") or a suffix ("1B"), which don't match.
const PHONE_INTERNATIONAL_RE = /(?<![\w+])\+(?:[\s.\-]?\d){9,15}(?![\d])/;
// Deliberately excludes a bare "number" -- "order number 1234567890" is not
// someone handing out their phone.
const PHONE_CUE_RE = /(?<![a-z0-9])(?:call|text|txt|whatsapp|whats ?app|sms|imessage|hmu|phone|cell|cellphone|mobile|my (?:number|digits|line))(?![a-z0-9])/;
const DIGIT_RUN_RE = /\+?\d[\d\s().\-]{5,18}\d/g;
const PHONE_CUE_RADIUS = 24;
// "five five five one two three four" -- digits spelled out to walk past every
// digit-based pattern above. Seven in a row is the gate; nothing innocent
// counts that far.
const SPELLED_DIGIT = '(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|niner)';
const SPELLED_PHONE_RE = new RegExp(
  `(?<![a-z0-9])${SPELLED_DIGIT}(?:[^a-z0-9]{1,3}${SPELLED_DIGIT}){6,}(?![a-z0-9])`,
);

// The lengths are capped rather than left open (`+`/`{2,}`) on purpose: an
// unbounded run of a class that contains "." backtracks once per starting
// position on a wall of punctuation, which turns a pasted bio into seconds of
// CPU. 64 is the RFC limit for a local part anyway.
const EMAIL_RE = /[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]{1,96}\.[a-z]{2,24}/g;
// An address on one of our own domains isn't taking anyone off-platform.
const PLATFORM_EMAIL_DOMAINS = ['onlyass.fun', 'onlyass.xyz', 'onlyass.online'];
// "john at gmail dot com", "john (at) gmail [dot] com" -- the @ and the dot
// written out to slip past EMAIL_RE.
const SPELLED_EMAIL_RE = /(?<![a-z0-9])([a-z0-9._%+\-]{2,64})\s{0,4}(?:@|\(at\)|\[at\]|\{at\}|\bat\b)\s{0,4}([a-z0-9\-]{2,63})\s{0,4}(?:\.|\(dot\)|\[dot\]|\bdot\b)\s{0,4}([a-z]{2,6})(?![a-z0-9])/g;
// Without this, "meet me at the dot com boom" reads as an email address.
const NON_DOMAIN_WORDS = new Set(['the', 'a', 'an', 'my', 'your', 'our', 'his', 'her', 'their', 'its', 'this', 'that', 'some', 'any', 'no', 'one', 'it']);
const EMAIL_TLDS = new Set(['com', 'net', 'org', 'io', 'co', 'me', 'info', 'mail', 'edu', 'us', 'uk', 'ca', 'de', 'ru', 'fr', 'xyz', 'fun', 'online', 'live', 'link', 'app', 'shop', 'site', 'email']);

function isPlatformDomain(domain) {
  return PLATFORM_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function countDigits(s) {
  return (s.match(/\d/g) || []).length;
}

export function detectPaymentCircumvention(text) {
  const raw = String(text || '');
  const normalized = normalize(raw);
  const reasons = [];
  const add = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  for (const { label, re } of PAYMENT_KEYWORDS) {
    if (re.test(normalized)) add(`mentions "${label}"`);
  }

  for (const { label, re } of AMBIGUOUS_PAYMENT_KEYWORDS) {
    for (const m of normalized.matchAll(re)) {
      if (hasPaymentCueNear(normalized, m.index, m.index + m[0].length)) {
        add(`mentions "${label}" in a payment context`);
        break;
      }
    }
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
    for (const m of normalized.matchAll(DIGIT_RUN_RE)) {
      const digits = countDigits(m[0]);
      if (digits < 7 || digits > 15) continue;
      if (PHONE_CUE_RE.test(normalized.slice(Math.max(0, m.index - PHONE_CUE_RADIUS), m.index))) {
        add('looks like a phone number');
        break;
      }
    }
  }
  if (SPELLED_PHONE_RE.test(normalized)) add('looks like a phone number written out in words');

  for (const m of normalized.matchAll(EMAIL_RE)) {
    if (!isPlatformDomain(m[0].slice(m[0].indexOf('@') + 1))) {
      add('looks like an email address');
      break;
    }
  }
  if (!reasons.includes('looks like an email address')) {
    for (const m of normalized.matchAll(SPELLED_EMAIL_RE)) {
      const [, , domain, tld] = m;
      if (NON_DOMAIN_WORDS.has(domain) || !EMAIL_TLDS.has(tld)) continue;
      if (isPlatformDomain(`${domain}.${tld}`)) continue;
      add('looks like an email address');
      break;
    }
  }

  return { flagged: reasons.length > 0, reasons };
}

export const PAYMENT_CIRCUMVENTION_MESSAGE =
  "That message wasn't sent -- it looks like it's trying to move a payment off-platform (Cash App, a phone number, an email, etc.), which isn't allowed here.";
