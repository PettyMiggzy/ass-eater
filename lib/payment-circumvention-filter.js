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

/** Everything below matches against this, never the raw text. */
function normalize(raw) {
  return raw
    .normalize('NFKD') // fullwidth and styled unicode (ｖｅｎｍｏ, 𝗩𝗲𝗻𝗺𝗼) collapse to plain letters
    .replace(/[̀-ͯ]/g, '') // drop the combining accents NFKD just split off (venmo with an accent -> venmo)
    .replace(ZERO_WIDTH_RE, '')
    .toLowerCase()
    .replace(HOMOGLYPH_RE, (ch) => HOMOGLYPHS[ch]);
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
].map((k) => ({ ...k, re: buildKeywordRe(k.word) }));

// Messaging apps. Naming one is not itself circumvention -- people talk about
// where they are -- but handing over an account name on one is how a fan gets
// moved off-platform, so these count only next to a handle or payment context.
const CONTACT_RAIL_KEYWORDS = [
  { word: 'telegram', label: 'telegram' },
  { word: 'snapchat', label: 'snapchat' },
  { word: 'snap', label: 'snapchat' },
  { word: 'kik', label: 'kik' },
  { word: 'wickr', label: 'wickr' },
  { word: 'discord', label: 'discord' },
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

// Handing over an account name, as opposed to merely naming a service.
// "we chatted on telegram about the shoot" is conversation; "telegram
// @janedoe" and "my snap is janedoe" are routing a fan off-platform.
//
// Two shapes count, and both are deliberately narrow because the alternative
// is blocking ordinary sentences. An @handle anywhere nearby is one. The
// other needs BOTH a possessive in front of the service name ("my snap", not
// "that snap") AND a handover right after it ("is janedoe", "tag is jdoe") --
// either half alone turns "that snap is hot" and "my snap was blurry" into
// logged violations, and on this platform both are things people actually
// write.
const HANDLE_RADIUS = 40;
const AT_HANDLE_RE = /(?<![a-z0-9])@[a-z0-9_.]{3,30}/;
const POSSESSIVE_BEFORE_RE = /(?<![a-z0-9])(?:my|our|her|his|their)(?:\s+[a-z]{1,12}){0,2}\s*$/;
const HANDOVER_AFTER_RE = /^[^a-z0-9]{0,3}(?:[a-z]{1,10}[^a-z0-9]{1,3}){0,2}(?:is|:|=)[^a-z0-9]{0,3}[a-z0-9_.]{3,30}/;

function isHandover(text, start, end) {
  if (AT_HANDLE_RE.test(text.slice(Math.max(0, start - HANDLE_RADIUS), end + HANDLE_RADIUS))) return true;
  return (
    POSSESSIVE_BEFORE_RE.test(text.slice(Math.max(0, start - 30), start))
    && HANDOVER_AFTER_RE.test(text.slice(end, end + 50))
  );
}

// A cashtag is written exactly like a token ticker, and tickers get talked
// about here. So a bare "$word" is not evidence of anything on its own; it
// needs payment context next to it. The platform's own tickers are exempt
// outright for the same reason wallet addresses are (see the header).
const CASHTAG_RE = /(?<![a-z0-9$])\$([a-z][a-z0-9_]{1,19})(?![a-z0-9_])/g;
const EXEMPT_TICKERS = new Set(['onlyone']);

// A phone number written with punctuation only phone numbers use: dots or
// dashes between the groups, parens around the area code, a leading + country
// code. Those are flagged on sight. Note the 3-3-4 alternative takes "." or
// "-" but NOT a space -- a space-separated 3-3-4 is also how ordinary copy
// lists numbers ("Bundle: 250 500 1000 tokens"), so it moved down to the
// cue-gated group below.
const PHONE_FORMATTED_RE = /(?<![\d\-.])(?:\+?\d{1,2}[\s.\-]?)?(?:\(\d{3}\)[\s.\-]?\d{3}[\s.\-]?\d{4}|\d{3}[.\-]\d{3}[.\-]\d{4})(?![\d\-])/;
// A leading "+" in front of 9-15 digits is phone notation in a way a bare
// number isn't. An amount written "+1000000000" would trip this, which is the
// one accepted false positive here -- amounts on this platform are written
// with separators ("1,000,000,000") or a suffix ("1B"), which don't match.
// This is also what still catches "+1 617 555 1234".
const PHONE_INTERNATIONAL_RE = /(?<![\w+])\+(?:[\s.\-]?\d){9,15}(?![\d])/;
// Deliberately excludes a bare "number" -- "order number 1234567890" is not
// someone handing out their phone.
const PHONE_CUE_RE = /(?<![a-z0-9])(?:call|text|txt|whatsapp|whats ?app|sms|imessage|hmu|phone|cell|cellphone|mobile|my (?:number|digits|line))(?![a-z0-9])/;
// The two phone shapes that are ALSO ordinary copy here: a bare run of digits
// (order ids, epoch timestamps, $ONLYONE amounts) and a 3-3-4 grouping split
// by spaces ("sizes: 120 180 2400", "ratios ... 720 480 1920"). Neither counts
// without a "call/text me" cue beside it. The bare run must be CONTIGUOUS:
// letting the character class swallow spaces glued two unrelated numbers into
// one run, so "Phone wallpaper pack, 1920 1080" read as an 8-digit phone.
const PHONE_AMBIGUOUS_RE = /(?<![\d\-.])(?:\d{3}\s\d{3}\s\d{4}|\+?\d{7,15})(?![\d\-])/g;
// Tighter than CUE_RADIUS on purpose: the cue and the number have to be in the
// same breath, not merely the same paragraph, or every token amount posted
// near the word "call" becomes a violation. Checked in BOTH directions --
// "6175551234 call me" is the same message as "call me 6175551234".
const PHONE_CUE_RADIUS = 40;

function hasPhoneCueNear(text, start, end) {
  return PHONE_CUE_RE.test(text.slice(Math.max(0, start - PHONE_CUE_RADIUS), end + PHONE_CUE_RADIUS));
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

export function detectPaymentCircumvention(text) {
  const raw = String(text || '');
  const normalized = normalize(raw);
  const reasons = [];
  const add = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

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
      if (hasStrongPaymentCueNear(normalized, start, end) || isHandover(normalized, start, end)) {
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

  for (const { label, re } of CONTACT_RAIL_KEYWORDS) {
    for (const m of normalized.matchAll(re)) {
      if (!isWordNotNumber(m[0])) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      if (isHandover(normalized, start, end) || hasStrongPaymentCueNear(normalized, start, end)) {
        add(`points to "${label}" off-platform`);
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
    for (const m of normalized.matchAll(PHONE_AMBIGUOUS_RE)) {
      if (hasPhoneCueNear(normalized, m.index, m.index + m[0].length)) {
        add('looks like a phone number');
        break;
      }
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

  return { flagged: reasons.length > 0, reasons };
}

export const PAYMENT_CIRCUMVENTION_MESSAGE =
  "That message wasn't sent -- it looks like it's trying to move a payment off-platform (Cash App, a phone number, an email, etc.), which isn't allowed here.";
