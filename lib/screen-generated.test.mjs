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

// --- ROUND 20 --------------------------------------------------------------
// Every round-20 rule and every round-20 false positive, as a FAMILY.

// accounts#2: ages under ten. A digit 1-9 or one..nine WITH an explicit age
// word, beside a person or sexual word, either order; a self-description; "N
// and horny". Refused in every context.
const SINGLE_AGES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const SINGLE_AGE_WORDS = AGE_WORDS.filter(Boolean);
for (const age of SINGLE_AGES) {
  for (const ageWord of SINGLE_AGE_WORDS) {
    for (const word of ['girl', 'boy', 'slut', 'porn', 'pussy', 'nudes']) {
      for (const sep of [' ', '_', '-', '.']) {
        addCase('refuse: single-digit age', 'refuse', EVERY, build({ age, word, sep, order: 'age', ageWord }));
        addCase('refuse: single-digit age', 'refuse', EVERY, build({ age, word, sep, order: 'word', ageWord }));
      }
      addCase('refuse: single-digit age', 'refuse', EVERY, build({ age, word, sep: ' ', order: 'age', ageWord, tail: pick(TAILS) }));
    }
  }
  for (const lead of ["i'm", 'im', 'I am', "she's", 'aged']) {
    addCase('refuse: single-digit age', 'refuse', EVERY, `${lead} ${age}`);
    addCase('refuse: single-digit age', 'refuse', EVERY, `${lead} ${age} years old.`);
    addCase('refuse: single-digit age', 'refuse', EVERY, `${lead} ${age} and horny`);
  }
}
for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
  for (const w of ['horny', 'naked', 'a virgin', 'a slut']) {
    for (const j of [' and ', ' & ', ' n ']) addCase('refuse: single-digit age', 'refuse', EVERY, `${n}${j}${w}`);
  }
  addCase('refuse: single-digit age (labels)', 'refuse', NAME_LIKE, `${n}yo`);
  addCase('refuse: single-digit age (labels)', 'refuse', NAME_LIKE, `jess${n}yo`);
  addCase('refuse: single-digit age (labels)', 'refuse', NAME_LIKE, `${n}yogirl`);
}
// Round 20 fix-up: the sexual ADJECTIVES the two-digit rules refuse ("sexy 16
// year old", "16 yo wet") -- the single-digit rule used to take only the
// nouns, so "sexy 9 year old" published in every field, tags included. Both
// orders, every age word, every context. (dirty / thirsty / needy are left
// out on purpose -- see SINGLE_AGE_EXCLUDED_ADJ; their pass rows are below.)
const SINGLE_ADJS = ['horny', 'slutty', 'kinky', 'naughty', 'nude', 'naked', 'wet', 'freaky', 'sexy', 'tight'];
for (const age of SINGLE_AGES) {
  for (const adj of SINGLE_ADJS) {
    for (const ageWord of [' yo', 'yo', ' y.o.', ' years old', ' yrs old', '-year-old']) {
      addCase('refuse: single-digit age + adjective', 'refuse', EVERY, `${adj} ${age}${ageWord}`);
      addCase('refuse: single-digit age + adjective', 'refuse', EVERY, `${age}${ageWord} ${adj}`);
    }
    addCase('refuse: single-digit age + adjective', 'refuse', EVERY, `${adj} ${age} year old ${pick(['here', 'dm me', 'lol', 'xx'])}`);
  }
}
for (const n of ['1', '2', '3', '5', '7', '9']) {
  for (const adj of SINGLE_ADJS) {
    addCase('refuse: single-digit age + adjective (labels)', 'refuse', NAME_LIKE, `${adj}${n}yo`);
    addCase('refuse: single-digit age + adjective (labels)', 'refuse', NAME_LIKE, `${n}yo${adj}`);
  }
}
// ...never the age of a thing, and never a parent's "naughty" / "dirty".
for (const n of ['2', '3', '5', '7', 'five']) {
  // (horny / nude / naked are refused beside ANY single-digit age with an age
  // word, like the two-digit rule's "my horny 16 year old car": not asserted.)
  for (const adj of SINGLE_ADJS.filter((a) => !['horny', 'nude', 'naked'].includes(a))) {
    addCase('pass: single-digit age + adjective', 'pass', FREE, `my ${adj} ${n} year old car`);
    addCase('pass: single-digit age + adjective', 'pass', FREE, `our ${n} year old ${adj} dog`);
  }
  for (const t of [`my naughty ${n} year old son`, `my naughty ${n} year old daughter`, `my dirty ${n} year old after the park`,
    `a needy ${n} year old`, `thirsty ${n} year old`, `dirty ${n} year old`]) {
    addCase('pass: single-digit age + adjective', 'pass', FREE, t);
  }
}

// Round 20 fix-up: the single-digit LABEL ("Mia, 9, slut", "Mia | 9 | slut")
// in tags and names -- the two-digit label is refused everywhere; for one
// digit, free text keeps its lists and counts ("Size 9, sexy fit").
for (const n of ['1', '3', '5', '7', '9']) {
  for (const w of ['slut', 'horny', 'girl', 'sexy', 'porn']) {
    for (const sep of [', ', ' | ', ' • ', ' ♡ ', ' / ']) {
      addCase('refuse: single-digit label (strict)', 'refuse', NAME_LIKE, `Mia${sep}${n}${sep}${w}`);
      addCase('refuse: single-digit label (strict)', 'refuse', NAME_LIKE, `${n}${sep}${w}`);
    }
  }
  for (const t of [`Size ${n}, sexy fit`, `Top ${n}, sexy picks`, `Set ${n}, horny edition`]) addCase('pass: single-digit label', 'pass', FREE, t);
}

// ...while a single digit that is a count, a duration, a price, a time or the
// age of a THING passes, and so does a parent's "daughter"/"son".
for (const n of ['1', '2', '3', '5', '7', '9', 'two', 'five', 'nine']) {
  for (const t of [`${n} to 5`, `my ${n} year old car`, `${n} years of experience`, `${n} year old business`, `a ${n} year old laptop`,
    `my ${n} year old daughter`, `my ${n} year old son loves this`, `our ${n} year old dog`, `${n} years in the industry`,
    `open ${n} days a week`, `I'm ${n} minutes away`, `${n} pics for $20`, `${n} years old today, my account`]) {
    addCase('pass: single digit', 'pass', FREE, t);
  }
}
for (const t of ["I'm 1 year old on here", '24/7 and horny', "5'2 and horny", "I'm 6'2", '9 to 5 job, horny after', 'Nudes 5 each']) {
  addCase('pass: single digit', 'pass', FREE, t);
}

// accounts#3: a child word + a porn / sex / nude word. Every context, glued
// too (except "sex" / "xxx", word tier only).
const CHILD_LEADS = ['child', 'children', 'kid', 'kids', 'kiddie', 'kiddy', 'toddler', 'toddlers', 'infant', 'infants'];
// "xxx" is not paired with kid / kids: folded to "xx" it is also a sign-off
// ("night night kids xx").
for (const lead of CHILD_LEADS) {
  for (const w of ['porn', 'porno', 'pornography', 'sex', 'nudes', 'nude', 'naked', ...(lead.startsWith('kid') && !lead.startsWith('kidd') ? [] : ['xxx'])]) {
    for (const sep of [' ', '_', '-', '.', '  ']) addCase('refuse: child pair', 'refuse', EVERY, `${lead}${sep}${w}`);
    if (w !== 'sex' && w !== 'xxx') addCase('refuse: child pair', 'refuse', EVERY, `hot${lead}${w}`);
    addCase('refuse: child pair', 'refuse', EVERY, `new ${lead} ${w} ${pick(['here', 'dm me', 'lol', 'set'])}`);
  }
}
for (const lead of ['baby', 'babies']) for (const w of ['porn', 'porno', 'pornography']) addCase('refuse: child pair', 'refuse', EVERY, `${lead} ${w}`);
for (const lead of ['minor', 'minors']) for (const w of ['porn', 'porno', 'pornography', 'nudes', 'nude', 'naked']) addCase('refuse: child pair', 'refuse', EVERY, `${lead} ${w}`);
for (const t of ['babysitter', 'kid friendly', 'Minor edits', 'baby oil', 'baby blue lingerie', 'kids menu', 'child care', 'no kids on set',
  'minor sex scene edits', 'child sex abuse survivor', 'kids sex ed curriculum', 'hey baby, porn star here', 'minor porn star',
  'no kids, sex positive', 'baby porn star', 'my kid, naked truth podcast', 'Sweet baby, nudes dropping tonight', 'night night kids xxx',
  'love you kid xx']) {
  addCase('pass: child pair', 'pass', FREE, t);
}

// Round 20 fix-up: the join between a child word and a content word is
// spaces on one line or ONE glued "_" "." "-" -- never punctuation plus a
// space or a line break, which is a sentence boundary ("Mom of 3 kids. Nudes
// 20", "No kids - porn only", "Mom of 2 kids" + newline + "Nudes 20").
// ("child" + "porn" is the original term with its wider join, not this rule.)
for (const lead of ['kid', 'kids', 'child', 'children', 'toddler', 'toddlers']) {
  for (const w of ['Nudes', 'Porn', 'Sex', 'Naked', 'Pornography'].filter((x) => !(lead === 'child' && x === 'Porn'))) {
    for (const sep of ['. ', '! ', '? ', ' - ', ' — ', '\n', ' -\n', '.\n']) {
      addCase('pass: child word, sentence break', 'pass', FREE, `Busy with the ${lead}${sep}${w} drop friday`);
      addCase('pass: child word, sentence break', 'pass', FREE, `No ${lead}${sep}${w.toLowerCase()} only | 20`);
    }
  }
}
// Round 20 fix-up: in a tag or a name, "kid"/"kids" + "xxx" and "baby"/"babies"
// + "nudes"/"naked" are refused too (a label has no sign-off or endearment
// reading); free text keeps its "night night kids xxx" and "baby, nudes up".
for (const t of ['kid xxx', 'kids xxx', 'kid_xxx', 'kids-xxx', 'kid.xxx', 'kidxxx', 'baby nudes', 'babies nudes', 'baby_naked',
  'babies-nudes', 'babynudes', 'babynaked', 'baby nude']) {
  addCase('refuse: child pair (strict)', 'refuse', NAME_LIKE, t);
}
for (const t of ['night night kids xxx', 'love you kid xxx', 'hey baby nudes are up', 'baby nudes 20 tonight']) addCase('pass: child pair (strict only)', 'pass', FREE, t);

// accounts#0: price menus DECORATED with emoji, "&", "!!", a parenthetical or
// a newline pass in free text; an age with a price tacked on still refuses.
const MENU_ITEMS = [['Nudes', 'videos'], ['Sexting', 'Nudes'], ['Nudes', 'Dick rates'], ['Customs', 'GFE'], ['Pussy pics', 'videos'],
  ['nudes', 'sexting']];
const MENU_SEPS = [' 💦, ', ' 💬 ', ' ✨ ', ' & ', '!! ', '\n', ' 🔥 | ', ' (5 pics) | ', ' and '];
for (const [a, b] of MENU_ITEMS) {
  for (const p of ['10', '12', '13', '15', '16', '17']) {
    for (const sep of MENU_SEPS) {
      addCase('pass: decorated price menu', 'pass', FREE, `${a} ${p}${sep}${b} 25`);
      addCase('pass: decorated price menu', 'pass', FREE, `💦 ${a} ${p}${sep}${b} 25 🎥`);
    }
  }
}
for (const t of ['Nudes 15 💦, videos 25 🎥', 'Sexting 15 💬 Nudes 12 📸 Videos 20 🎥', '💦 nudes 15 💦 videos 25 💦',
  'Nudes 15 ✨ Videos 25 ✨ Customs 40', 'Nudes 12 & videos 20', 'Nudes 15!! Videos 25!!', 'Nudes 15 (5 pics) | Videos 25',
  'Nudes 15\nDick rates 20\nGFE 30', 'nudes 15 and dick rates 10']) addCase('pass: decorated price menu', 'pass', FREE, t);
for (const lead of ['Mia', 'Emma', 'jess']) {
  for (const age of ['16', '15', '13']) {
    for (const sep of [' 💦 ', ' & ', ' and ', ' ✨ ']) {
      for (const phrase of ['wet pussy', 'horny', 'tight pussy']) addCase('refuse: decorated age + price', 'refuse', EVERY, `${lead} ${age}${sep}${phrase} 25`);
    }
  }
}

// accounts#1 / #9: school pairs. In free text a reminiscing possessive in
// front of bf / gf / cheerleader / babe / sis passes, and "sex ed" is never a
// pair; everything else -- and every tag and name -- refuses.
for (const lead of ['my', 'our', 'former', 'ex', 'married my', 'with my', 'dating my', 'still with my', 'my former']) {
  for (const school of ['high school', 'middle school', 'junior high']) {
    for (const w of ['bf', 'gf', 'cheerleader', 'babe', 'sis']) {
      addCase('pass: reminiscing school pair', 'pass', FREE, `${lead} ${school} ${w}`);
      addCase('pass: reminiscing school pair', 'pass', FREE, `${lead[0].toUpperCase()}${lead.slice(1)} ${school} ${w}, now 30`);
      addCase('refuse: school pair in a label', 'refuse', NAME_LIKE, `${lead} ${school} ${w}`);
    }
  }
}
for (const t of ['my high school sex ed teacher', 'Our high school babe reunion', 'Former high school cheerleader, now 30',
  'high schooler', 'middle schooler', 'my 9th grade teacher', 'I teach 8th graders', '9th grade girls basketball',
  'my 9th grade sex ed class', 'I was a high schooler in 2009']) addCase('pass: school words in free text', 'pass', FREE, t);
for (const school of ['high school', 'highschool', 'middle school', 'junior high', 'jr high', 'high schooler', 'middle schooler', 'high schoolers']) {
  for (const w of ['girl', 'slut', 'nudes', 'horny', 'pussy', 'porn', 'boy', 'virgin', 'whore']) {
    addCase('refuse: school pair', 'refuse', EVERY, `${school} ${w}`);
    addCase('refuse: school pair', 'refuse', EVERY, `my ${school} ${w}`);
    addCase('refuse: school pair', 'refuse', EVERY, `${school} ${w} ${pick(['💦', 'dm me', 'lol', 'here'])}`);
  }
  for (const w of ['bf', 'gf', 'cheerleader', 'babe', 'sis']) {
    addCase('refuse: school pair', 'refuse', EVERY, `${school} ${w}`);
    addCase('refuse: school pair', 'refuse', EVERY, `your ${school} ${w}`);
  }
}
for (const g of ['6th', '7th', '8th', '9th', '10th', '11th', '12th']) {
  for (const noun of ['grade', 'grader']) {
    for (const w of ['girl', 'boy', 'slut', 'nudes', 'porn', 'pussy', 'horny', 'babe']) {
      addCase('refuse: grade pair', 'refuse', EVERY, `${g} ${noun} ${w}`);
      addCase('refuse: grade pair', 'refuse', EVERY, `${w} ${g} ${noun}`);
      addCase('refuse: grade pair', 'refuse', NAME_LIKE, `${g}${noun}${w}`);
    }
    addCase('refuse: grade pair', 'refuse', EVERY, `${g} ${noun} hot girl`);
  }
  addCase('refuse: bare grader (labels)', 'refuse', NAME_LIKE, `${g} grader`);
  addCase('refuse: bare grader (labels)', 'refuse', NAME_LIKE, `${g}grader`);
}
for (const g of ['6', '7', '8', '9', '10', '11', '12']) for (const w of ['girl', 'slut', 'nudes']) addCase('refuse: grade pair', 'refuse', EVERY, `grade ${g} ${w}`);
for (const s2 of ['high schooler', 'middle schooler', 'highschooler']) addCase('refuse: bare grader (labels)', 'refuse', NAME_LIKE, s2);

// accounts#4: bio separators behave like a comma around an age.
const BIO_SEPS = [' | ', ' • ', ' · ', ' / ', ' - ', ' ♡ ', ' ~ ', ' * ', '|', '•', ' ♥ '];
for (const sep of BIO_SEPS) {
  for (const age of ['13', '14', '15', '16', '17']) {
    for (const word of ['horny', 'slut', 'girl', 'nudes']) {
      addCase('refuse: bio separators', 'refuse', EVERY, `Jess${sep}${age}${sep}${word}`);
      addCase('refuse: bio separators', 'refuse', EVERY, `Mia${sep}${age}${sep}${word}${sep}dm me`);
    }
    for (const word of ['horny', 'slut', 'girl']) {
      addCase('refuse: bio separators', 'refuse', EVERY, `${word}${sep}${age}`);
      addCase('refuse: bio separators', 'refuse', EVERY, `${age}${sep}${word}`);
    }
  }
  for (const t of [`Jess${sep}24${sep}horny`, `Jess${sep}19${sep}slut`, `Pics 1${sep}16${sep}ready`, `Nudes 15${sep}Videos 25`,
    `Mia${sep}21${sep}girl next door`]) addCase('pass: bio separators', 'pass', FREE, t);
}
for (const t of ['Pics 1 - 16 | ready', 'sizes 10|12|14', 'Rated 10/10 | sexy', "5'10 | sexy", 'shot at f/16 | horny']) {
  addCase('pass: bio separators', 'pass', FREE, t);
}

// accounts#8: keycap emoji digits are digits.
const keycap = (n) => [...n].map((d) => `${d}️⃣`).join('');
for (const age of ['10', '13', '15', '16', '17']) {
  for (const t of [`${keycap(age)} girl`, `${keycap(age)} yo`, `${keycap(age)} and horny`, `im ${keycap(age)}`, `${keycap(age)} slut`,
    `slut ${keycap(age)}`, `${keycap(age)} yo 💦`]) addCase('refuse: keycap digits', 'refuse', EVERY, t);
}
for (const t of [`${keycap('18')}+ only`, `${keycap('21')} yo`, `${keycap('25')} and horny`, `Top ${keycap('10')} sets`]) {
  addCase('pass: keycap digits', 'pass', FREE, t);
}

// accounts#10: "years older / younger" is not "years old".
for (const age of DIGIT_AGES) {
  for (const w of ['bf', 'gf', 'sis', 'babe', 'wife', 'bro']) {
    addCase('pass: years older', 'pass', FREE, `my ${w} ${age} years older lol`);
    addCase('pass: years older', 'pass', FREE, `my ${w} is ${age} years older than me`);
    addCase('pass: years older', 'pass', FREE, `${w} ${age} years younger`);
  }
}

// accounts#11: a device / software model number is not an age (free text).
for (const product of ['iPhone', 'Windows', 'Galaxy S', 'Galaxy', 'Pixel', 'iPad', 'Xbox', 'Android', 'MacBook']) {
  for (const n of ['10', '11', '12', '13', '14', '15', '16', '17']) {
    for (const w of ['nudes', 'girl', 'porn', 'selfies', 'slut']) addCase('pass: product model', 'pass', FREE, `${product} ${n} ${w}`);
  }
}
// ...but never the words a person uses of themselves.
for (const lead of ['model', 'cam model', 'gen']) for (const age of ['15', '16']) addCase('refuse: rank-looking lead', 'refuse', EVERY, `${lead} ${age} slut`);

// accounts#5-#7: the ordinary-word contact rails (payment filter).
const RAILS = ['tg', 'sc', 'signal', 'line', 'tele'];
for (const rail of RAILS) {
  for (const handle of ['69kitty', '23jess', '420babe', '1jess', '99jess', '007bond', 'jess_99']) {
    addCase('refuse: rail + digit-led handle', 'refuse', FREE, `${rail}: ${handle}`);
    addCase('refuse: rail + digit-led handle', 'refuse', FREE, `${rail} 👉 ${handle}`);
    addCase('refuse: rail + digit-led handle', 'refuse', FREE, `${rail} me ${handle}`);
  }
  for (const ptr of [' 👉 ', ' -> ', ' => ', ' ➡️ ', ' ⬇️ ', ' >> ', ' 👇 ', '👉']) {
    for (const h of ['@jessrose', '@jess_doe', '@ jessxo']) addCase('refuse: rail + pointer + @handle', 'refuse', FREE, `${rail}${ptr}${h}`);
  }
  for (const unit of ['85mm', '50pcs', '2025', '100', '4k', '12pm', '3pk']) addCase('pass: rail + number', 'pass', FREE, `${rail}: ${unit}`);
}
for (const rail of ['tg', 'sc', 'signal', 'tele']) {
  for (const cue of ['pay me on', '$20 on', 'pay 20 on', 'send 20 via', 'pay $20 via', 'cheaper on my', 'payment via my']) {
    addCase('refuse: payment instruction + rail', 'refuse', FREE, `${cue} ${rail}`);
    addCase('refuse: payment instruction + rail', 'refuse', FREE, `customs? ${cue} ${rail.toUpperCase()}`);
  }
  addCase('refuse: payment instruction + rail', 'refuse', FREE, `${rail} for cheaper`);
  addCase('refuse: payment instruction + rail', 'refuse', FREE, `${rail} payments`);
}
for (const t of ['Charleston SC, pay per view here', 'got a signal boost, $20 set on here', 'gas is cheaper in SC', 'paid my SC taxes',
  'Myrtle Beach SC $20 parking', 'tickets $20 at the SC state fair', 'pay attention to the signal', 'New lingerie line with @jess_rose',
  'Charleston, SC | collab w/ @mia', 'drop me a line', 'bottom line: $20 for all', 'moving to SC, cheaper rent',
  'signal boost for @jess_rose', 'tele: 85mm f/1.8', 'Spring line: 2025']) addCase('pass: rail prose', 'pass', FREE, t);

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
