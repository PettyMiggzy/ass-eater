import { query } from './db.js';

// One accepted AgeChecker verification mints ONE age-verification cookie.
//
// /api/age-verify/confirm used to ask AgeChecker "is this uuid accepted for
// our site?" and mint a fresh 180-day cookie every time the answer was yes.
// The uuid is visible in the network tab, so one adult verifying once and
// posting it was enough for anyone, in any blocked state, to mint their own
// cookie with a one-line fetch -- forever, since an accepted verification
// stays accepted. Recording each uuid the first time it is redeemed, under a
// primary key, makes the second redemption a conflict rather than a race to
// lose.
//
// Lowercased before storing: identifiers like this are often matched
// case-insensitively by the vendor, and a case-sensitive key would let the
// same verification be replayed once per casing -- the exact bug this repo
// already shipped once with transaction hashes.
//
// Kept out of lib/age-verification.js on purpose: that file runs in proxy.js,
// and the Postgres driver must never be pulled into that bundle.

export function normalizeVerificationUuid(uuid) {
  return String(uuid).trim().toLowerCase();
}

/**
 * Atomically claim `uuid`. Resolves true if this call is the first to redeem
 * it, false if it was already redeemed. Throws only on a real database
 * failure -- the caller must treat that as "do not mint", never as success.
 */
export async function claimAgeVerificationUuid(uuid) {
  const key = normalizeVerificationUuid(uuid);
  if (!key) return false;
  const res = await query(
    'insert into age_verification_uses (uuid) values ($1) on conflict (uuid) do nothing returning uuid',
    [key],
  );
  return res.rowCount === 1;
}
