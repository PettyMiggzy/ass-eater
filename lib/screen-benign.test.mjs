// THE BENIGN GATE for the public-text screens (round 21, mandatory before any
// rule change). lib/screen-generated.test.mjs generates the shapes that MUST be
// refused; this file generates REALISTIC LEGITIMATE creator and fan text that
// MUST PASS both screens (lib/prohibited-terms.js screenPublicText, which also
// runs lib/payment-circumvention-filter.js) in every FREE-text context: a bio,
// a display name, a listing title, a listing description, a DM or a wall post
// (context null). Round 20 shipped rules that refused "Mom of 2 and horny",
// "My daughter just turned 5!", "TG $20 bundle", "Lingerie line: 2xl-5xl",
// "Zero tolerance for child pornography" and "In high school, boys never
// noticed me" -- each one logged an honest user under the most serious
// category there is. From now on no rule change may make any string here
// refuse; a refusal printed here is a false positive in the RULE, never a row
// to delete.
//
// Pure: no database, no mocks. Prints counts per family and exits 1 on ANY
// refusal. Run with:
//   node --no-warnings --import ./test-register.mjs lib/screen-benign.test.mjs

const { screenPublicText } = await import('./prohibited-terms.js');

const FREE = [null, 'bio', 'title', 'description'];

// Deterministic choice, so a failure reproduces exactly.
let seed = 21;
const pick = (list) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return list[seed % list.length];
};

const families = new Map();
const add = (family, text) => {
  if (!families.has(family)) families.set(family, new Set());
  families.get(family).add(text);
};

const ONE_TO_17 = Array.from({ length: 17 }, (_, i) => String(i + 1));
const ONE_TO_9 = ONE_TO_17.slice(0, 9);

// --- 1. Parenting: a COUNT of children, then an adult sexual word ----------
// "Mom of 2 and horny" is the commonest MILF bio there is.
const PARENT_LEADS = ['Mom of', 'mom of', 'mother of', 'Mother of', 'mum of', 'Mum of', 'dad of', 'Dad of', 'Single mom of',
  'single mom of', 'MILF, mom of', 'MILF 💋 Mom of', 'Proud mom of', 'proud mama of', 'Busy mom of', 'Tired mom of',
  'Wife and mom of', 'father of', 'Hot mom of', 'Stay at home mom of'];
const PARENT_TAILS = [' and horny', ' & horny', ' & horny 😈', ' and naked on here', ' and a slut for attention',
  ' and a virgin again lol', ' and naughty', ' and kinky', ' and still sexy', ' kids', ' boys', ' girls', ' 💋',
  ' and wet for you', ' and horny af', ' and slutty', ' n horny', ' and very horny', ' and always horny', ''];
for (const lead of PARENT_LEADS) {
  for (const n of ONE_TO_17) {
    for (const tail of PARENT_TAILS) add('parenting: mom of N', `${lead} ${n}${tail}`);
  }
}

// --- 2. Parenting: a child's age, with a family subject ----------------------
const FAMILY_SUBJECTS = ['My daughter', 'my daughter', 'My son', 'my son', 'My baby', 'my baby boy', 'My baby girl', 'Our daughter',
  'our son', 'My youngest', 'my oldest', 'My kid', 'my niece', 'My nephew', 'my twins', 'My stepson', 'our baby',
  'My grandson', 'my granddaughter', 'My kiddo'];
const FAMILY_VERBS = [' just turned ', ' turned ', ' turns ', ' is ', ' is now ', ' will be ', ' just turned '];
const FAMILY_ENDS = ['!', '.', ' today', ' today!', ', time flies', ' 🎂', ' next week', '', '. So proud', ' and loves this song',
  '!! Where did the time go', ' on Sunday', ', crazy'];
// A bare "baby" as the subject is a small child only with a single digit ("my
// baby is 16" is how someone describes a partner).
const BABY_SUBJECTS = new Set(['My baby', 'our baby']);
for (const subject of FAMILY_SUBJECTS) {
  for (const verb of FAMILY_VERBS) {
    for (const n of BABY_SUBJECTS.has(subject) ? ONE_TO_9 : ONE_TO_17) {
      add('parenting: family subject + age', `${subject}${verb}${n}${pick(FAMILY_ENDS)}`);
      add('parenting: family subject + age', `${pick(['', 'Omg ', 'Sorry late reply, ', 'Can you believe it? ', 'Update: '])}${subject}${verb}${n}${pick(FAMILY_ENDS)}`);
    }
  }
}

// --- 3. Parenting: a pronoun and a small child's age ------------------------
const PRONOUN_LEADS = ['She just turned', 'He just turned', 'she just turned', 'he just turned', "She's", "He's", "she's", "he's",
  'She is', 'He is', 'she turned', 'He turned', 'Just turned', 'just turned', 'She’s', 'He’s', 'She turns', 'he turns'];
const PRONOUN_ENDS = ['!', '.', ' today', ', time flies', ', my baby', ' 🎂', '', ' next month', ' and so cute', ' and teething',
  ' already', '!! 🥹', ' and loves dinosaurs', ', can you believe it', ' now'];
for (const lead of PRONOUN_LEADS) {
  for (const n of ONE_TO_9) {
    for (const end of PRONOUN_ENDS) add('parenting: pronoun + small age', `${lead} ${n}${end}`);
  }
}
for (const n of ONE_TO_9) {
  for (const t of [`my baby boy just turned ${n}!`, `My baby girl turned ${n} today`, `she's ${n}, my baby`, `he's ${n} and so clingy`,
    `Sorry for the late reply, she's ${n} and was up all night`, `Time flies! He just turned ${n}.`, `She just turned ${n} 🎈`]) {
    add('parenting: pronoun + small age', t);
  }
}

// --- 4. Parenting: possessive + age word + child noun -------------------------
const POSSESSIVES = ['my', 'My', 'our', 'Our', 'his', 'her', 'their'];
const AGE_WORDS = [' year old', '-year-old', ' yo', ' y/o', ' yr old', ' year-old'];
const CHILD_NOUNS = ['boy', 'girl', 'son', 'daughter', 'kid', 'twins', 'boys', 'girls', 'toddler', 'baby', 'kiddo', 'little one'];
const CHILD_TAILS = [' is sick', ' is sick today', ' was sick', ' loves this', ' just started school', ' woke me up', ' is napping', '',
  ' 😂', ' says hi', ' has the flu', ' drew this for me', ' is at school', ' is home today', ' just lost a tooth'];
// Bare girl / boy / baby after the age word are a child only with a single
// digit ("my 15 yo girl" is not family talk); the family nouns take 1-17.
const SINGLE_DIGIT_ONLY_NOUNS = new Set(['boy', 'girl', 'boys', 'girls', 'baby']);
for (const n of ONE_TO_17) {
  for (const noun of CHILD_NOUNS) {
    if (Number(n) > 9 && SINGLE_DIGIT_ONLY_NOUNS.has(noun)) continue;
    for (const ageWord of AGE_WORDS) {
      for (const tail of CHILD_TAILS) {
        const lead = pick(['', '', 'Sorry late reply, ', 'Ugh, ', 'Can’t tonight, ', 'Brb, ']);
        add('parenting: possessive + child age', `${lead}${pick(POSSESSIVES)} ${n}${ageWord} ${noun}${tail}`);
      }
    }
  }
}
for (const n of ONE_TO_9) {
  for (const noun of ['boy', 'girl']) {
    for (const t of [`${n} yo ${noun} mom`, `${n} yo ${noun} mum`, `${n} year old ${noun} mom life`, `${n}yo ${noun} mama`]) add('parenting: possessive + child age', t);
  }
}

// --- 5. Sequence numbers: round / night / date / ... N and <adult word> ---
const SEQUENCE_LEADS = ['Round', 'round', 'Night', 'night', 'Date', 'date', 'Hour', 'hour', 'Game', 'game', 'Year', 'year', 'Video',
  'video', 'Part', 'part', 'Day', 'day', 'Week', 'week', 'Take', 'Set', 'Scene', 'Episode', 'Chapter', 'Level', 'Match', 'Month'];
const SEQUENCE_WORDS = ['horny', 'naked', 'a virgin', 'a slut', 'kinky', 'slutty', 'nude', 'still horny', 'so horny'];
for (const lead of SEQUENCE_LEADS) {
  for (const n of ONE_TO_17) {
    for (const w of SEQUENCE_WORDS) {
      add('sequence: <word> N and horny', `${pick(['', 'on ', 'Just finished ', 'Ok ', 'lol '])}${lead} ${n}${pick([' and ', ' & '])}${w}${pick(['', ' again', ' 😈', ' lol', '!'])}`);
    }
  }
}

// --- 6. Trans / TG content ---------------------------------------------------
const TG_CUES = ['$20', 'Only $20', 'pay $15 for', '$10', 'Just $25 for', '$9.99 for'];
const TG_CONNS = ['with my', 'on', 'for my', 'on my', 'w/ my', 'on the'];
const TG_NOUNS = ['girlfriend', 'gf', 'content', 'set', 'bundle', 'model', 'clips', 'girl', 'girls', 'bestie', 'videos', 'porn', 'babe',
  'ts content', 'collab', 'vids', 'sets', 'girlfriends'];
for (const cue of TG_CUES) {
  for (const conn of TG_CONNS) {
    for (const noun of TG_NOUNS) {
      for (const tg of ['TG', 'tg', 'Tg']) add('trans: TG category', `${cue} ${conn} ${tg} ${noun}${pick(['', ' this week only', ', collab set', ' 💕', '!'])}`);
    }
  }
}
for (const p of ['5', '10', '15', '20', '25', '40']) {
  for (const noun of ['bundle', 'set', 'clips', 'vids', 'content', 'sets', 'videos', 'pics']) {
    add('trans: TG category', `TG $${p} ${noun}`);
    add('trans: TG category', `New TG $${p} ${noun} up now`);
    add('trans: TG category', `$${p} TG ${noun}`);
  }
}
for (const t of ['TG content', 'TG girlfriend', '$20 TG bundle', 'Only $20 with my TG girlfriend', '$20 with my tg bestie, collab set',
  '$20 on TG content this week only', 'Proud TG girl 🏳️‍⚧️', 'TG and proud', 'TG model, 24']) add('trans: TG category', t);

// --- 7. Product and size lines -----------------------------------------------
const LINE_LEADS = ['New lingerie', 'Plus size', 'My swim', 'Spring', 'Summer', 'My lingerie', 'Curvy', 'Fall', 'Holiday', 'New swim',
  'Our bikini', 'Sock'];
const LINE_SEPS = [':', ' -', ' —', ':  '];
const LINE_UNITS = ['xl', 'xxl', 'XL', 'XXL', 'pack', 'packs', 'piece', 'pieces', 'pc', 'xxxl', 'xl-5xl', 'X', 'Pack'];
const LINE_TAILS = ['', ' available', ' sets', ' in stock', ' only', ' now live', ' bundles', ' 💕'];
for (const lead of LINE_LEADS) {
  for (const sep of LINE_SEPS) {
    for (const n of ['1', '2', '3', '4', '5']) {
      for (const unit of LINE_UNITS) add('products: <lead> line: <n><unit>', `${lead} line${sep} ${n}${unit}${pick(LINE_TAILS)}`);
    }
  }
}
for (const t of ['New lingerie line: 2xl-5xl available', 'Plus size line: 3xl', 'My lingerie line - 4xl included', 'My swim line: 2piece sets',
  'Spring line: 3pack bundles', 'Spring line: 2pack', 'bottom line: 4ever yours', 'signal: 2bars lol', 'Bottom line: 2way street',
  'Sock line: 3pk', 'Swim line - 2pc sets', 'Main line: 5star reviews']) add('products: <lead> line: <n><unit>', t);

// --- 8. Anti-CSAM and safety disclaimers ------------------------------------
// Round 21 fix-up: a bare "Stop" / "End" / "Report" / "Ban" in front of a
// child pair is NOT a disclaimer any more ("Stop, child porn for sale" and
// "End. child porn vids $20" opened ordinary sales text) -- only with an
// object ("Stop all", "Report all", "We report", "We ban"). See the refuse
// rows in screen-generated.test.mjs.
const DISCLAIMER_LEADS = ['Zero tolerance for', 'zero tolerance for', 'We have zero tolerance for', 'We report', 'We report all', 'Report all',
  'report all', 'Anti', 'anti', 'Fight against', 'fighting against', 'I support the fight against', 'No', 'Never any', 'Strictly no',
  'Absolutely no', 'We ban', 'We fight', 'Stop all', 'End all'];
const DISCLAIMER_CHILD = ['child', 'kiddie', 'kid', 'children', 'kids'];
const DISCLAIMER_TAILS = ['', '.', ' to NCMEC', ', 18+ only', ' - reported instantly', '. All models 18+', ' accounts to NCMEC', '!'];
for (const lead of DISCLAIMER_LEADS) {
  for (const child of DISCLAIMER_CHILD) {
    for (const w of ['porn', 'pornography']) {
      for (const tail of DISCLAIMER_TAILS) {
        if (['We fight', 'Stop all', 'End all', 'We ban'].includes(lead) && tail === ' to NCMEC') continue;
        add('safety: anti-CSAM disclaimer', `${pick(['', '18+ only. ', 'All content 18+. '])}${lead} ${child} ${w}${tail}`);
      }
    }
  }
}
for (const t of ['Zero tolerance for child pornography', 'All content 18+. We have zero tolerance for child pornography.',
  'Report child pornography to NCMEC', 'I support the fight against child pornography', 'Survivor. Anti child pornography activist',
  'I report kiddie porn accounts to NCMEC', 'Never any kid porn here, reported instantly', 'No kid naked pics ever, 18+ only',
  'fighting child sex slavery', 'Stop child sex tourism', 'child sex rings are real', 'we report child sexual abuse material',
  'Zero tolerance for child sexual abuse material', 'no minors', 'No minors', 'all models 18+', 'All models are 18+',
  'no minors allowed, all models 18+ and verified', 'No one under 18', "if you're under 18, leave", 'minors (under 18) not allowed',
  'Under 18? Leave now.', 'under 18s not welcome', 'No one under 18 allowed. All models 21+', 'We report underage accounts to NCMEC',
  '18+ only, no underage', 'Fighting child sex trafficking', 'Survivor of child sex abuse', 'End child sex trade now',
  'Anti child sex work exploitation advocate']) add('safety: anti-CSAM disclaimer', t);

// --- 9. School reminiscing across punctuation -------------------------------
const SCHOOL_INTROS = ['In', 'Graduated', 'Finished', 'Dropped out of', 'Back in', 'After', 'Hated', 'Loved', 'Nerd in', 'Shy in',
  'I dropped out of', 'Way back in', 'Skipped'];
const SCHOOLS = ['high school', 'middle school', 'highschool', 'junior high', 'High School'];
const SCHOOL_SEPS = [', ', '. ', ' - ', '; ', ': ', '\n', '! ', '... ', ' — ', ' – '];
const SCHOOL_WORDS = ['boys', 'girls', 'Porn', 'Horny', 'Girls', 'Boys', 'guys', 'sex', 'Sex', 'porn', 'Naked', 'nobody'];
const SCHOOL_TAILS = [' never noticed me', ' trip to Cancun!', ' paid better', ' for older men now', ' night out tonight', '',
  ' is my job now', ' came later lol'];
for (const intro of SCHOOL_INTROS) {
  for (const school of SCHOOLS) {
    for (const sep of SCHOOL_SEPS) {
      for (const w of SCHOOL_WORDS) add('school: reminiscing across punctuation', `${intro} ${school}${sep}${w}${pick(SCHOOL_TAILS)}`);
    }
  }
}
for (const t of ['In high school, boys never noticed me', 'Graduated high school - girls trip to Cancun!', 'high school. Girls night out tonight',
  'Finished high school; boys chased me since', 'I dropped out of high school: porn paid better', 'my high school bf',
  'Nerd in high school, boys never noticed me. Now look 😉', 'married my high school sweetheart', 'my old high school gf',
  'Year 9 teacher by day', 'year 10 maths was hell', 'Year 11 exams all over again', 'I teach year 7 and year 8',
  'My high school sex ed teacher was clueless']) add('school: reminiscing across punctuation', t);

// --- 10. Sugar dating ------------------------------------------------------------
for (const sep of [' ', '_', '-']) {
  for (const b of ['baby', 'babies', 'Baby']) {
    for (const sep2 of [' ', '_', '-']) {
      for (const w of ['porn', 'porno', 'content', 'life']) add('sugar dating', `sugar${sep}${b}${sep2}${w}`);
      add('sugar dating', `Your favorite sugar${sep}${b}${sep2}porn ${pick(['creator', 'star', 'queen'])}`);
    }
  }
}

// --- 11. Heights, sizes, ratings, menus, episodes, dates, prices ------------
for (const h of ["5'10", '5’11', "5'1", '5ft10', '5 ft 10', '5-10', "6'0", '5′10', "4'11", "5'4"]) {
  for (const w of ['sexy', 'naughty', 'horny', 'kinky', 'wet', 'naked', 'curvy', 'thick']) {
    add('numbers: height', `${h} and ${w}`);
    add('numbers: height', `Tall, ${h} and ${w}`);
    add('numbers: height', `${pick(['Hi! ', 'MILF ', '', 'Ginger '])}${h} of pure ${w} fun`);
  }
}
for (const n of ['2', '4', '6', '8', '10', '12', '14', '16']) {
  for (const lead of ['size', 'UK size', 'Size', 'shoe size', 'dress size', 'US size']) {
    for (const w of ['sexy', 'horny', 'naughty', 'wet', 'curvy']) {
      add('numbers: size', `${lead} ${n} and ${w}`);
      add('numbers: size', `Curvy ${lead} ${n} and ${w} 💋`);
    }
  }
}
for (const r of ['10/10', '10 / 10', '11/10', '12/10', 'ten out of ten', '10 out of 10', '5/5', '9/10', '8/10']) {
  for (const w of ['sexy', 'naughty', 'horny', 'wet']) {
    add('numbers: rating', `${r} and ${w}`);
    add('numbers: rating', `Rated ${r} and ${w}`);
  }
}
for (const [a, b] of [['Nudes', 'videos'], ['Used sex toys', 'lingerie'], ['nudes', 'sexting'], ['Porn', 'customs'], ['Nudes', 'wet pussy'],
  ['Boobs', 'tight pussy'], ['Sexting', 'Dick rates'], ['Customs', 'GFE']]) {
  for (const [p, q] of [['15', '25'], ['12', '20'], ['10', '30'], ['16', '40'], ['5', '9'], ['13', '17']]) {
    for (const s of [', ', '; ', ' | ', ' / ', ' • ', ' 💦 ', ' & ', '\n']) add('numbers: price menu', `${a} ${p}${s}${b} ${q}`);
    add('numbers: price menu', `${a}: $${p}, ${b}: $${q}`);
  }
}
for (const n of ['1', '2', '3', '5', '8', '10', '12', '15', '16', '17']) {
  for (const lead of ['ep', 'episode', 'chapter', 'season', 'volume', 'vol', 'part', 'level', 'day', 'week', 'scene', 'set']) {
    for (const w of ['horny', 'dirty', 'naughty', 'porn', 'wet', 'sexy']) add('numbers: episode', `${lead} ${n} ${w}`);
  }
}
for (const t of ['2016 porn', 'porn 2016', 'horny at 10pm', 'horny at 11 tonight', 'porn 12 Dec', 'sex 12 noon', 'horny at 16:00',
  'slut 16:9 video', 'Porn #16', 'sex 12pm', 'horny 10 EST', 'porn 10 min', 'cum 12 times', 'live at 10pm and horny', 'New porn 14 Feb',
  'Open 9 to 5', '24/7 and horny', 'New set on the 3rd', 'Drops 2/14', 'Back on 5/12', 'Custom videos from $20', 'Nudes $15 each',
  '3 pics for $10', '2 for 1 this weekend', '10% off bundles', 'Sale ends 11/30']) add('numbers: dates and prices', t);

// --- 12. Everyday chat -----------------------------------------------------------
const GREETINGS = ['Hey babe,', 'Hi love!', 'Good morning 😘', 'Heyyy', 'Omg', 'Thank you so much!', 'Hiii', 'Aww', 'Lol', 'Hey there,',
  'Morning sunshine ☀️', 'Hey you', ''];
const BODIES = ['thanks for the tip!', 'new set dropping at 9pm', "what's your favorite color?", 'just got back from the gym',
  'happy Friday everyone', "I'm 24 and horny", "I'm 5'4 and curvy", 'order 16 is shipped', 'size 8 dress arrived', '10 new pics today',
  'top 3 fans get a shoutout', 'live at 8pm EST', 'love you guys, xoxo', "I'll be online around 10", 'my cat knocked over my coffee',
  'the new lingerie set is up', 'did you see my new video?', 'I read your message, replying soon', 'raining again here',
  "can't wait for the weekend", 'my 2 dogs say hi', 'my 3 year old laptop finally died', 'mom of 3 and still going strong',
  'back from vacation', 'studying for my finals', 'just turned 30 and loving it', "I'm 21 and new here", 'booked a shoot for Tuesday',
  'what should my next set be?', 'thanks for subscribing 💕', 'my bf says hi lol', 'happy birthday to my son, he turned 7!',
  'my daughter just turned 15, feeling old', 'round 2 tonight?', 'night 3 of my trip', 'day 12 of my challenge'];
const SIGNOFFS = ['', ' 💋', ' xx', ' 😘', ' lol', '!', ' ❤️', ' haha', ' xoxo'];
for (const g of GREETINGS) {
  for (const b of BODIES) {
    for (const s of SIGNOFFS) add('everyday chat', `${g}${g ? ' ' : ''}${b}${s}`);
  }
}

// --- RUN --------------------------------------------------------------------------
let totalStrings = 0;
let totalChecks = 0;
let totalFail = 0;
for (const [family, set] of families) {
  let bad = 0;
  const shown = [];
  for (const text of set) {
    for (const context of FREE) {
      totalChecks++;
      const hit = screenPublicText(text, { context });
      if (hit) {
        bad++;
        if (shown.length < 25) shown.push(`[${context ?? 'free text'}] ${JSON.stringify(text)} -> ${JSON.stringify(hit.reasons)}`);
      }
    }
  }
  totalStrings += set.size;
  totalFail += bad;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${family}: ${set.size} strings, ${bad} refusals`);
  for (const s of shown) console.log('    ', s);
  if (bad > shown.length) console.log(`     ... and ${bad - shown.length} more`);
}
console.log(`\n==== ${totalStrings} benign strings, ${totalChecks} checks, ${totalFail} refused ====`);
if (totalStrings < 30000) {
  console.log('the benign corpus must hold at least 30,000 strings');
  process.exit(1);
}
process.exit(totalFail ? 1 : 0);
