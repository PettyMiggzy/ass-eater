/**
 * Cutting user text to a length without breaking a character in half.
 *
 * `String.prototype.slice` counts UTF-16 code units, and an emoji or a
 * "fancy font" letter (𝐭, 🌍) is two of them. Cutting between the two leaves a
 * lone surrogate, which JSON.stringify writes as "\ud83c" -- and Postgres's
 * jsonb parser refuses that outright ("Unicode low surrogate must follow a
 * high surrogate"). So a creator whose 61-character location had an emoji on
 * the boundary got a 500 on every save, with no hint why (round-10
 * accounts#0). Pure, and safe to import from client code.
 */

// A high surrogate not followed by a low one, or a low one not preceded by a
// high one.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `value` with any unpaired surrogate removed (so it can be stored as jsonb). */
export function stripLoneSurrogates(value) {
  return String(value ?? '').replace(LONE_SURROGATE_RE, '');
}

/**
 * At most `max` UTF-16 code units of `value` (the same budget `.slice(0, max)`
 * gave, so every existing length limit still holds), never ending on half a
 * character, and with no unpaired surrogate anywhere in it.
 */
export function sliceText(value, max) {
  let out = stripLoneSurrogates(value).slice(0, Math.max(0, max));
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/** Whether `value` is well-formed UTF-16 (no unpaired surrogate). */
export function isWellFormedText(value) {
  const s = String(value ?? '');
  return typeof s.isWellFormed === 'function' ? s.isWellFormed() : stripLoneSurrogates(s) === s;
}
