// Run with: node lib/payment-circumvention-filter.test.js
//
// A plain node script on purpose -- the live Next.js site has no test runner
// wired up (package.json's only test script is hardhat, for contracts/), and
// this file is worth nothing if it can't be run in one command. Exits non-zero
// with a list of every failure.
//
// Both directions matter here. A filter that blocks innocent people is a
// support problem and logs them to the admin violations queue as if they tried
// to dodge a fee; a filter anyone can step around with one space or one
// lookalike character protects no revenue at all.

import { detectPaymentCircumvention } from './payment-circumvention-filter.js';

const failures = [];

function mustBlock(text, note) {
  const { flagged } = detectPaymentCircumvention(text);
  if (!flagged) failures.push(`MISSED (should be blocked): ${JSON.stringify(text)} -- ${note}`);
}

function mustPass(text, note) {
  const { flagged, reasons } = detectPaymentCircumvention(text);
  if (flagged) failures.push(`FALSE POSITIVE (should be allowed): ${JSON.stringify(text)} -- ${note} [${reasons.join('; ')}]`);
}

function mustHaveReason(text, reason) {
  const { reasons } = detectPaymentCircumvention(text);
  if (!reasons.includes(reason)) failures.push(`WRONG REASON: ${JSON.stringify(text)} -- expected "${reason}", got [${reasons.join('; ')}]`);
}

// --- still blocked: the plain, obvious attempts -------------------------------

mustBlock('my cashapp is $johndoe', 'named the app outright');
mustBlock('Cash App me instead, no fees', 'two-word spelling');
mustBlock('hit me up on venmo', 'venmo');
mustBlock('zelle me and I will send the full set', 'zelle');
mustBlock('paypal.me/whoever', 'paypal link');
mustBlock('I take apple pay or google pay', 'wallet apps');
mustBlock('western union works too', 'western union');
mustBlock('moneygram if you are outside the US', 'moneygram');
mustBlock('i cashapped him last week', 'verbed app name');
mustBlock('she venmoed me already', 'verbed app name');

// --- still blocked: the evasions the old version walked straight past ---------

mustBlock('hit me up on v e n m o', 'letters spaced apart');
mustBlock('V-E-N-M-O works', 'punctuation between letters');
mustBlock('c.a.s.h.a.p.p me', 'dots between letters');
mustBlock('ca$h app me', 'symbol substituted for a letter');
mustBlock('v3nm0 is easier', 'leet spelling');
mustBlock('payp4l only', 'leet spelling');
mustBlock('send me a dm on v\u0435nmo', 'Cyrillic \u0435 standing in for a Latin e');
mustBlock('ｖｅｎｍｏ is fine', 'fullwidth letters');
mustBlock('ven\u200bmo me', 'zero-width character inside the word');
mustBlock('\u{1D603}\u{1D5F2}\u{1D5FB}\u{1D5FA}\u{1D5FC} me', 'styled unicode letters (bold sans "venmo")');
mustBlock('text me at five five five one two three four five six seven', 'phone number spelled out');
mustBlock('reach me at john (at) gmail (dot) com', 'email with @ and . written out');
mustBlock('john at gmail dot com', 'email written out in words');

// --- still blocked: phone numbers a human would actually write ----------------

mustBlock('call me 617-555-1234', 'separated groups');
mustBlock('(617) 555-1234', 'parenthesised area code');
mustBlock('617.555.1234', 'dot separated');
mustBlock('call me 617 555 1234', 'space separated groups, behind a cue -- a bare "250 500 1000" is a price list, not a phone');
mustBlock('+1 617 555 1234', 'country code');
mustBlock('+16175551234', 'bare international format');
mustBlock('text me at 6175551234', 'bare digits, but with an explicit "text me" cue');
mustBlock('whatsapp 6175551234', 'bare digits behind a messaging-app cue');

// --- still blocked: the ambiguous signals, once payment context is there ------

mustBlock('pay me on chime instead', 'chime with payment intent');
mustBlock('my chime tag is jdoe', 'chime with payment intent');
mustBlock('chime $50 and its yours', 'chime next to a dollar amount');
mustBlock('send it to $johndoe', 'cashtag with payment intent');
mustBlock('my cashtag is $jdoe99', 'cashtag named as a cashtag');
mustBlock('email me at jane.doe@gmail.com', 'plain email address');

// --- must NOT be blocked: ordinary $ONLYONE talk ------------------------------
// Every seed listing in data/creators.js is priced this way. The old filter
// read the platform's own ticker as a Cash App cashtag and blocked it.

mustPass('Priced at 1M $ONLYONE', 'the platform ticker is not a cashtag');
mustPass('1.5M $ONLYONE for the full set', 'the platform ticker with a price');
mustPass('tip me in $ONLYONE and I will send it over', 'ticker next to payment words');
mustPass('Priced at 12 $ONLYONE', 'the renamed ticker is not a cashtag either');
mustPass('burn $ONLYONE for VIP', 'renamed ticker next to payment words');
mustPass('$onlyone is the only thing I take here', 'ticker, lowercase');
mustPass('send to 0x991F465b9852f55722EdFb947cD1D130974c785b', 'wallet addresses stay exempt on purpose');
mustPass('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'wallet addresses stay exempt on purpose');

// --- must NOT be blocked: ordinary English that happens to name an app --------

mustPass('the wind chime on my porch', '"chime" as an ordinary word');
mustPass('she chimed in on the thread', '"chimed"');
mustPass('chime in on my wall any time', '"chime in"');
mustPass('chimera print bodysuit', '"chime" inside a longer word');
mustPass('gazelle print bikini, size S', '"zelle" inside "gazelle"');
mustPass('renee zellweger energy today', '"zelle" is not in here at all, but the old boundary-free match style would look');

// --- must NOT be blocked: long numbers, which are everywhere on this platform -

mustPass('order number 1234567890 shipped today', '10-digit order number');
mustPass('total supply is 1000000000 tokens', '10-digit token amount');
mustPass('timestamp 20260916123045', '14-digit timestamp');
mustPass('1,000,000,000 total supply, 40% locked', 'comma-grouped amount');
mustPass('burn 10000000 to hit VIP', '8-digit token amount');
mustPass('listing 4817293056 is live', 'bare id');
mustPass('posted 2026-09-16, next drop 2026-10-01', 'dates');
mustPass('I paid 500000000 for that hoodie', 'amount near the word "paid"');

// --- still blocked: a handle with a number stuck on the end -------------------
// "zelle4me"/"venmo2024" is how people actually write these, so the word
// boundary has to reject an adjacent LETTER (gazelle, chimera, paypalm) while
// still allowing an adjacent digit. A letters-and-digits boundary made
// appending one character a complete bypass.

mustBlock('zelle4me', 'app name with a number glued on');
mustBlock('venmo2024', 'app name with a year glued on');
mustBlock('cashapp2', 'app name with a digit glued on');
mustBlock('paypal1 only', 'app name with a digit glued on');
mustBlock('ZELLE2ME', 'same, uppercase');

// --- still blocked: the cue can come AFTER the number -------------------------
// "6175551234 call me" is the same message as "call me 6175551234"; only
// looking backwards for the cue made the bare-digit path a one-word step-around.

mustBlock('6175551234 call me', 'cue after the number');
mustBlock('6175551234 whatsapp', 'cue after the number');
mustBlock('text me here whenever you like 6175551234', 'cue a full clause in front of the number');

// --- must NOT be blocked: ordinary numbers that are not phone numbers ---------
// A 3-3-4 grouping split by SPACES is also how listing copy lists numbers, and
// gluing two unrelated numbers together across a space invented digit runs that
// were never there. Both now need a "call/text me" cue like every other
// ambiguous signal here.

mustPass('Bundle: 250 500 1000 tokens', 'a price list, not an area code');
mustPass('sizes: 120 180 2400', 'listing dimensions');
mustPass('ratios 16 9 1080 720 480 1920', 'video resolutions -- "720 480 1920" is a 3-3-4 grouping');
mustPass('Phone wallpaper pack, 1920 1080 and 2160 sizes', '"1920 1080" is two numbers, and "phone" is an ordinary word in listing copy');
mustPass('call 2026 09 16 my drop date', 'a date near the word "call" is not ten digits');

// --- must NOT be blocked: numbers that spell a payment app in leet ------------
// Every letter of "zelle" has a digit lookalike (z->2, e->3, l->1), so without
// a "must contain a real letter" rule the ZIP code 23113 -- a physical
// marketplace order needs a postal code -- reads as `mentions "zelle"`.

mustPass('23113', 'a bare number is not a payment app');
mustPass('Ships to zip 23113', 'real ZIP code (Midlothian, VA)');
mustPass('$231.13', 'a price');
mustPass('$23,113.00', 'a bigger price');
mustPass('Order #23113 shipped', 'an order id');
mustPass('2-3-1-1-3', 'digits with separators');

// --- must NOT be blocked: counting, and the noises people make in a DM --------
// Seven spelled-out digits in a row is NOT past what ordinary writing does, so
// the spelled-out phone pattern gets the same cue gate as a run of digits.

mustPass('one two three four five six seven', 'counting');
mustPass('count to ten: one two three four five six seven eight nine ten', 'counting further');
mustPass('Photo one, two, three, four, five, six, seven are all new', 'numbering photos');
mustPass('oh oh oh oh oh oh oh', 'this is an adult DM surface');

// --- must NOT be blocked: the word "at" in an ordinary sentence ---------------
// The spelled-out email pattern exists for "john at gmail dot com". Letting the
// bare English word "at" pair with a literal "." turned every sentence of the
// shape "<word> at <word>. <Word>" into a logged fee-dodging violation, which
// is far more common than the obfuscation it was looking for.

mustPass('New set drops at midnight. Link in bio', '"at ... . Link" is a sentence');
mustPass('Sale ends at midnight. Site gets busy', 'same shape, different TLD-shaped word');
mustPass('going live at 10. online all night', 'same shape');
mustPass("I'm really good at design. Me and my girl shoot every weekend.", 'same shape, "me" is in the TLD list');
mustPass('look at instagram.com for the rest', 'a link is not an email address');
mustPass('the auction is at kekfun.xyz', "the platform's own launch partner");
mustBlock('check me out at onlyfans.com', 'sending fans to a competing platform is the circumvention');

// --- must NOT be blocked: a two-word app name straddling a sentence break -----
// The gap between "cash" and "app" is tighter than the gap between letters
// inside a word, so a real word break (one separator) matches and a sentence
// break (". ") or a " / " does not.

mustPass('I only take cash. Apps are a hassle', '"cash." then "Apps" is two sentences');
mustPass('no cash / apps, crypto only', 'a slash is not a word break');

// --- must NOT be blocked: assorted innocent text ------------------------------

mustPass('meet me at the dot com boom party', 'not an email address');
mustPass('contact team@joinonlyone.com with questions', 'our own domain is not off-platform');
mustPass('new set drops at 9, 50% off for subs', 'prices and percentages');
mustPass('Signed 8x10 print, ships in 3-5 days', 'listing copy with numbers');
mustPass('', 'empty string');
mustPass(undefined, 'undefined input');

// --- reasons are specific enough for the admin queue to act on ----------------

mustHaveReason('hit me up on venmo', 'mentions "venmo"');
mustHaveReason('Cash App me instead', 'mentions "cash app"');
mustHaveReason('pay me on chime instead', 'mentions "chime" in a payment context');
mustHaveReason('send it to $johndoe', 'looks like a Cash App cashtag');
mustHaveReason('call me 617-555-1234', 'looks like a phone number');
mustHaveReason('text me at five five five one two three four five six seven', 'looks like a phone number written out in words');
mustHaveReason('email me at jane.doe@gmail.com', 'looks like an email address');
mustHaveReason('john at gmail dot com', 'looks like an email address');

// --- the same input twice gives the same answer -------------------------------
// Regex state leaking between calls (a module-level /g/ regex keeping its
// lastIndex) would show up here and nowhere else.

for (const text of ['hit me up on venmo', 'pay me on chime instead', 'send it to $johndoe', 'email me at jane.doe@gmail.com']) {
  const first = JSON.stringify(detectPaymentCircumvention(text));
  const second = JSON.stringify(detectPaymentCircumvention(text));
  if (first !== second) failures.push(`NOT IDEMPOTENT: ${JSON.stringify(text)} -- ${first} then ${second}`);
}

// --- a hostile input can't burn the request thread ---------------------------
// This runs on every message/bio/listing before anything is stored, so an
// unbounded quantifier over a class containing "." is a free CPU burn for
// anyone who pastes a wall of punctuation. 40k characters used to take >6s.

{
  const started = Date.now();
  detectPaymentCircumvention('.'.repeat(40000));
  const elapsed = Date.now() - started;
  if (elapsed > 1000) failures.push(`TOO SLOW: 40k punctuation characters took ${elapsed}ms (should be linear, well under a second)`);
}

// --- still blocked: the most common way a US number is written ---------------
// Mixed separators passed even right next to "text me" before (audit
// marketplace-search#10).

mustBlock('text me at 617 555-1234', 'mixed space/dash separators behind a cue');
mustBlock('my number: 617 555-1234', 'mixed separators behind "my number"');
mustBlock('call 617-555 1234 for customs', 'dash then space');
mustBlock('text me 617/555/1234', 'slash separators');
mustBlock('text me 617 555 12 34', '3-3-2-2 grouping');
mustBlock('text me 6 1 7 5 5 5 1 2 3 4', 'every digit spaced apart');
mustBlock('wa.me/16175551234', 'a WhatsApp chat link');
mustPass('call me, I paid 1,000,000,000 for that', 'comma-grouped amount next to "call" is not a phone');
mustPass('sizes 120 180 2400', 'still a size list without a cue');

// --- still blocked: the canonical contact-rail handover -----------------------
// "service: handle" needs no possessive -- nobody writes "kik:" in front of
// anything but an account name (audit marketplace-search#11).

mustBlock('snapchat: janedoe99', 'service, colon, handle');
mustBlock('add me on snap: janedoe99', 'invitation plus colon');
mustBlock('telegram: janedoe99', 'service, colon, handle');
mustBlock('kik: janedoe99', 'service, colon, handle');
mustBlock('kik: janedoe', 'plain word handle that ends the clause');
mustBlock('hmu on telegram janedoe99', 'invitation plus handle, no colon');
mustBlock('telegram: t.me/janedoe', 'telegram link');
mustBlock('t.me/janedoe', 'bare telegram link');
mustBlock('snapchat.com/add/janedoe', 'snapchat add link');
mustBlock('dm me on insta janedoe99 for $20 sets', 'instagram shorthand with a handle and a price');
mustBlock('my snap is jane_doe99', 'possessive, "is", handle-looking token');
mustBlock('my snap tag is jdoe', 'possessive, a handle noun, "is"');
// Review follow-up: dates and counting are not phone numbers, and "private"
// after a colon is not an account name.
mustPass('Shoot dates: 10 11 12 13 14 call me', 'a list of dates next to "call me"');
mustPass('call me babe 1 2 3 4 5 6 7 8 9 10', 'counting to ten');
mustBlock('text me 6-1-7-5-5-5-1-2-3-4', 'every digit split by the same separator');
mustBlock('text me 1 617 555 12 34', '3-3-2-2 with a leading country code');
mustPass('Instagram: private', 'a clause-ending "private" is not a handle');
mustPass('Snapchat: soon', 'a clause-ending "soon" is not a handle');
mustPass('find me on instagram soon.', 'an invitation followed by "soon" is not a handle');
mustBlock('Instagram: janedoe', 'a clause-ending real word after the colon is still a handle');
mustPass('Discord: private server only', 'a plain word that does not end the clause is not a handle');

// --- must NOT be blocked: the platform's own checkout, and ordinary chat ------
// (audit marketplace-search#14) The credits page itself tells people to buy
// with $USDG; a possessive plus "is <adjective>" is conversation.

mustPass('Pay with credits (buy them with $USDG on the Credits page)', 'the settlement asset is not a cashtag');
mustPass('send $ETH for gas first', 'gas talk');
mustPass('deposit $USDC then bridge', 'bridging talk');
mustPass('Photo set shot in Snapchat-style filter, my snap is cute right', '"is cute" is not a handle');
mustPass('her telegram is down again', '"is down" is not a handle');
mustPass('Our discord is private', '"is private" is not a handle');
mustPass('Our discord is private.', 'a trailing full stop does not make a word a handle');
mustPass('i love my big fluffy dog', '"ig" inside a word is not instagram');

if (failures.length) {
  console.error(`${failures.length} failure(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('payment-circumvention-filter: all checks passed');
