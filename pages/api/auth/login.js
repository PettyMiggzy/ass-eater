import { findUserByEmail, verifyPassword } from '../../../lib/users-store';
import { createSessionToken, setSessionCookie } from '../../../lib/session';
import { clientNetwork, clientNetworkCoarse } from '../../../lib/rate-limit';
import {
  loginGuardKeys, clearLoginCounters, consumeLoginAttempts, markLoginFailure, pruneLoginAttempts, readLoginCounters, releaseLoginAttempts,
} from '../../../lib/login-guard';
import { effectiveUserStatus } from '../../../lib/user-moderation';
import { EMAIL_IDENTIFIER_MAX, PASSWORD_MAX, refuseMalformedText } from '../../../lib/field-validation';
import { refuseCrossSite } from '../../../lib/same-origin';

// The login brakes -- ONE design, settled in round 11. Every counter is a
// shared Postgres row (lib/login-guard.js) with a fixed 15-minute window, so
// every serverless instance sees the same budget:
//
// - Per /64 (IPv4: per address), across every account: 10 attempts. Counted
//   BEFORE the compare; a successful login gives its own slot back, so in
//   effect it counts failures (plus attempts in flight).
// - Per /48 (IPv6 only), across every account: 100, counted the same way.
//   A saturated /48 refuses EVERY caller in it before the compare, clean
//   /64s included. That is the only way the /48 bounds anything: round 10
//   let a clean /64 through a saturated /48, and a routed /48 is 65,536
//   clean /64s, i.e. ~65k password-spray guesses per window (round-11
//   gates-token#0). The accepted trade-off: someone failing 100 logins from
//   a mobile carrier's shared /48 blocks that /48's other subscribers from
//   logging in until the window ends.
// - Per account, across every host: 10. This one refuses only a caller that
//   has itself failed against this account ACCOUNT_OWN_FAILURE_ALLOWANCE
//   times inside the window (per /64), or whose /48 has had
//   NET_DIRTY_DISTINCT_64S different /64s fail against it. A plain
//   per-account block is a lockout weapon -- anyone who knows your username
//   can fail logins at it, and there is no password-reset route to escape
//   through -- so the owner, arriving with the right password and at most a
//   typo or two behind them, always gets a compare (round-11 gates-token#1).
//   The accepted trade-off: an owner who mistypes three times while someone
//   else keeps the account saturated waits out the rest of their own 15-minute
//   marker window, never longer (the marker expires on its own; it is not
//   renewed by the attacker).
//
// Order matters for cost (round-11 gates-token#3): the /64 and /48 are
// counted first, in one statement; a caller already over either is refused
// right there, and the account row is never created for it.
const MAX_ATTEMPTS_PER_IP = 10;
const MAX_ATTEMPTS_PER_NETWORK = 100;
const MAX_ATTEMPTS_PER_ACCOUNT = 10;
// How many failures one /64 may itself have against an account before a
// saturated account counter refuses it. More than one, so the owner's own
// typo does not lock them out behind an attacker's saturation.
const ACCOUNT_OWN_FAILURE_ALLOWANCE = 3;
// How many DIFFERENT /64s of one /48 must have failed against an account
// before the whole /48 counts as dirty for it. One is not enough: a carrier
// puts many subscribers in one /48, and a single neighbour failing once must
// not lock everyone else in it out of their own account.
const NET_DIRTY_DISTINCT_64S = 3;

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res, { skip: ['password'] })) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Login CSRF (round-14 gates-token#0): a cross-site form must not be able
  // to sign a visitor into someone else's account (lib/same-origin.js).
  if (refuseCrossSite(req, res)) return;

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
  // the rate-limit keys (hashed before storage, but hashing a megabyte is
  // still work), then looked up in the database and, with the password, run
  // through bcrypt -- so an unbounded one let a spray of megabyte identifiers
  // from rotating addresses burn an instance's memory and CPU. Nothing
  // longer can exist: signup refuses both past these same limits (a username
  // is shorter still).
  if (email.length > EMAIL_IDENTIFIER_MAX || password.length > PASSWORD_MAX) {
    return res.status(400).json({ error: 'Invalid email or password' });
  }

  // Bucketed per NETWORK (an IPv6 /64, an IPv4 address as is), not per exact
  // address: one IPv6 customer can source requests from any of 2^64
  // addresses, so a per-/128 key gave every request a fresh per-IP budget
  // AND a clean "dirty" marker below (round-8 gates-token#0). See
  // lib/rate-limit.js clientNetwork. The /48 is counted too (see the top of
  // this file). For IPv4 both are the same address and only one is counted.
  const ip = clientNetwork(req);
  const net = clientNetworkCoarse(req);
  const hasNet = net !== ip;
  // Markers, not budgets: accountFromIpKey counts how many times this /64 has
  // failed a login against this account inside the window (written on a wrong
  // password below), accountFromNetKey how many DISTINCT /64s of this /48
  // have. The identifier enters every key only as a fixed-length digest, so
  // a crafted identifier can never name another key (round-16 gates-token#0,
  // lib/login-guard.js loginGuardKeys).
  const { ipKey, netKey, accountKey, accountFromIpKey, accountFromNetKey } =
    loginGuardKeys({ identifier: email, ip, net: hasNet ? net : null });

  // Now and then, drop long-expired counter rows. Best-effort, never blocks.
  if (Math.random() < 0.01) pruneLoginAttempts();

  const refuse = async (retryAfterSeconds, giveBack) => {
    try { await releaseLoginAttempts(giveBack); } catch (err) { console.error('[auth/login] release failed:', err); }
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
  };

  // Every brake is COUNTED before the bcrypt compare, atomically -- not
  // recorded after it. Checking up here and counting failures only down
  // there is a check-then-act race: every request in a parallel burst reads
  // a count of zero while the others are still awaiting bcrypt.
  //
  // Step 1: the host's own budgets (/64 and /48), in one statement. A refused
  // request was never let through, so both are given back -- and the account
  // row is never touched for it, so a refused host looping over random
  // identifiers creates no rows (round-11 gates-token#3).
  let hostCounts;
  try {
    const hostEntries = [{ name: 'ip', key: ipKey, limit: MAX_ATTEMPTS_PER_IP }];
    if (hasNet) hostEntries.push({ name: 'net', key: netKey, limit: MAX_ATTEMPTS_PER_NETWORK });
    hostCounts = await consumeLoginAttempts(hostEntries);
  } catch (err) {
    console.error('[auth/login] rate-limit counters unavailable:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
  if (hostCounts.ip.limited) return refuse(hostCounts.ip.retryAfterSeconds, [ipKey, netKey]);
  if (hasNet && hostCounts.net.limited) return refuse(hostCounts.net.retryAfterSeconds, [ipKey, netKey]);

  // Step 2: the account budget, and this host's own failure markers for it.
  let accountCount;
  let markers;
  try {
    accountCount = (await consumeLoginAttempts([{ name: 'account', key: accountKey, limit: MAX_ATTEMPTS_PER_ACCOUNT }])).account;
    markers = await readLoginCounters([accountFromIpKey, accountFromNetKey]);
  } catch (err) {
    console.error('[auth/login] rate-limit counters unavailable:', err);
    try { await releaseLoginAttempts([ipKey, netKey]); } catch { /* logged above */ }
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  // Per account, across every host, but only for a caller that has itself
  // failed against this account often enough (see the top of this file). Its
  // knock still costs it its /64 and /48 slots.
  const dirtyForAccount = markers[accountFromIpKey] >= ACCOUNT_OWN_FAILURE_ALLOWANCE
    || (hasNet && markers[accountFromNetKey] >= NET_DIRTY_DISTINCT_64S);
  if (accountCount.limited && dirtyForAccount) {
    return refuse(accountCount.retryAfterSeconds, [accountKey]);
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
      // Counts this failure against this host for this account, which is
      // what (past ACCOUNT_OWN_FAILURE_ALLOWANCE) makes the per-account brake
      // above apply to it.
      // The /48 marker counts this /64 only the first time it fails in the
      // window, so one neighbour cannot make its whole /48 dirty alone. "First"
      // is what the atomic write of the /64 marker returns, not the snapshot
      // read before bcrypt: a parallel burst from one /64 all read "clean"
      // there, and each used to add itself to the /48 count (round-10 fix-up).
      try {
        const failuresFromThis64 = await markLoginFailure(accountFromIpKey);
        if (hasNet && failuresFromThis64 === 1) await markLoginFailure(accountFromNetKey);
      } catch (err) {
        console.error('[auth/login] could not record failure marker:', err);
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // A successful login clears this ACCOUNT's keys, so its owner always
    // leaves a clean record behind them. The per-IP bucket is NOT cleared --
    // it is the only brake on spraying one password across many accounts, and
    // wiping it on success let a host holding any valid account log in after
    // every 9 failed guesses and never trip it. Only this request's own hit is
    // taken back, so successful logins from a shared IP (carrier NAT, an
    // office) never count against it, while failures still do.
    try {
      await releaseLoginAttempts([ipKey, netKey]);
      await clearLoginCounters([accountKey, accountFromIpKey, accountFromNetKey]);
    } catch (err) {
      console.error('[auth/login] could not reset counters after a good login:', err);
    }

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
