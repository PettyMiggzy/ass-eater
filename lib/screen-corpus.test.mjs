// THE regression net for the public-text screens (lib/prohibited-terms.js
// screenPublicText and lib/payment-circumvention-filter.js
// detectPaymentCircumvention). Pure: no database, no mocks.
//
// ONE table. Every row is { text, contexts, expect: 'refuse' | 'pass' } and
// optionally `pay: true` (the row is a payment-filter case, so it is also run
// through detectPaymentCircumvention on its own) and `kind` (the kind a
// refusal must carry). Every row runs through screenPublicText for EVERY
// context it lists. The minor-age rules regressed three rounds running because
// each fix was tested only in the one context it was written for ("sixteenslut"
// refused as a handle, published as a tag) -- so a row that must be refused
// everywhere lists every context, and a real name that must pass lists every
// context it is valid in.
//
// Seeded from every must-flag / must-pass string of lib/r11b..r14b.test.mjs
// and the round-15 accounts#0-#2 findings. ADD TO IT, never trim it: when a
// filter edit breaks a row, the edit is wrong or the row's expectation is --
// decide which in the open, in the diff.
//
// Run with:
//   node --no-warnings --import ./test-register.mjs lib/screen-corpus.test.mjs

const { screenPublicText } = await import('./prohibited-terms.js');
const { detectPaymentCircumvention } = await import('./payment-circumvention-filter.js');

// Name-mode contexts (judged word by word) and full-mode contexts (tags,
// display name, bio, location, price, listing copy, the website, free text).
const NAME = ['handle', 'username', 'social_instagram', 'social_twitter'];
const FULL = [null, 'tag', 'name', 'bio', 'location', 'price', 'title', 'description', 'social_website'];
const ALL = [...NAME, ...FULL];
// Round 16 (accounts#0-#3): the minor-age rule is STRICT for name-like fields
// and each individual tag, and narrower for FREE text (display name, bio,
// location, price, listing copy, DMs, wall posts, the website).
const STRICT = [...NAME, 'tag'];
const FREE_TEXT = FULL.filter((c) => c !== 'tag');

const rows = [];
const add = (expect, contexts, texts, extra = {}) => {
  for (const text of texts) rows.push({ text, contexts, expect, ...extra });
};

// ---------------------------------------------------------------------------
// Minor age + sexual word: refused in EVERY context (round-15 accounts#0).
add('refuse', ALL, [
  // round-15 accounts#0, every string named in the finding
  'sixteenslut', 'Sixteen Slut', 'fifteenporn', 'fourteenpussy', '16slut', '16 slut', 'horny sixteen slut here',
  'slutsixteen', 'pornfifteen', 'cumseventeen', 'Twelve Porn', 'Sixteen Slut set',
  // both orders, glued or with 0-2 separators, spelled and digits
  'sixteen slut', 'sixteen_slut', 'Sixteen-Slut', 'sixteen, slut', 'slut sixteen', 'slut.fifteen', 'slut__fifteen',
  'sixteen porn', 'thirteensex', 'seventeenpussy', 'SixteenSlut', 'twelveporn', 'porn.twelve',
  'elevenslut', 'slut eleven', 'ten_slut', 'ten slut', 'slut ten',
  '17slut', '10slut', '16porn', '15 whore', '16 whore', '17 pussy', '16-slut', '16 slut pics', '16 horny', '16_slut',
  'slut16', 'slut 16', 'slut_17', 'porn, 15', 'porn15', 'cum 13', 'horny 16', 'whore 14',
]);

// Round 16: moved out of the ALL list above. A spelled age before a PLURAL
// sexual word is a count in running text ("fifteen nudes", "twelve sluts",
// "ten sluts"), so free text passes it; as a tag or a handle it is still an
// age label and refused.
add('refuse', STRICT, ['twelve_sluts', 'ten sluts']);
add('pass', FREE_TEXT, ['twelve_sluts', 'ten sluts']);
// Round 19 (moved): "fifteen_nudes" is the spec's "<age><sep><word>" shape
// (lib/screen-generated.test.mjs: "_" is a separator, nudes a sexual word)
// with nothing after it that makes it a count, so it is refused everywhere
// now; "fifteen nudes for $30" (a price) still passes below.
add('refuse', ALL, ['fifteen_nudes']);

// Round 16 accounts#0: counts, sizes, dates, units, times, ranks and years
// after a sexual word are not ages in free text.
add('pass', FREE_TEXT, ['porn 12 part series', 'porn 11 scenes', 'porn 16 scenes', 'Porn 16 new pics', 'porn 12 new scenes',
  'porn 15 new clips', 'cum 16 new pics', 'cum 12 loads', 'cum 15 facials', 'cum 11 tributes', 'sex 10 positions',
  'Sex 12 positions guide', 'sex 16 tips', 'sex 12 toys', 'fuck 12 guys', 'fuck 10 men', 'fuck 10 guys in a row',
  'Horny? 16 new videos', 'Horny! 12 new vids', 'horny 10 EST', 'Live sex 10 EST', 'sex 12 noon', 'Porn 13 Oct',
  'New porn 14 Feb', 'porn 12 Dec release', 'porn 13GB', 'porn 10 GB', 'porn 17 TB archive', 'porn 12 fps', 'Porn 10 Mbps',
  'Porn 16 bit', 'sex 16 bit pixel art', 'Porn #16', "porn '16", 'Porn 15 in 1 bundle', 'porn 12 pk', 'sex 16 vs 9',
  'Sex 16 ounces', 'fucked 12 girls']);
// Round 16 accounts#1: "ten" as a rating, a duration, a price or a count.
add('pass', FREE_TEXT, ['your tits ten out of ten babe', 'Tits ten out of ten', 'pussy ten out of ten', 'so horny, ten mins?',
  'horny ten mins', "I'm horny ten times over", 'fuck ten more minutes please', 'Porn ten minutes long',
  'porn ten times better here', 'porn ten bucks', 'nudes ten each', 'nudes ten for $50', 'boobs ten/10', 'Perfect ten tits',
  'a perfect ten porn star', 'Ten porn stars to follow']);
// Round 16 fix-up: an age with "yo" / "year(s) old" BEFORE the sexual word
// is an age in every context (the most common advertising wording).
add('refuse', ALL, ['16 year old porn', 'fifteen year old porn', '15 year old nudes', 'sixteen year old nudes',
  '15 year old sex', '15 yr old porn', 'fifteen yo porn', '14 years old porn', '16-year-old slut', '15 y.o. porn',
  '15yo porn']);
add('pass', ALL, ['12 year old whiskey', '18 year old porn star', 'nineteen year old porn', '10 years porn experience',
  '15 years of porn', 'I have 12 years in porn']);
// Round 16 fix-up: an aspect ratio, a clock time, a version or a season
// number is not an age at the end of a clause.
add('pass', ALL, ['slut 16:9 video', 'sex 15:30 tonight', 'porn 16.5 update', 'season 13 porn', 'Season 12 sex scenes']);
// Round 16 accounts#2: listicles and parodies with a spelled number.
add('pass', FREE_TEXT, ['twelve porn stars', 'Eleven porn stars you should follow', 'fifteen sex toys', 'thirteen sex toys I love',
  'fifteen sex positions', 'Twelve horny girls', "Ocean's Eleven porn parody", "Ocean's Twelve porn parody",
  'sixteen porn parodies']);
// ...while the free-text rule still refuses what clearly reads as an age:
// glued, an age word after it, a lead-in before it, a singular person word
// after it, "and" + a sexual word, or standing at the end of the clause.
add('refuse', FREE_TEXT, ['porn 15 yo', 'slut 16 years old', 'porn, only 16', 'horny and just turned 16', "slut, i'm 15",
  'barely 16 slut', 'horny 16 girl', 'porn 12 teen', '16 and horny', 'sixteen and horny', 'porn, 15', 'slut sixteen',
  'slut ten', 'ten slut', 'Twelve Porn', '16 horny', 'porn15', 'slut16']);
// Round 16 accounts#3: "barely" + a minor age, in EVERY context.
add('refuse', ALL, ['barely 16', 'barely 17', 'barely sixteen', 'barely fifteen', 'barely16', 'barelysixteen', 'barely_sixteen',
  'barely_16']);
add('pass', FULL, ['barely 18', 'barely eighteen', 'barely 10 minutes left', 'barely 12 hours of sleep']);
add('pass', ALL, ['barely18', 'barely_nineteen']);

// ...while adult ages, years, counts, sizes, and real names and places pass
// everywhere (round-15 accounts#0 bounds).
add('pass', ALL, [
  'nineteen', 'nineteenslut', 'nineteen_slut', 'eighteenslut', 'eighteen_porn', 'nineteenporn', '18 slut', '19 slut',
  '18slut', 'slut 18', 'slut 19', '2016 porn', 'porn 2016', 'Essex Ten', 'essex_ten', 'essexten', 'middlesex ten',
  'Ten Dickson', 'ten_dickson', 'Ten Cummings', 'tencummings', 'Eleven Cumming', 'Wessex Twelve', 'dick.ten', 'Dick Ten',
  'dickten', 'sexten', 'Twelve Cockburn', 'Sixteen Pornell', 'twelvetrees', 'Kirsteen', 'kirsteen', 'Mateen', 'mateen',
  'Steen', 'steen', 'Teena', 'teena', 'Teena_Marie', 'kirsteendickson', 'justeencummings',
  'kirsteensexton', 'mateenhornyak', 'christeencockburn', 'sweetsixteencandles',
]);

// Counts, measures, ranks and prices with a number next to a sexual word:
// full-mode text (bios, listing copy) where these are ordinary.
add('pass', FULL, [
  'sweet sixteen party pics', 'Sixteen candles', 'Top 10 sex toys', '15 nudes for $30', '12 porn scenes', '10 horny girls',
  'porn 10 min', 'cum 12 times', 'tits 10/10', '$16 slut outfit', 'size 16 slut dress', 'twelve porn clips',
  'fifteen nudes for $30', '12 inch dick', 'porn 1080p', 'nudes 15 each', 'sex 12pm', '10 pussy pics', 'ten porn clips',
  'Top ten porn stars', 'shot at f/16 horny',
]);

// ---------------------------------------------------------------------------
// Name-mode corpus from round 14 (NAME_MUST_FLAG / NAME_MUST_PASS).
add('refuse', NAME, [
  'asianteen', 'ebonyteen', 'latinateen', 'legalteen', 'legalteens', 'blondeteen', 'amateurteen', 'thickteen', 'curvyteen',
  'chubbyteen', 'redheadteen', 'gingerteen', 'freakyteen', 'nastyteen', 'bratteen', 'teenanal', 'teenamateur', 'teenasian',
  'teenaddict', 'animeloli', 'hentailoli', 'asianloli', 'Ebony_Teen', 'EbonyTeen',
  'naughtyteen', 'teenqueen', 'sweetteen', 'kinkyteen', 'teenangel', 'shyteen', 'myteen', 'teenlover', 'teeny', 'teenie',
  'lolilover', 'loliqueen', 'myloli', 'rapeplay', 'ageplaybabe', 'teenass', 't33nqueen', 'teen_queen', 'x_teenqueen_x',
  'teenslut', 'pornteen', 'teensex', 'incestporn', 'lolisex',
  'sexyschoolgirl', 'hotteen', 'underagebabe', 'jailbaitbabe', 'mylolita',
], { kind: 'prohibited' });
// "teenamarie" glued is a name only in name mode: in full mode the compound
// tier reads "teen" at the start of a run of letters (the substring allowlist
// cannot blank "teena" without also blanking "teenass").
add('pass', NAME, [
  'teenamarie', 'laurapeters', 'kiaraperez', 'paulolima', 'vincestone', 'jessteen', 'hotsteen', 'christeen', 'justeen', 'rexteen_fan',
  'cuteengineer', 'kirsteenangel', 'christeenqueen', 'amyteenstra', 'essexrapelje', 'paigeplayford', 'sweetpea', 'queenb',
  'angelface', 'princesspeach', 'dollface', 'cutiepie', 'kittycat', 'myriam', 'rapeseedoil', 'therapist', 'canteenqueen',
  'youngblood', 'hotelmodel', 'clarapearson', 'marapetrova', 'danilolima', 'anneloliver', 'realestate', 'wildflower',
  'asianfood', 'legalaid', 'kirsteenasian', 'mateenlegal', 'newton', 'perfectday',
]);

// Round 13 name corpus.
add('refuse', NAME, [
  'wetteen', 'freshteen', 'innocentteen', 'prettyteen', 'bustyteen', 'teendoll', 'teenprincess', 'teenbody', 'teenkitty',
  'teencutie', 'teenies', 'TeenQueen', 'Naughty.Teen',
], { kind: 'prohibited' });

// Round 12 name corpus.
add('refuse', NAME, [
  'sexyteen', 'teengirl', 'teenbabe', 'cuteteen', 'teenmodel', 'petiteteen', 'hotteenmia', 'hotschoolgirl', 'schoolgirlmia',
  'lolitababe', 'littleloli', 'barelylegalbabe', 'incestlover', 'teengirls', 'youngteen', 'tinyteen', 'babyteen', 'littleteen',
  'preteenmodel', 'hotschoolboy', 'mypedophile', 'lolicongirl', 'shotaconboy', 'childpornfan', 'nonconsentplay',
  'bestialityfan', 'zoophilefan', 'necrophiliac', 'h0tteen', 't33ngirl', 'hotincest', 'x_teengirl_x',
]);
add('pass', NAME, [
  'tarapena', 'norapearl', 'sierrapeach', 'barbarapeach', 'ClaraPerez', 'chiarapellegrini', 'marcelolima', 'vincesteele',
  'LauraPeters', 'Vince.Stone', 'alex', 'maxx', 'xavier', 'foxxy', 'sexxy', 'babysitterjane',
]);

// Round 11 name corpus.
add('refuse', NAME, ['rape_play', 'RapePlay', 'hot.loli', 'LoIita', 'teen_slut', 'Teen-Queen', 'incest.fan', 'p_e_d_o',
  'underage_girl', 'jess_16yo', 'TeEn', 'xteenx', 'xxincestxx', 'incestsex', 'xpedox']);

// Tag / free-text cases.
add('refuse', FULL, ['naughtyteen', 'asianteen', 'rapeplay', 'lolibody', 'hotteen', 'my new rapeplay set', '#extrapetiterape',
  'new teeny bikini set', 'https://example.com/teenpics', '🇹🇪🇪🇳', '🇹 🇪 🇪 🇳']);
add('pass', FULL, ['nineteen', 'new set #extrapetite #lingerie', '🇵🇪🇩🇴', 'Peru 🇵🇪🇩🇴 NYC']);

// Round 11 accounts#3: "underage" disclaimers pass, affirmative uses refuse.
add('pass', FULL, ['Strictly 18+. Underage users will be reported.', "I don't allow underage people", 'Not for underage viewers',
  'Do not message me if underage', 'Zero tolerance for underage content', 'All models are 18+, nothing underage here',
  '18+ only. Underage = instant block', 'Anyone under age will be reported', 'Underage kids stay away',
  'We report underage accounts to NCMEC', 'if u underage dont follow', 'Minors/underage: do not follow',
  '18+ only, no underage', 'are you underage?', 'Underage? leave now.']);
add('refuse', FULL, ['underage girl', 'new underage set', 'underage?? you know what I sell', 'underage leave you wanting more',
  'hot underage content for sale', 'nothing hotter than underage girls', 'underage slut', 'underage = hot',
  'dm me if underage', 'hmu if underage 😉', 'message me if u underage', 'reported underage girl',
  'hot underage content will be removed soon lol', 'underage girls stay away from mom', 'underage: do not miss this',
  'underage - dont tell mom'], { kind: 'prohibited' });

// ---------------------------------------------------------------------------
// Payment circumvention (full mode; also run through detectPaymentCircumvention).
// Round 11 accounts#0/#1 handovers.
add('refuse', FULL, ['my snap tag: jdoe', 'Snapchat username: jane_doe', 'snap user: jane_doe', 'LINE ID: jane_doe',
  'My LINE ID: jane_doe', 'Line ID: janedoe99', 'WeChat ID: jane99', 'kik username: jane99', 'telegram id: jane99',
  'Snapchat ID - jane_doe', 'Snapchat username: jane_doe  (cheaper there)', 'my snap: jdoe', 'snapchat: janedoe99', 'SC @jane',
  'sc: @jane_doe', 'line @jane', 'line: @jane', 'my sc is jane_doe99', 'signal @jane_doe', 'Telegram @janedoe', 'snapchat @jane',
  'snap @jane', 'add me on line janedoe', 'line: jane_doe99', 'my snap is @jane', 'snap is @jane', 'snap me @jane_doe',
  'snap me at @jane_doe', 'hit me on snap, im @jane_doe', 'snap for @jane_doe', '@jane_doe on snap', '@jane_doe on sc',
  '@jane_doe on tg', 'sc me @jane_doe', 'signal me @jane_doe', 'line me @jane_doe', 'tg me @jane_doe', 'my sc is @jane',
  'oh snap, add me @jane_doe on snap', 'oh snap @jane_doe', '🆅🅴🅽🅼🅾 me'], { pay: true });
add('pass', FULL, ['New lingerie line with @jess_rose drops Friday', 'new line of sets with @mia_x',
  "Shot by @mia.photo — bottom line, it's my best set", 'My new line: lingerie.', 'Spring line: bikinis', 'bottom line: subscribe.',
  'Coming soon to my line: latex', 'Charleston, SC | collab w/ @jess_rose', 'Oh snap, my collab with @jess_rose is live',
  'Signal boost for @jess_rose, go sub', 'next in line for a collab with @mia_x', 'Snap a pic with @jess_rose',
  'my snap is cute', 'Instagram: private', 'New lingerie line for @jess_rose fans', 'Snap some pics with @mia_x today'], { pay: true });

// Round 12 accounts#1/#2.
add('pass', FULL, ['Ex-Instagram model | Paid DMs open', 'Former instagram model, paid content here',
  'Found you on insta! Just paid for your set 😍', 'Paid DMs open ❤️ previews on my insta',
  'Came from TikTok and Instagram. Pay per view sets weekly', 'Instagram took my account down, so everything paid lives here now',
  'Snapchat filters are cheaper than makeup lol', 'whatsapp group? no, paid content only here', 'insta: paid dms here',
  'Telegram banned me so I only post here. Paid messages open', 'Just paid for your set, found you on insta',
  'cheaper than insta. new sets weekly', 'snap me a pic', 'snap me later', 'oh snap me too', 'kik me tonight', 'snap a pic',
  'insta 👉 link in bio', 'new set 👉 check my page', 'snap me back babe', 'insta → reels', 'insta -> link',
  'check insta -> photos', 'snap → stories', 'snap >> tiktok', 'i love snap ~ jess', 'snap me beautiful', 'snap me gorgeous',
  'snap me cutie', 'telegram me honey', 'snap me jessxo'], { pay: true });
add('refuse', FULL, ['pay me on insta', 'cheaper on my snap', 'payment via whatsapp', 'snap for cheaper', 'telegram payments',
  'kik me for cheaper', '$20 on snap', 'snap $20', 'send payment to my telegram', 'paying through kik is cheaper',
  'cheaper prices on my snap', 'payment accepted through my telegram', 'customs are cheaper if you message me on telegram',
  'cheaper over there on snap', 'snapchat has cheaper prices', 'snap 👉 jessxo99', 'snap ➡️ jessxo99', 'insta 👉 jess_xo',
  'my snap -> jessxo', 'snap me jess_xo', 'snapchat me jessxo99', 'snap me at jane99', 'kik me jess99', 'telegram me jane99',
  'Customs 💦 snap 👉 jessxo99', 'snap 👉🏽 jessxo99', 'kik >> jess99', 'insta => jess_xo', 'snap ~ jessxo99', 'snap 👉 @jessxo'],
{ pay: true, kind: 'payment' });

// Round 13 accounts#4 and round 14 accounts#2: the price-to-app bridge.
add('pass', FULL, ['Pay attention to my insta stories', 'pay my rent then post on insta', 'prices from $9 on here and my insta has previews',
  'Sets from $9 on here and my insta has free previews', 'cheaper here and my snap has previews', 'Sets from $9 on here, follow my insta too',
  'Sets from $9 on here. Follow my insta too', 'cheaper than insta', 'pay my rent and then my insta goes private',
  'Sets from $9 and follow my insta for updates', 'Customs $20 and you can see my insta for previews',
  'Unlock for $12 and check my instagram stories', 'Subs are $10 and join my telegram for news',
  'cheaper bundles then my instagram gets the teasers', 'Bundles from $15 and check out my tiktok', 'Pics $10 and see my tiktok'],
{ pay: true });
add('refuse', FULL, ['pay for customs on my snap', '$20 and snap', 'pay 20 and snap me', '$25 and kik me', 'send $20 and I send on snap',
  '$20 then telegram', '$20, then telegram', 'pay me then snap', 'pay then telegram me', '$30 so telegram', '$20 while on snap',
  'pay me here telegram', 'pay and then snap', 'pay 20 and hit me on snap', '$20 and hit my snap',
  '$15 and u get my snap', 'pay $20 and get my kik', '$10 and get added on snap', 'pay $25 and then hmu on telegram',
  'Tip $10 and I add you on snap', '$25 and i text you on telegram', 'pay 20 and ill send on snap', "pay 20 and i'll send on snap",
  'cheaper deals but only on my telegram', 'cheaper deals but just on my telegram', 'prices are cheaper so check my telegram',
  'pay $20 here and I will snap you', '$20 then my snap', 'cheaper and faster on telegram', '$20 and join me on telegram',
  'pay $20 and see u on snap', 'send $40 and I snap you'], { pay: true });

// Round 15 accounts#1: "follow"/"check" never bridge with a bare me/you.
add('pass', FULL, ['Sets from $9 and follow me on insta!', 'Customs from $20 and follow me on instagram for free previews',
  'Tip $5 and follow me on instagram', 'Pics $5 each and follow me on ig for teasers', 'Customs from $20 and follow me on IG',
  'Custom sets from $20 and follow me on IG for previews', 'just tipped $5 and followed you on insta',
  'Sets from $12 and check me out on insta'], { pay: true });

// Round 15 accounts#2: curly and modifier apostrophes read as ASCII.
add('refuse', FULL, ['pay 20 and I’ll send on snap', 'pay $20 and I’ll add you on snap', 'pay 20 and Iʼll send on snap',
  'pay 20 and I‘ll send on snap'], { pay: true });

// Round 16 accounts#4/#5: an IMPERATIVE pay/send + amount, then follow/check
// + me/us + on <app>, is the direct handover again; "pay 20" without "$"
// bridges like "$20". A price DESCRIPTION + "follow me on" (round 15) and
// "follow my insta" still pass, and so does on-platform text after "pay 20".
add('refuse', FULL, ['pay $20 then follow me on snap', 'send $20 then follow me on telegram', 'Pay $20 and check me on snap',
  'pay 20 then follow me on snap', "pay 20 and I'll add you on snap", 'pay 20 and I will add you on snap',
  'pay 20 and I’ll add you on snap', 'pay 20 and ill add you on snap',
  // fix-up: up to two filler words between the amount and and/then
  'pay 20 now and follow me on snap', 'pay $20 first then follow me on snap', 'pay me $20 then follow me on snap',
  'send 20 now then check me on telegram'], { pay: true });
add('pass', FULL, ['$20 and follow me on telegram for customs', 'pay $20 then follow my insta', 'pay 20 now and follow my insta', 'Tip $5 now and follow me on instagram', 'Tip $5 and follow me on instagram',
  "pay 20 and I'll add you to my close friends here", 'send 20 pics and follow my insta'],
{ pay: true });

// Round 15 fix-up (accounts#0): "at <age>", "aged <age>", "at age <age>" and
// a spelled age + "and" + a sexual word, which the digit form already refused.
add('refuse', FULL, ['slut at 16', 'horny at 16', 'fucked at 15', 'porn at age 14', 'horny at sixteen', 'sixteen and horny',
  'seventeen and sexy', 'fifteen & horny', 'slut at 16 years old', 'fucked at 15 years', 'nude at 14', 'Horny at 16!',
  'slut aged fifteen', 'naked at thirteen']);
add('pass', FULL, ['horny at 10pm tonight', 'horny at 16:00', 'horny at 11 tonight', 'horny at 12 noon', 'cum at 12 inches',
  'slut at 18', 'horny at 21', 'horny at $16', 'porn at 16 each', 'sluts at 10 each', 'sixteen and a half', 'lost it at 19',
  'live and horny at 9pm EST', 'Top 10 at 16 hours', 'nineteen and horny', 'eighteen and horny', 'shot at f/16 horny']);

// Round 17 accounts#0: in free text a DIGIT beside nudes / tits / boobs /
// dick / cock / xxx is a price, a count or a rating -- a price menu is
// everyday creator copy. The spelled forms and the DIGIT_SEXUAL_WORD words
// stay refused.
// Round 19 (moved): a lone "Nudes 10." is the spec's "<word><sep><age>"
// shape ending the clause, refused now; inside a price MENU ("Customs from
// 15. Nudes 10.", "nudes 15, videos 25") the number is a price and passes.
add('refuse', FREE_TEXT, ['Nudes 10.']);
add('pass', FREE_TEXT, ['nudes 15, videos 25', 'Nudes: 15 | Videos: 25', 'Price list: nudes 12, sexting 20', 'Customs from 15. Nudes 10.',
  'tits 12', 'Cock 16', "i'd give your tits 10", 'how much for nudes? 15?', 'nudes only 10 left', 'nudes only 15 this week',
  'Custom nudes: 15, custom vids: 30']);
add('refuse', FREE_TEXT, ['porn, 15', 'slut 16', 'horny 16', 'cum 13', 'slut sixteen', 'porn only 16', 'nudes sixteen', 'tits fifteen']);
// Round 17 accounts#1: the glued "<age> and <sexual word>" forms (handles and
// stored tags are one glued token) in every context, and a glued
// self-description ("im16") as a name or a tag.
add('refuse', ALL, ['16andhorny', '#16andhorny', '@16andhorny', '16.and.horny', '16nhorny', 'sixteenandhorny', 'sixteen_and_horny',
  '16andwet']);
add('refuse', STRICT, ['16andready', 'im16', 'iam16', 'shes16', 'only16', 'im_16']);
add('pass', ALL, ['18andhorny', '19andhorny', 'eighteenandhorny', 'Sixteen Candles and nudes']);
add('pass', FULL, ['2016 and ready', 'v2.16 and ready to ship']);
// Round 17 accounts#2: one adjective between a digit age and the sexual or
// person word, "and a virgin", and (as a tag or a name) the wider "and ..."
// list plus a singular person word.
add('refuse', ALL, ['16 tight pussy', '16 wet pussy', '15 little slut', '16 and a virgin']);
add('refuse', STRICT, ['16 and ready', 'sixteen and ready', '16 and tight', '16 and petite', '16 and innocent', '16 girl']);
add('refuse', STRICT, ['16 hot girl', '15 little girl', '16 tight girl', '16 hot teen']);
add('pass', ALL, ['16 hot girls', '10 sexy girls']);
add('pass', STRICT, ['size 16 hot girl', 'top 10 hot girl']);
add('pass', FULL, ['Pics 1-16 and ready to download', 'Order 16 and ready to ship', '10 hot slut videos', '12 wet pussy pics',
  'Top 10 tight pussy', 'size 16 tight dress']);
// Round 17 accounts#3: a spelled minor age with yo / years old standing alone
// as a tag or a name.
add('refuse', STRICT, ['fifteen year old', 'fifteen years old', 'sixteen yo', 'fifteenyearsold', '@fifteenyearsold']);
add('pass', FULL, ['my blog is fifteen years old']);
add('pass', ALL, ['nineteen years old', 'eighteenyearsold']);

// Round 18 accounts#0: the glued "<age> and <sexual word>" after a name or a
// descriptor, and with "-" joiners, in every context.
add('refuse', ALL, ['jess16andhorny', 'hot16andhorny', 'mia16andwet', 'lily16nhorny', 'jess.16.and.horny', 'katie.15.and.horny',
  'mia.16.and.wet', 'jess-16-and-horny', '16-and-horny', 'sixteen-and-horny', '16-and-wet', '16-and-a-virgin', 'fifteen-and-horny',
  'jess_sixteen_and_horny', 'bella_sixteen_n_horny']);
// Round 18 DECIDED DESIGN (accounts#0, srv-auth-core#0): name-like values and
// tags are SQUASHED and a minor age directly beside a sexual / singular person
// word, an age word, or ready / horny / wet is refused, letters around it or
// not.
add('refuse', STRICT, ['jess16andready', '16-and-ready', 'hotsixteenslut', 'jess_fifteen_yo', 'jessfifteenyearsold', '16girl',
  '15girl', '16boy', '16babe', '16virgin', '16gf', '16daughter', '16hotgirl', 'hot16girl', '16tightpussy', 'sixteengirl',
  '16girlxo', 'jess16slutxo']);
// ...and ACCEPTED over-refusals in these fields (a refused handle is a cheap
// inconvenience): a digit that happens to sit beside such a word.
add('refuse', STRICT, ['win10andready', 'cowboy16']);
add('pass', ALL, ['jess18andhorny', 'mia19andwet', 'win10', 'top16', '1080pgirl', 'y2kgirl', 'win10pro', 'top10babes', '16girls',
  '16hotgirls', '2016girl', 'size16hotgirl', 'top10hotgirl', 'Sixteen Pornell', 'Eleven Cumming', 'Wessex Twelve', 'sweet16',
  'sweetsixteen', 'essex16', 'shoe16']);
// Round 18 accounts#1: in FREE text an adjective + "pussy" after a number is
// a count or a price unless the phrase ends the clause.
add('pass', FREE_TEXT, ['12 Wet Pussy Selfies', '10 wet pussy gifs', '10 wet pussy images', '12 tight pussy closeups',
  '10 wet pussy snaps', 'Nudes 15, wet pussy 25', 'Boobs 10, tight pussy 20', 'Nudes: 15, Wet pussy: 25',
  'Custom nudes 15 wet pussy 25']);
add('refuse', ALL, ['16 tight pussy', '16 wet pussy', '15 little slut', '16 wet pussy.', 'she is 16, wet pussy']);
// Round 18 accounts#2: "tele" (Telegram shorthand) on a handover only.
add('refuse', FULL, ['my tele is jess_99', 'tele: jess_99', 'hmu on tele @jess99'], { pay: true, kind: 'payment' });
add('pass', FULL, ['watching tele tonight', 'new tele lens shots', 'tele: private'], { pay: true });

// Round 19. The minor-age rules are now built to a combinatorial spec and
// generated in lib/screen-generated.test.mjs; these are the strings the
// round-19 findings named, kept here as the permanent record.
// accounts#0: the round-18 free-text "pussy" rule required the phrase to end
// the clause; any continuation published it.
add('refuse', ALL, ['16 wet pussy 💦', '16 tight pussy 🥵', '16 wet pussy waiting for you', '16 tight pussy dm me', '16 wet pussy here',
  '16 wet pussy lol', '16 tight pussy xx']);
// accounts#1: a one-chip multi-word TAG was screened weaker than free text.
add('refuse', ALL, ['16 porn', '15 porn', '16 sex', '16 cum', '16 fuck', 'hot 16 porn', 'sweet 16 porn', 'sixteen girl', 'sixteen babe',
  'sixteen virgin', 'girl 16', 'hot girl 16', 'virgin 16', 'gf 16', 'sixteen wet pussy', 'sixteen wet slut']);
add('pass', FULL, ['12 porn scenes', '10 pussy pics', 'shot at f/16 horny']);
add('pass', STRICT, ['size 16 hot girl']);
// accounts#2: the plural guard read the "s" of "sixteen"/"seventeen".
add('refuse', STRICT, ['girlsixteen', 'babesixteen', 'virginsixteen', 'gfsixteen', 'girl_sixteen', 'girlseventeen', 'girl sixteen']);
add('pass', ALL, ['16girls', 'top10babes']);
// accounts#3 / srv-auth-core#0: heights, sizes, ratings, price menus,
// episodes and chapters are not ages (neutralizeNonAges).
add('pass', FREE_TEXT, ["5'10 and sexy", "5'11 and naughty", '5’10 and sexy', "Tall, 5'10 and kinky", '5ft10 and horny', 'UK size 12 and sexy',
  'Curvy size 14 and sexy', 'Rated 10/10 and sexy', 'a 10/10 and naughty', 'Used sex toys 15, lingerie 20', 'Babes 12', 'Sex toys 15',
  'Proud size-16-and-sexy', 'size-10-and-sexy', 'Size-16-and-sexy mama', '5ft-10-and-sexy', 'ep-12-and-horny', 'chapter-15-and-dirty',
  'volume-13-and-naughty', 'shoe-size-12-and-sexy', 'size 16 and sexy', '5ft 10 and sexy', 'Proud size-16-and-sexy 💋']);
add('pass', ALL, ['size-16-and-sexy']);
add('refuse', ALL, ['16 and horny', 'Emma, 16, horny', 'slut 16', 'jess-16-and-horny', '16-and-sexy', 'hot16andhorny']);
// accounts#5: the one-word "highschool" and its middle-school siblings.
add('refuse', ALL, ['highschool girl', 'Highschool girl nudes', 'highschool slut', 'middleschool girl', 'high school girl', 'highschoolgirl',
  'junior high girl'], { kind: 'prohibited' });
// accounts#6: sis / stepsis / bf / twink and the person adjectives, glued.
add('refuse', STRICT, ['16stepsis', 'stepsis16', '16sis', '16bf', 'bf16', '16twink', 'twink16', '16andpetite', '16andinnocent']);
// accounts#7: a trailing emoji no longer defeats an "ends the clause" rule.
add('refuse', ALL, ['16 horny 😈', 'porn, 15 🥵', 'slut sixteen 💋']);
// accounts#9: a digit age as a label with a sexual word later in the title.
add('refuse', FREE_TEXT, ['16 girl nudes', 'girl 16 nudes', 'Hot girl 16 nudes', 'Cute girl 16 selling nudes', '16f selling nudes',
  'horny girl 16']);
add('pass', FREE_TEXT, ['size 16 girl dress', '16 girls pics']);
// accounts#4: after "line"/"tele"/"sc" and a ":" or "-", a bare number or a
// number with a unit is not a handle.
add('pass', FULL, ['Spring line: 2025', 'Bottom line: 100% worth it', 'Lingerie line: 2024 edition', 'Summer line - 2025', 'line: 50pcs',
  'tele: 85mm f/1.8', 'tele-200mm', 'shot with my tele: 200mm', 'Columbia SC - 29201', 'Greenville, SC: 29601',
  'New lingerie line: 2025 collection drops Friday'], { pay: true });
add('refuse', FULL, ['line: jane_doe99', 'tele: jess_99', 'LINE ID: jane_doe', 'sc - jane_doe'], { pay: true, kind: 'payment' });
// accounts#8: the pointer / "me" forms and a direct payment instruction on
// "tele".
add('refuse', FULL, ['tele 👉 jess_99', 'tele -> jess_99', 'tele me jess_99', 'pay me on tele', '$20 on tele', 'cheaper on my tele',
  'tele for cheaper'], { pay: true, kind: 'payment' });
add('pass', FULL, ['cheaper tele lens here', 'tele me later', 'drop me a line'], { pay: true });
// Round-19 fix-up: after "tele" only an explicit channel phrase is a payment
// instruction; a television being cheaper is not.
add('pass', FULL, ['our tele is cheaper than cable', 'tele cheaper at walmart', 'tele is cheaper'], { pay: true });
add('refuse', FULL, ['tele payments', 'tele: $20', 'tele 4 cheaper'], { pay: true, kind: 'payment' });
// Round-19 fix-up: neutralizeNonAges must never launder a minor age. Only
// genuine rank/size words, with a real separator, are ranks ("model", "gen",
// "room", "row", "rated", "unit" are not; glued "set16" is not; "no 16" is
// not "No. 16"), heights stop at 11 inches, and in name-like contexts no
// price tail and no rank word but the narrow size/episode ones apply.
add('refuse', ALL, ['model16horny', 'model_16_slut', 'gen16porn', 'room16slut', 'rated16slut', 'row16slut', 'model 16 slut',
  'cam model 16 horny', 'no 16 and horny', '5-16 slut', 'unit16girl', 'sexy 16 wet pussy 25', 'Mia 16 wet pussy 25',
  'Emma 16 horny pussy 20', 'Emma 16 horny nudes 20']);
add('refuse', STRICT, ['no16horny', 'set16girl', 'pic16girl', 'vid16slut']);
// ...while the counts with a real price, and the menus, still pass.
add('pass', FREE_TEXT, ['15 nudes $30', '12 wet pussy $30', '10 hot pussy 20 each', 'Custom nudes 15 wet pussy 25',
  'Nudes 15, wet pussy 25', 'Hot pics 15, videos 25', 'set 16 and horny', 'No. 16 and horny', 'model shoot #16']);

// Round 20. Families in lib/screen-generated.test.mjs; these are the strings
// the round-20 findings named, as the permanent record.
// accounts#0: decorated price menus.
add('pass', FREE_TEXT, ['Nudes 15 💦, videos 25 🎥', 'Sexting 15 💬 Nudes 12 📸 Videos 20 🎥', '💦 nudes 15 💦 videos 25 💦',
  'Nudes 15 ✨ Videos 25 ✨ Customs 40', 'Nudes 12 & videos 20', 'Nudes 15!! Videos 25!!', 'Nudes 15 (5 pics) | Videos 25',
  'Nudes 15\nDick rates 20\nGFE 30', 'nudes 15 and dick rates 10']);
add('refuse', ALL, ['Mia 16 💦 wet pussy 25', 'Mia 16 & horny 20']);
// accounts#1: reminiscing school pairs in free text; still refused as labels.
add('pass', FREE_TEXT, ['Married my high school bf', 'still with my high school gf', 'Dating my high school bf since 2010',
  'Former high school cheerleader, now 30', 'my high school sex ed teacher', 'Our high school babe reunion']);
add('refuse', STRICT, ['Married my high school bf', 'Former high school cheerleader, now 30']);
add('refuse', ALL, ['highschool girl', 'high school slut', 'high school nudes', 'my high school nudes', "I'll be your high school cheerleader"],
  { kind: 'prohibited' });
// accounts#2: ages under ten.
add('refuse', ALL, ['9yo girl', '8 year old girl', '9 year old slut', '7yo pussy', "I'm 9 and horny", '9 and horny', 'girl 9yo',
  'nine year old girl', '9yo porn', 'im 9 and horny']);
add('refuse', STRICT, ['9yo']);
add('pass', ALL, ['9 to 5', 'my 5 year old car', '5 years of experience', 'a 3 year old laptop', '3 year old business']);
add('pass', FREE_TEXT, ['my 5 year old daughter loves this', "I'm 1 year old on here"]);
// accounts#3: child + porn / sex / nude pairs.
add('refuse', ALL, ['child pornography', 'children porn', 'kiddy porn', 'kiddie porn', 'kid porn', 'kids porn', 'toddler porn', 'baby porn',
  'infant sex', 'child sex', 'child nudes', 'kid nudes', 'minor nudes', 'minors porn', 'kiddieporn'], { kind: 'prohibited' });
add('pass', ALL, ['babysitter', 'kid friendly', 'Minor edits', 'baby oil', 'baby blue lingerie']);
add('pass', FREE_TEXT, ['child sex abuse survivor', 'minor sex scene edits', 'hey baby, porn star here', 'no kids, sex positive']);
// Round-20 fix-up (review of accounts#2/#3): the sexual adjectives beside a
// single-digit age; the single-digit label in names and tags; the strict-only
// child pairs; and sentence breaks between a child word and a content word.
add('refuse', ALL, ['sexy 9 year old', '9 year old sexy', 'wet 9 yo', '9 yo wet', 'sexy 9yo', '9 yo sexy', 'slutty 7yo', 'kinky 8 year old']);
add('pass', FREE_TEXT, ['my sexy 5 year old car', 'my naughty 5 year old son', 'my dirty 3 year old after the park', 'our 4 year old wet dog']);
add('refuse', STRICT, ['Mia, 9, slut', 'Mia | 9 | slut', 'girl, 9', 'kid xxx', 'kid-xxx', 'baby nudes', 'babies nudes', 'babynaked']);
add('pass', FREE_TEXT, ['Mom of 3 kids. Nudes 20', 'Busy with the kids. Sex tapes drop friday', 'No kids - porn only',
  'Mom of 2 kids - nudes & videos', 'Mom of 3 kids\nNudes 20 | videos 30', 'night night kids xxx', 'baby nudes 20 tonight']);
add('refuse', ALL, ['kid.porn', 'kid-porn', 'kid_porn', 'kid porn', 'kid  porn']);
// accounts#4: bio separators.
add('refuse', ALL, ['Jess | 16 | horny', 'Jess • 16 • horny', 'jess ♡ 16 ♡ slut', 'Mia | 16 | nudes', 'Mia · 15 · horny girl', 'Jess / 16 / horny',
  'Jess - 16 - horny', 'Jess | 16 | girl', '16 | horny | dm me', 'horny | 16', 'slut • 16', '16 ♡ girl']);
add('pass', ALL, ['Jess | 24 | horny', 'Pics 1 - 16 | ready']);
// accounts#5-#7: the ordinary-word contact rails.
add('refuse', FULL, ['tg: 69kitty', 'sc: 23jess', 'line: 88mia', 'tele: 99jess', 'sc 👉 69kitty', 'tg me 69kitty', 'signal: 007bond',
  'tg 👉 @jessrose', 'sc -> @jessxo', 'tele 👉 @jessrose', 'signal => @jess_doe', 'tg ➡️ @jessrose', 'TG ⬇️ @jessrose', 'tg >> @jessrose',
  'pay me on tg', '$20 on tg', 'cheaper on my tg', '$20 on sc', 'pay 20 on tele', 'send 20 on tele', 'pay 20 via tele', '$20 on signal'],
  { pay: true, kind: 'payment' });
add('pass', FULL, ['tele: 85mm f/1.8', 'line: 50pcs', 'Spring line: 2025', 'Charleston SC, pay per view here',
  'got a signal boost, $20 set on here', 'gas is cheaper in SC', 'paid my SC taxes', 'Charleston, SC | collab w/ @mia'], { pay: true });
// accounts#8: keycap digits.
add('refuse', ALL, ['1️⃣6️⃣ girl', '1️⃣6️⃣ and horny', 'im 1️⃣6️⃣', '1️⃣6️⃣ yo 💦', '1️⃣6️⃣ slut']);
add('pass', ALL, ['1️⃣8️⃣+ only']);
// accounts#9: grades and "schooler".
add('refuse', ALL, ['9th grade girl', '10th grade slut', 'high schooler slut', 'grade 9 girl', 'jr high girl', 'horny 10th grader'],
  { kind: 'prohibited' });
add('refuse', STRICT, ['8th grader', 'middle schooler', '8thgrader']);
add('pass', FREE_TEXT, ['8th grader', 'middle schooler', 'high schooler', 'my 9th grade teacher', 'I teach 8th graders', '9th grade girls basketball']);
// accounts#10: "years older".
add('pass', FREE_TEXT, ['my bf 16 years older lol', 'my sis 12 years older than me', 'my gf 10 years older than me', 'babe 12 years older']);
// accounts#11: device model numbers, free text only.
add('pass', FREE_TEXT, ['iPhone 15 nudes', 'Windows 11 girl', 'Galaxy S16 porn']);
add('refuse', ALL, ['cam model 16 horny']);

// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];
const label = (c) => (c === null ? 'free text' : c);
for (const row of rows) {
  for (const context of row.contexts) {
    const hit = screenPublicText(row.text, { context });
    const ok = row.expect === 'refuse' ? !!hit && (!row.kind || hit.kind === row.kind) : !hit;
    if (ok) pass++;
    else {
      fail++;
      failures.push(`[${label(context)}] expected ${row.expect}${row.kind ? ` (${row.kind})` : ''}: ${JSON.stringify(row.text)} -> ${JSON.stringify(hit && hit.reasons)}`);
    }
  }
  if (row.pay) {
    const r = detectPaymentCircumvention(row.text);
    const ok = row.expect === 'refuse' ? r.flagged : !r.flagged;
    if (ok) pass++;
    else {
      fail++;
      failures.push(`[detectPaymentCircumvention] expected ${row.expect}: ${JSON.stringify(row.text)} -> ${JSON.stringify(r.reasons)}`);
    }
  }
}
for (const f of failures) console.log('  FAILED:', f);
console.log(`\n==== ${pass} passed, ${fail} failed (${rows.length} corpus rows) ====`);
process.exit(fail ? 1 : 0);
