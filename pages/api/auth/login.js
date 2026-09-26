import { findUserByEmail, verifyPassword } from '../../../lib/users-store';
import { createSessionToken, setSessionCookie } from '../../../lib/session';
import { checkRateLimit, clearFailures, clientNetwork, clientNetworkCoarse, consumeAttempt, recordFailure, refundAttempt } from '../../../lib/rate-limit';
import { effectiveUserStatus } from '../../../lib/user-moderation';
import { EMAIL_IDENTIFIER_MAX, PASSWORD_MAX } from '../../../lib/field-validation';

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
// Per IPv6 /48 (IPv4: the same address, so this only adds anything for
// IPv6). Generous, because a mobile carrier puts many subscribers in one /48;
// it exists to stop a free /48 from being 65,536 separate /64 budgets.
const MAX_ATTEMPTS_PER_NETWORK = 100;
const MAX_ATTEMPTS_PER_ACCOUNT = 10;
// How many DIFFERENT /64s of one /48 must have failed against an account
// before the whole /48 counts as dirty for it. One is not enough: a carrier
// puts many subscribers in one /48, and a single neighbour failing once must
// not lock everyone else in it out of their own account. Three still caps a
// party holding the whole /48 at a handful of guesses per saturated account.
const NET_DIRTY_DISTINCT_64S = 3;

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
  // Bounded BEFORE anything below sees them. The identifier is embedded in
  // two in-memory rate-limit keys (and the limiter's map is capped by key
  // COUNT, not bytes), then looked up in the database and, with the password,
  // run through bcrypt -- so an unbounded one let a spray of megabyte
  // identifiers from rotating addresses exhaust an instance's memory. Nothing
  // longer can exist: signup refuses both past these same limits (a username
  // is shorter still).
  if (email.length > EMAIL_IDENTIFIER_MAX || password.length > PASSWORD_MAX) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  // Bucketed per NETWORK (an IPv6 /64, an IPv4 address as is), not per exact
  // address: one IPv6 customer can source requests from any of 2^64
  // addresses, so a per-/128 key gave every request a fresh per-IP budget
  // AND a clean "dirty" marker below -- unlimited sequential guesses at one
  // account (round-8 gates-token#0). See lib/rate-limit.js clientNetwork.
  //
  // A /64 is not the smallest unit one party controls either (a free routed
  // /48 is 65,536 of them), so the "dirty" marker is also written and checked
  // at the /48, and the /48 gets a generous per-network budget of its own
  // (round-9 gates-token#0): rotating /64s inside one allocation neither
  // resets the marker nor multiplies the budget. The /48 marker needs
  // NET_DIRTY_DISTINCT_64S different failing /64s, not one, so a neighbour on
  // a shared carrier /48 cannot lock others out alone. For IPv4 both keys are
  // the same address.
  const ip = clientNetwork(req);
  const net = clientNetworkCoarse(req);
  const ipKey = `login:ip:${ip}`;
  const netKey = `login:net:${net}`;
  const accountKey = `login:account:${email.toLowerCase()}`;
  // Marker, not a counter: "this host has failed a login against this
  // account inside the window." Written on a wrong password below.
  const accountFromIpKey = `${accountKey}:from:${ip}`;
  // At the /48 it counts DISTINCT failing /64s (see NET_DIRTY_DISTINCT_64S).
  const accountFromNetKey = `${accountKey}:fromnet:${net}`;
  const hasNet = net !== ip;

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
  if (hasNet) {
    const perNet = consumeAttempt(netKey, { limit: MAX_ATTEMPTS_PER_NETWORK, windowMs: WINDOW_MS });
    if (perNet.limited) {
      // This request was never let through, so its /64 hit is taken back.
      refundAttempt(ipKey);
      res.setHeader('Retry-After', String(perNet.retryAfterSeconds));
      return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
    }
  }

  const perAccount = consumeAttempt(accountKey, { limit: MAX_ATTEMPTS_PER_ACCOUNT, windowMs: WINDOW_MS });
  const dirty = checkRateLimit(accountFromIpKey, { limit: 1, windowMs: WINDOW_MS }).limited
    || (hasNet && checkRateLimit(accountFromNetKey, { limit: NET_DIRTY_DISTINCT_64S, windowMs: WINDOW_MS }).limited);
  if (perAccount.limited && dirty) {
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
      // The /48 marker counts this /64 only the first time it fails in the
      // window, so one neighbour cannot make its whole /48 dirty alone.
      const firstFromThis64 = !checkRateLimit(accountFromIpKey, { limit: 1, windowMs: WINDOW_MS }).limited;
      recordFailure(accountFromIpKey, { limit: 1, windowMs: WINDOW_MS });
      if (hasNet && firstFromThis64) recordFailure(accountFromNetKey, { limit: NET_DIRTY_DISTINCT_64S, windowMs: WINDOW_MS });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // A successful login clears this ACCOUNT's keys, so its owner always
    // leaves a clean record behind them. The per-IP bucket is NOT cleared --
    // it is the only brake on spraying one password across many accounts, and
    // wiping it on success let a host holding any valid account log in after
    // every 9 failed guesses and never trip it. Only this request's own hit is
    // taken back, so successful logins from a shared IP (carrier NAT, an
    // office) never count against it, while failures still do.
    refundAttempt(ipKey);
    if (hasNet) refundAttempt(netKey);
    clearFailures(accountKey);
    clearFailures(accountFromIpKey);
    if (hasNet) clearFailures(accountFromNetKey);

    // A banned account cannot sign in (lib/user-moderation.js). Only said
    // after a correct password, so it reveals nothing to a guesser.
    if (effectiveUserStatus(user) === 'banned') {
      return res.status(403).json({ error: 'This account has been banned and can no longer sign in.' });
    }

    const token = createSessionToken(user.id, user.sessionVersion);
    setSessionCookie(res, token);

    return res.status(200).json({
      ok: true,
      user: { id: user.id, email: user.email, role: user.role, creatorId: user.creatorId },
    });
  } catch (err) {
    console.error('[auth/login] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
