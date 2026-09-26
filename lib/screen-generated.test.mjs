// COMBINATORIAL regression net for the minor-age screen (round-19 accounts,
// the "stop fixing one string at a time" decision). lib/screen-corpus.test.mjs
// is the hand-written table of every string an audit ever named; this file
// GENERATES the shapes instead, so a spelling nobody has typed yet is already
// covered. Seven rounds running, each fix closed the exact strings in the
// finding and the next audit found the same shape with a different separator,
// adjective, tail or order. Pure: no database, no mocks.
//
// THE SPEC (decided round 19):
//   AGES   digits 10..17; spelled eleven..seventeen; "ten" only with the
//          sexual words that are not also names (porn, fuck, slut, pussy,
//          nudes, horny, xxx) and only as its own word.
//   WORDS  sexual: porn sex cum fuck slut whore pussy nudes horny wet naked xxx
//          singular person: girl boy babe teen virgin gf bf sis stepsis
//          daughter twink schoolgirl, "highschool girl".
//   SHAPES "<age><sep><word>" and "<word><sep><age>", sep one of
//          '', ' ', '_', '-', '.', ' and ', 'and', 'n'; optionally ONE
//          adjective (hot tight wet little sweet petite) in front of the word;
//          optionally a name prefix (jess, hot, mia) glued or separated;
//          optionally a tail ('', emoji, ' dm me', ' here', ' lol', ' xx',
//          ' waiting for you'); optionally yo / y.o. / years old / yrs old
//          after the age; plus "barely <age>" and "highschool"/"high school" +
//          a person word.
//   REFUSED in every name-like context (handle, username, social handle, tag)
//          AND in free text (bio, title, description, DM -- one code path,
//          context null/bio/title/description all run it). One carve-out, free
//          text only: "<digit> <adjective> <plural or content noun>" ("12 hot
//          porn", "10 tight nudes") is a count and not asserted either way.
//   PASSED in free text: heights, sizes, ratings, price menus, counts with a
//          plural or content noun, episode/chapter/season/volume numbers,
//          years, clock times and dates, and every adult age (18+) in the
//          same shapes as above. Name-like contexts may over-refuse numbers
//          (a refused handle costs a different pick) but never common names
//          and words (kirsteen, teena, essex...).
//
// Prints counts per group and exits 1 on ANY mismatch. Run with:
//   node --no-warnings --import ./test-register.mjs lib/screen-generated.test.mjs

const { screenPublicText } = await import('./prohibited-terms.js');

const NAME_LIKE = ['handle', 'username', 'social_instagram', 'tag'];
const FREE = [null, 'bio', 'title', 'description'];
const EVERY = [...NAME_LIKE, ...FREE];

const DIGIT_AGES = ['10', '11', '12', '13', '14', '15', '16', '17'];
const SPELLED_AGES = ['eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen'];
const SEXUAL = ['porn', 'sex', 'cum', 'fuck', 'slut', 'whore', 'pussy', 'nudes', 'horny', 'wet', 'naked', 'xxx'];
const PERSON = ['girl', 'boy', 'babe', 'teen', 'virgin', 'gf', 'bf', 'sis', 'stepsis', 'daughter', 'twink', 'schoolgirl',
  'highschool girl'];
const WORDS = [...SEXUAL, ...PERSON];
const TEN_WORDS = ['porn', 'fuck', 'slut', 'pussy', 'nudes', 'horny', 'xxx'];
// Content nouns: with a digit and an adjective in free text they read as a
// count ("12 hot porn clips" minus the clips) -- the spec's one carve-out.
const CONTENT = new Set(['nudes', 'porn', 'sex', 'xxx', 'cum']);
const SEPS = ['', ' ', '_', '-', '.', ' and ', 'and', 'n'];
const ADJS = ['hot', 'tight', 'wet', 'little', 'sweet', 'petite'];
const PREFIXES = ['jess', 'hot', 'mia'];
const TAILS = ['', ' 💦', ' 🥵😈', ' dm me', ' here', ' lol', ' xx', ' waiting for you'];
const AGE_WORDS = ['', 'yo', ' yo', ' y.o.', ' years old', ' yrs old', '-year-old'];

// Deterministic choice, so a failure reproduces exactly.
let seed = 19;
const pick = (list) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return list[seed % list.length];
};

// The joiner between an adjective and its word follows the main separator:
// glued when the label is glued, a space when the separator is a word.
const adjJoin = (sep) => (['', ' ', '_', '-', '.'].includes(sep) ? sep : sep === ' and ' ? ' ' : '');

function build({ age, word, sep, order, adj = '', prefix = '', prefixGlued = false, tail = '', ageWord = '' }) {
  const w = adj ? `${adj}${adjJoin(sep)}${word}` : word;
  const a = `${age}${ageWord}`;
  const core = order === 'age' ? `${a}${sep}${w}` : `${w}${sep}${a}`;
  // "jess" glued onto a leading "teen" spells the surname Steen ("jessteen"
  // is a must-pass name in the corpus), so that one prefix stays separated.
  const glue = prefixGlued && !(core.startsWith('teen') && prefix.endsWith('s'));
  const head = prefix ? (glue ? prefix : `${prefix} `) : '';
  return `${head}${core}${tail}`;
}

const groups = new Map();
const addCase = (group, expect, contexts, text) => {
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push({ expect, contexts, text });
};

function refuseContexts({ age, word, adj }) {
  // The free-text count carve-out: a DIGIT, an adjective, a content noun.
  if (adj && /^[0-9]/.test(age) && CONTENT.has(word)) return NAME_LIKE;
  return EVERY;
}

// --- MUST REFUSE -----------------------------------------------------------
for (const age of [...DIGIT_AGES, ...SPELLED_AGES]) {
  for (const word of WORDS) {
    for (const sep of SEPS) {
      for (const order of ['age', 'word']) {
        // The bare shape.
        addCase('refuse: bare shape', 'refuse', EVERY, build({ age, word, sep, order }));
        // A decorated variant: an adjective, a prefix, a tail, an age word.
        const adjPick = pick(['', ...ADJS]);
        const adj = adjPick === word ? '' : adjPick;
        const prefix = pick(['', ...PREFIXES]);
        const prefixGlued = pick([true, false]);
        const tail = pick(TAILS);
        const ageWord = pick(AGE_WORDS);
        const spec = { age, word, sep, order, adj, prefix, prefixGlued, tail, ageWord };
        addCase('refuse: decorated', 'refuse', refuseContexts(spec), build(spec));
        // Every tail on the plain shape (the round-18 regression was a tail).
        const tail2 = TAILS[(DIGIT_AGES.length + WORDS.indexOf(word) + SEPS.indexOf(sep)) % TAILS.length] || ' here';
        addCase('refuse: tail', 'refuse', EVERY, build({ age, word, sep, order, tail: tail2 }));
      }
    }
  }
}
// "ten": its own word, the non-name sexual words only.
for (const word of TEN_WORDS) {
  for (const sep of [' ', '_', '-', '.', ' and ']) {
    for (const order of ['age', 'word']) {
      for (const tail of TAILS) {
        addCase('refuse: ten', 'refuse', EVERY, build({ age: 'ten', word, sep, order, tail }));
      }
      addCase('refuse: ten', 'refuse', EVERY, build({ age: 'ten', word, sep, order, prefix: pick(PREFIXES) }));
    }
  }
}
// Every adjective, every tail, age first and word first, spelled and digits.
for (const age of ['16', 'sixteen', '15', 'fifteen']) {
  for (const adj of ADJS) {
    for (const word of ['pussy', 'slut', 'girl', 'babe', 'virgin', 'whore']) {
      if (adj === word) continue;
      for (const tail of TAILS) {
        addCase('refuse: adjective x tail', 'refuse', EVERY, build({ age, word, sep: ' ', order: 'age', adj, tail }));
        addCase('refuse: adjective x tail', 'refuse', EVERY, build({ age, word, sep: ' ', order: 'word', adj, tail }));
      }
    }
  }
}
// Every age word, both orders.
for (const age of [...DIGIT_AGES, ...SPELLED_AGES]) {
  for (const ageWord of AGE_WORDS.filter(Boolean)) {
    for (const word of ['girl', 'slut', 'porn', 'nudes', 'pussy', 'babe']) {
      addCase('refuse: age word', 'refuse', EVERY, build({ age, word, sep: ' ', order: 'age', ageWord }));
      addCase('refuse: age word', 'refuse', EVERY, build({ age, word, sep: ' ', order: 'word', ageWord }));
    }
  }
}
// Name prefixes, glued and separated.
for (const prefix of PREFIXES) {
  for (const age of ['16', 'sixteen', '13', 'thirteen']) {
    for (const word of WORDS) {
      for (const prefixGlued of [true, false]) {
        addCase('refuse: name prefix', 'refuse', EVERY, build({ age, word, sep: '', order: 'age', prefix, prefixGlued }));
        addCase('refuse: name prefix', 'refuse', EVERY, build({ age, word, sep: ' ', order: 'word', prefix, prefixGlued }));
      }
    }
  }
}
// Round-19 fix-up: ordinary nouns that LOOK like a rank word in front of the
// age ("cam model 16 horny"), and a price-looking number tacked onto the end
// ("Mia 16 wet pussy 25"). neutralizeNonAges must launder neither.
const RANKISH = ['model', 'cam model', 'gen', 'room', 'row', 'rated', 'unit', 'rank', 'seat', 'gate', 'floor'];
for (const lead of RANKISH) {
  for (const age of ['16', '13', 'sixteen']) {
    for (const word of ['slut', 'horny', 'porn', 'girl', 'whore', 'babe']) {
      for (const sep of [' ', '_', '-', '.']) addCase('refuse: rank-looking lead', 'refuse', EVERY, `${lead}${sep}${age} ${word}`);
      addCase('refuse: rank-looking lead', 'refuse', EVERY, `${lead.replace(/ /g, '')}${age}${word}`);
      addCase('refuse: rank-looking lead', 'refuse', EVERY, `${lead} ${age} and ${word}`);
    }
  }
}
for (const lead of ['no', 'set', 'pic', 'vid', 'clip', 'take', 'round', 'photo', 'page']) {
  for (const age of ['16', '13']) {
    for (const word of ['slut', 'horny', 'girl', 'porn']) addCase('refuse: rank-looking lead', 'refuse', NAME_LIKE, `${lead}${age}${word}`);
  }
}
for (const lead of ['Mia', 'Emma', 'sexy', 'hot', 'jess']) {
  for (const age of ['16', '15', '13']) {
    for (const phrase of ['wet pussy', 'tight pussy', 'horny pussy', 'horny slut', 'wet slut']) {
      for (const price of ['25', '20', '40']) addCase('refuse: price tail', 'refuse', EVERY, `${lead} ${age} ${phrase} ${price}`);
    }
  }
}
// "barely <age>", and highschool + a person word.
for (const age of [...DIGIT_AGES, ...SPELLED_AGES]) {
  for (const sep of ['', ' ', '_', '-', '.']) {
    for (const tail of ['', ' 💦', ' lol', ' dm me']) addCase('refuse: barely', 'refuse', EVERY, `barely${sep}${age}${tail}`);
  }
}
for (const school of ['highschool', 'high school', 'high-school', 'highschool_', 'middleschool', 'middle school']) {
  for (const word of ['girl', 'boy', 'slut', 'babe', 'virgin', 'gf', 'whore', 'teen']) {
    for (const tail of ['', ' nudes', ' 💦', ' lol']) {
      const sep = school.endsWith('_') ? '' : ' ';
      addCase('refuse: highschool', 'refuse', EVERY, `${school}${sep}${word}${tail}`);
    }
    addCase('refuse: highschool', 'refuse', NAME_LIKE, `${school.replace(/[\s_-]/g, '')}${word}`);
  }
}

// --- MUST PASS -------------------------------------------------------------
// Adult ages in the same shapes, everywhere.
const ADULT_AGES = ['18', '19', '20', '21', '25', '30', 'eighteen', 'nineteen', 'twenty'];
const ADULT_WORDS = WORDS.filter((w) => !['teen', 'schoolgirl', 'highschool girl'].includes(w));
for (const age of ADULT_AGES) {
  for (const word of ADULT_WORDS) {
    for (const sep of SEPS) {
      for (const order of ['age', 'word']) {
        addCase('pass: adult age', 'pass', EVERY, build({ age, word, sep, order }));
        const adjPick = pick(['', ...ADJS]);
        // "little girl" / "little boy" are prohibited terms of their own.
        const adj = adjPick === word || (adjPick === 'little' && ['girl', 'boy'].includes(word)) ? '' : adjPick;
        const spec = { age, word, sep, order, adj, tail: pick(TAILS), ageWord: pick(AGE_WORDS) };
        addCase('pass: adult age', 'pass', EVERY, build(spec));
      }
    }
  }
}
// Heights.
for (const h of ["5'10", '5’11', "5'1", '5ft10', '5 ft 10', '5-10', "6'0", '5′10', "4'11", '5ft-10']) {
  for (const w of ['sexy', 'naughty', 'horny', 'kinky', 'wet', 'naked']) {
    addCase('pass: height', 'pass', FREE, `${h} and ${w}`);
    addCase('pass: height', 'pass', FREE, `Tall, ${h} and ${w}`);
    addCase('pass: height', 'pass', FREE, `${h.replace(/ /g, '-')}-and-${w}`);
  }
}
// Sizes.
for (const n of ['10', '12', '14', '16']) {
  for (const lead of ['size', 'UK size', 'Size', 'shoe size', 'dress size', 'US size']) {
    for (const w of ['sexy', 'horny', 'naughty', 'wet']) {
      addCase('pass: size', 'pass', FREE, `${lead} ${n} and ${w}`);
      addCase('pass: size', 'pass', FREE, `Proud ${lead.replace(/ /g, '-')}-${n}-and-${w}`);
      addCase('pass: size', 'pass', FREE, `Curvy ${lead} ${n} and ${w} 💋`);
    }
    addCase('pass: size', 'pass', FREE, `${lead} ${n} hot girl`);
  }
}
// Ratings.
for (const r of ['10/10', '10 / 10', '11/10', '12/10', 'ten out of ten', '10 out of 10', 'ten/10']) {
  for (const w of ['sexy', 'naughty', 'horny', 'wet']) {
    addCase('pass: rating', 'pass', FREE, `${r} and ${w}`);
    addCase('pass: rating', 'pass', FREE, `Rated ${r} and ${w}`);
  }
  addCase('pass: rating', 'pass', FREE, `tits ${r}`);
  addCase('pass: rating', 'pass', FREE, `pussy ${r}`);
}
addCase('pass: rating', 'pass', FREE, 'rated 10/10');
addCase('pass: rating', 'pass', FREE, 'tits ten out of ten');
// Price menus.
for (const [a, b] of [['Nudes', 'videos'], ['Used sex toys', 'lingerie'], ['nudes', 'sexting'], ['Porn', 'customs'],
  ['Nudes', 'wet pussy'], ['Boobs', 'tight pussy'], ['sex tapes', 'nudes'], ['xxx clips', 'customs']]) {
  for (const [p, q] of [['15', '25'], ['12', '20'], ['10', '30'], ['16', '40']]) {
    for (const s of [', ', '; ', ' | ', ' / ', ' • ']) addCase('pass: price menu', 'pass', FREE, `${a} ${p}${s}${b} ${q}`);
    addCase('pass: price menu', 'pass', FREE, `${a}: ${p}, ${b}: ${q}`);
    addCase('pass: price menu', 'pass', FREE, `${a} $${p}`);
    addCase('pass: price menu', 'pass', FREE, `${a} ${p}$`);
  }
}
for (const t of ['nudes $16', 'Nudes 15, videos 25', 'Used sex toys 15, lingerie 20', '12 Wet Pussy Selfies', 'porn 13GB',
  'Customs from 15. Nudes 10.', 'Nudes 15, wet pussy 25', 'Custom nudes 15 wet pussy 25', 'Price list: nudes 12, sexting 20']) {
  addCase('pass: price menu', 'pass', FREE, t);
}
// Counts with a plural or content noun.
for (const n of [...DIGIT_AGES, 'twelve', 'fifteen']) {
  for (const w of ['porn scenes', 'hot girls', 'sex toys', 'porn stars', 'horny girls', 'wet pussy pics', 'tight pussy selfies',
    'nudes for $30', 'sex positions', 'hot sluts', 'naked pics', 'porn clips', 'xxx videos', 'wet pussy gifs', 'cum shots',
    'new porn videos', 'girls', 'sluts']) {
    addCase('pass: count', 'pass', FREE, `${n} ${w}`);
    addCase('pass: count', 'pass', FREE, `Top ${n} ${w}`);
  }
}
for (const t of ['12 porn scenes', '10 hot girls', '15 sex toys', 'twelve porn stars', 'Ten porn stars to follow',
  'a perfect ten porn star', "Ocean's Eleven porn parody", 'sixteen porn parodies']) addCase('pass: count', 'pass', FREE, t);
// Episodes, chapters, seasons, volumes, parts, levels, days.
for (const n of DIGIT_AGES) {
  for (const lead of ['ep', 'episode', 'chapter', 'season', 'volume', 'vol', 'part', 'level', 'day', 'week', 'scene', 'set']) {
    for (const w of ['horny', 'dirty', 'naughty', 'porn', 'wet', 'sexy']) {
      addCase('pass: episode', 'pass', FREE, `${lead}-${n}-and-${w}`);
      addCase('pass: episode', 'pass', FREE, `${lead} ${n} and ${w}`);
      addCase('pass: episode', 'pass', FREE, `${lead} ${n} ${w}`);
    }
  }
}
// Years, clock times, dates.
for (const t of ['2016 porn', 'porn 2016', 'horny at 10pm', 'horny at 11 tonight', 'porn 12 Dec', 'sex 12 noon', 'porn 13 Oct',
  'horny at 16:00', 'slut 16:9 video', 'porn 16.5 update', "porn '16", 'Porn #16', 'sex 12pm', 'horny 10 EST', 'porn 10 min',
  'cum 12 times', 'porn 17 TB archive', 'Porn 16 bit', 'live at 10pm and horny', 'New porn 14 Feb']) addCase('pass: time/date', 'pass', FREE, t);
// Names and ordinary words, everywhere.
for (const t of ['kirsteen', 'Kirsteen', 'teena', 'Teena', 'essex', 'Essex', 'wessex', 'sussex', 'Kirsteen Dickson', 'Teena Marie',
  'essex16', 'sweet16', 'sweetsixteen', 'top16', 'win10', 'shoe16', 'Sixteen Pornell', 'Eleven Cumming', 'Wessex Twelve',
  'Essex Ten', 'Ten Dickson', 'oasis16', 'genesis 16', 'thorny 16', 'basis 12', 'Sixteen Candles', 'sweet sixteen party pics',
  'mateen', 'steen', 'justeen']) addCase('pass: names', 'pass', EVERY, t);

// --- RUN -------------------------------------------------------------------
let totalPass = 0;
let totalFail = 0;
const label = (c) => (c === null ? 'free text' : c);
for (const [group, cases] of groups) {
  let ok = 0;
  let bad = 0;
  const shown = [];
  for (const { expect, contexts, text } of cases) {
    for (const context of contexts) {
      const hit = screenPublicText(text, { context });
      const good = expect === 'refuse' ? !!hit : !hit;
      if (good) ok++;
      else {
        bad++;
        if (shown.length < 25) shown.push(`[${label(context)}] expected ${expect}: ${JSON.stringify(text)}${hit ? ` -> ${JSON.stringify(hit.reasons)}` : ''}`);
      }
    }
  }
  totalPass += ok;
  totalFail += bad;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${group}: ${cases.length} strings, ${ok} checks passed, ${bad} failed`);
  for (const s of shown) console.log('    ', s);
  if (bad > shown.length) console.log(`     ... and ${bad - shown.length} more`);
}
console.log(`\n==== ${totalPass} passed, ${totalFail} failed ====`);
process.exit(totalFail ? 1 : 0);
