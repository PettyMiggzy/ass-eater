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
// U+0000. Well-formed UTF-16, but JSON.stringify writes it as "\u0000", which
// Postgres's jsonb input refuses (22P05), and a text parameter containing it
// is refused too (round-11 accounts#4) -- the same "can't be stored" class as
// a lone surrogate, so every helper here treats it the same way.
const NUL_RE = /\u0000/g;

/**
 * `value` with any unpaired surrogate and any NUL removed (so it can be
 * stored as jsonb). The name predates the NUL handling.
 */
export function stripLoneSurrogates(value) {
  return String(value ?? '').replace(LONE_SURROGATE_RE, '').replace(NUL_RE, '');
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

/**
 * Whether `value` can be stored as text/jsonb: well-formed UTF-16 (no
 * unpaired surrogate) and no NUL.
 */
export function isWellFormedText(value) {
  const s = String(value ?? '');
  if (s.includes('\u0000')) return false;
  return typeof s.isWellFormed === 'function' ? s.isWellFormed() : stripLoneSurrogates(s) === s;
}

/**
 * Walks a request body (or query) and returns the path of the first string --
 * value OR object key -- that isWellFormedText refuses ('' for a bare string
 * at the top), or null when everything is storable. `skip` names top-level
 * keys to leave alone (an EXISTING password being checked, which must be
 * compared exactly as typed, never refused). Buffers and typed arrays are
 * skipped; nesting past `maxDepth` is not walked (nothing stores it).
 */
export function findMalformedText(value, { skip = [], maxDepth = 8 } = {}) {
  const walk = (v, path, depth) => {
    if (typeof v === 'string') return isWellFormedText(v) ? null : path;
    if (!v || typeof v !== 'object' || depth > maxDepth) return null;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return null;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const hit = walk(v[i], path ? `${path}.${i}` : String(i), depth + 1);
        if (hit !== null) return hit;
      }
      return null;
    }
    for (const key of Object.keys(v)) {
      if (depth === 0 && skip.includes(key)) continue;
      const at = path ? `${path}.${key}` : key;
      if (!isWellFormedText(key)) return path ? `${path}.?` : '?';
      const hit = walk(v[key], at, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(value, '', 0);
}
