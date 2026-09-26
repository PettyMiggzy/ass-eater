// Regression tests for the round-18 public/dashboard UI fixes (package R18U1)
// that are pure logic (no database):
//  - dashboard#0: trackingFormatWarning's post-save wording ({ saved: true })
//    never says "before saving" (the order is already saved); the live
//    pre-save hint keeps it; the other notes read the same either way.
//  - public-pages#1: feeWaiverActive, which the creator page uses to tell a
//    fan a message goes to a Founding Creator "in full", is true only inside
//    the window.
//
// Run with:
//   node --import ./test-register.mjs lib/r18u1.test.mjs

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) { passed += 1; console.log(`  PASS ${name}`); } else { failed += 1; console.log(`  FAIL ${name}`); }
}

const rules = await import('./tracking-rules.js');
const founding = await import('./founding.js');

// dashboard#0
const ups = { carrier: 'UPS', trackingNumber: '123456789012' };
const pre = rules.trackingFormatWarning(ups);
const post = rules.trackingFormatWarning(ups, { saved: true });
check('pre-save hint asks to double-check before saving', typeof pre === 'string' && /before saving/.test(pre));
check('post-save wording is still a warning', typeof post === 'string' && /usual UPS number/.test(post));
check('post-save wording never says "before saving"', !/before saving/i.test(post));
check('a usual number has no post-save warning', rules.trackingFormatWarning({ carrier: 'UPS', trackingNumber: '1Z999AA10123456784' }, { saved: true }) === null);
const short = { carrier: 'Other', trackingNumber: 'ZF8YY6HP' };
check('other notes read the same after a save',
  rules.trackingFormatWarning(short) === rules.trackingFormatWarning(short, { saved: true })
  && !/before saving/i.test(rules.trackingFormatWarning(short, { saved: true }) || ''));

// public-pages#1
const since = '2026-10-01T00:00:00.000Z';
const fc = { founding: true, foundingSince: since };
const start = founding.feeWaiverStartsAt(fc);
check('a founding creator has a waiver start', start instanceof Date);
if (start) {
  check('waived inside the window', founding.feeWaiverActive(fc, start.getTime() + 1000) === true);
  check('not waived after the window', founding.feeWaiverActive(fc, start.getTime() + 31 * 86400000) === false);
}
check('never waived for a non-founding creator', founding.feeWaiverActive({ founding: false, foundingSince: since }, Date.parse(since) + 1000) === false);

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
if (failed) process.exit(1);
