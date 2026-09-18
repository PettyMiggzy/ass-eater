import { findUserByEmail, verifyPassword } from '../../../lib/users-store';
import { createSessionToken, setSessionCookie } from '../../../lib/session';
import { checkRateLimit, clearFailures, clientIp, consumeAttempt, recordFailure } from '../../../lib/rate-limit';

// Two brakes, and both of them are aimed at the host doing the guessing
// rather than at the account being guessed at:
//
// - Per IP, across every account: stops one host spraying many accounts.
// - Per account, across every host: stops many hosts grinding one account.
//   This one only blocks callers that have themselves failed a login
//   against that account recently. A plain per-account block is a lockout
//   weapon, not just a speed bump: anyone who knows your username can fail
//   logins at it on purpose, the 429 comes back before the password is
//   even looked at (so a correct password can't clear it), and there is no
//   password-reset route anywhere on this site to escape through -- the
//   real owner is simply shut out of their own dashboard for as long as
//   the attacker keeps knocking. Requiring the caller to be "dirty" for
//   that account keeps the defence (saturating the bucket takes failures,
//   and failing is exactly what marks you) while never catching the owner,
//   who shows up with the right password and a clean record. Past
//   saturation a fresh host gets one sequential guess at this account
//   instead of a full budget -- though a host firing in parallel still
//   gets its per-IP budget, since the mark only lands once a compare has
//   come back. The per-IP brake is what bounds that case.
//
// See lib/rate-limit.js for what this does and does not guarantee on
// serverless -- it is a speed bump, not a hard lockout.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_IP = 10;
const MAX_ATTEMPTS_PER_ACCOUNT = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Trimmed the same way signup trims it. Signup stores the trimmed value,
  // so an identifier a phone keyboard or a paste put a stray space on was
  // being looked up here with the space still attached -- a correct
  // password failing for no visible reason. findUserByEmail trims the
  // stored side too, for accounts created before signup started trimming.
  // The password is NOT trimmed: leading/trailing spaces are legitimate
  // password characters.
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const ip = clientIp(req);
  const ipKey = `login:ip:${ip}`;
  const accountKey = `login:account:${email.toLowerCase()}`;
  // Marker, not a counter: "this host has failed a login against this
  // account inside the window." Written on a wrong password below.
  const accountFromIpKey = `${accountKey}:from:${ip}`;

  // Counted here, BEFORE the bcrypt compare below -- not recorded after it.
  // Checking up here and only counting failures down there is a
  // check-then-act race: every request in a parallel burst reads a count of
  // zero while the others are still awaiting bcrypt, so one Promise.all of
  // a few hundred requests gets a few hundred free guesses against a limit
  // of 10. consumeAttempt checks and counts in one synchronous step.
  const perIp = consumeAttempt(ipKey, { limit: MAX_ATTEMPTS_PER_IP, windowMs: WINDOW_MS });
  if (perIp.limited) {
    res.setHeader('Retry-After', String(perIp.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
  }

  const perAccount = consumeAttempt(accountKey, { limit: MAX_ATTEMPTS_PER_ACCOUNT, windowMs: WINDOW_MS });
  if (perAccount.limited && checkRateLimit(accountFromIpKey, { limit: 1, windowMs: WINDOW_MS }).limited) {
    res.setHeader('Retry-After', String(perAccount.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
  }

  try {
    const user = await findUserByEmail(email);
    // Both operands are evaluated on purpose -- verifyPassword runs a
    // bcrypt compare against a dummy hash when `user` is null, so an
    // unknown login costs the same as a known one. Short-circuiting on
    // `!user` would put the timing oracle straight back (see
    // lib/users-store.js's verifyPassword).
    const passwordOk = await verifyPassword(user, password);
    if (!user || !passwordOk) {
      // Marks this host dirty for this account, which is what makes the
      // per-account brake above apply to it.
      recordFailure(accountFromIpKey, { limit: 1, windowMs: WINDOW_MS });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // A successful login clears all three, so one shared IP (carrier NAT,
    // an office) isn't stuck for 15 minutes because one person fat-fingered
    // their password, and the account's own owner always leaves a clean
    // record behind them.
    clearFailures(ipKey);
    clearFailures(accountKey);
    clearFailures(accountFromIpKey);

    const token = createSessionToken(user.id, user.sessionVersion);
    setSessionCookie(res, token);

    return res.status(200).json({
      ok: true,
      user: { id: user.id, email: user.email, role: user.role, creatorId: user.creatorId },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
