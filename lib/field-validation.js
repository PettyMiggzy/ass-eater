/**
 * Type and length checks for text fields that arrive straight off a request
 * body and end up stored in jsonb and rendered server-side.
 *
 * The reason this exists as its own module rather than a check per route:
 * a non-string that reaches the store is not a cosmetic bug. Several public
 * pages call `.toLowerCase()` on a creator's name and a listing's title
 * inside `getServerSideProps` -- optional chaining does not save a `{}` --
 * so one bad write from one signed-in account 500s `/search` and the
 * marketplace for every visitor on the site. `detectPaymentCircumvention`
 * cannot catch it either: it does `String(text || '')`, which turns an
 * object into the harmless-looking `"[object Object]"`.
 */

export const FIELD_LIMITS = {
  name: 80,
  handle: 40,
  bio: 1000,
  price: 40,
  payoutMethod: 24,
  walletAddress: 120,
  img: 1000,
  title: 140,
  description: 4000,
  location: 80,
};

/**
 * Checks every key of `fields` that has a limit defined and is present.
 * Returns an error string, or null when everything is acceptable.
 * Keys with no limit (booleans, numbers, already-sanitised structures) are
 * left alone -- this is deliberately not a whole-body schema.
 */
export function validateTextFields(fields, keys) {
  for (const key of keys) {
    if (!fields || !(key in fields)) continue;
    const value = fields[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string') {
      return `${key} must be text`;
    }
    const max = FIELD_LIMITS[key];
    if (max && value.length > max) {
      return `${key} must be ${max} characters or fewer`;
    }
  }
  return null;
}
