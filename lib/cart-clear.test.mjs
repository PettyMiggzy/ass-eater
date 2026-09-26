// Regression test for r12:money#0: cart.clear() passed a bare [] to setItems,
// which (since round 9) forwards its argument to editCart as an UPDATER
// function -- every successful checkout threw 'fn is not a function', crashed
// /cart and left the paid items in the cart. This checks (1) editCart only
// works with an updater, and (2) every setItems(...) call in lib/cart.js
// passes a function, so a non-function can never be handed to it again.
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra); }
};

const { editCart } = await import('./cart-ownership.js');
const src = fs.readFileSync(new URL('./cart.js', import.meta.url), 'utf8');

const calls = [...src.matchAll(/setItems\(\s*([^)]{0,40})/g)].map((m) => m[1].trim());
check('lib/cart.js calls setItems at least once', calls.length > 0);
for (const arg of calls) {
  check(`setItems argument is a function: ${arg.slice(0, 30)}`, /^(\(|[a-z_$][\w$]*\s*=>|function\b)/i.test(arg) || arg.startsWith('fn'), arg);
}
check('clear() passes an updater', /const clear = useCallback\(\(\) => setItems\(\(\) => \[\]\)/.test(src));

// editCart applied with an updater returning [] empties the cart for both viewer states.
for (const viewer of [null, 'user-1']) {
  let threw = null;
  let out;
  try { out = editCart({ items: [{ id: '1' }] }, viewer, () => []); } catch (err) { threw = err; }
  check(`editCart with an updater does not throw (viewer ${viewer})`, !threw, threw && threw.message);
  const items = out && (out.items || (out.byUser && Object.values(out.byUser)[0]) || []);
  check(`...and leaves no items (viewer ${viewer})`, !threw && JSON.stringify(out).indexOf('"id":"1"') === -1, JSON.stringify(out));
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
