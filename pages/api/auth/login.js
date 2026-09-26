import { findUserByEmail, verifyPassword } from '../../../lib/users-store';
import { createSessionToken, setSessionCookie } from '../../../lib/session';
import { clientNetwork, clientNetworkCoarse } from '../../../lib/rate-limit';
import {
  clearLoginCounters, consumeLoginAttempts, markLoginFailure, pruneLoginAttempts, readLoginCounters, releaseLoginAttempts,
} from '../../../lib/login-guard';
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
// The counters are shared Postgres rows (lib/login-guard.js), so every
// serverless instance sees the same budget.
const MAX_ATTEMPTS_PER_IP = 10;
// Per IPv6 /48 (IPv4: the same address, so this only adds anything for
// IPv6). Counts FAILED logins only and only brakes callers that are already
// dirty (see below), because a mobile carrier puts many subscribers in one
// /48; it exists to stop a free /48 from being 65,536 separate /64 budgets.
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
  const hasNet = net !== ip;
  const ipKey = `login:ip:${ip}`;
  const netKey = hasNet ? `login:net:${net}` : null;
  const accountKey = `login:account:${email.toLowerCase()}`;
  // Marker, not a counter: "this host has failed a login against this
  // account inside the window." Written on a wrong password below.
  const accountFromIpKey = `${accountKey}:from:${ip}`;
  // At the /48 it counts DISTINCT failing /64s (see NET_DIRTY_DISTINCT_64S).
  const accountFromNetKey = hasNet ? `${accountKey}:fromnet:${net}` : null;

  // Now and then, drop long-expired counter rows. Best-effort, never blocks.
  if (Math.random() < 0.01) pruneLoginAttempts();

  // Every brake is COUNTED here, before the bcrypt compare below, in one
  // atomic statement -- not recorded after it. Checking up here and counting
  // failures only down there is a check-then-act race: every request in a
  // parallel burst reads a count of zero while the others are still awaiting
  // bcrypt, so one Promise.all of a few hundred requests would get a few
  // hundred free guesses against a limit of 10.
  //
  // The counters live in Postgres (lib/login-guard.js), shared by every
  // serverless instance, rather than in lib/rate-limit.js's per-instance map,
  // which a flood of cheap requests elsewhere could evict (round-10
  // gates-token#1).
  let counts;
  let markers;
  try {
    const entries = [
      { name: 'ip', key: ipKey, limit: MAX_ATTEMPTS_PER_IP },
      { name: 'account', key: accountKey, limit: MAX_ATTEMPTS_PER_ACCOUNT },
    ];
    if (hasNet) entries.push({ name: 'net', key: netKey, limit: MAX_ATTEMPTS_PER_NETWORK });
    counts = await consumeLoginAttempts(entries);
    markers = await readLoginCounters([accountFromIpKey, accountFromNetKey]);
  } catch (err) {
    console.error('[auth/login] rate-limit counters unavailable:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }

  const dirtyForAccount = markers[accountFromIpKey] >= 1
    || (hasNet && markers[accountFromNetKey] >= NET_DIRTY_DISTINCT_64S);
  const refuse = async (retryAfterSeconds, giveBack) => {
    try { await releaseLoginAttempts(giveBack); } catch (err) { console.error('[auth/login] release failed:', err); }
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
  };

  // Per /64 (IPv4: per address), across every account. A refused request was
  // never let through, so nothing it touched stays counted.
  if (counts.ip.limited) return refuse(counts.ip.retryAfterSeconds, [ipKey, netKey, accountKey]);

  // Per /48. It counts FAILED logins only (a success gives its slot back
  // below), and its saturation refuses only a caller that is already dirty:
  // one whose own /64 has failed a login inside the window, or that is marked
  // for this account. A clean /64 arriving with a password always gets its
  // compare -- otherwise one party failing 100 times from ten /64s of a
  // carrier /48 locked every other subscriber in it out, the right password
  // included (round-10 gates-token#0). It still stops /64 rotation inside a
  // routed /48 from multiplying the budget: past saturation each fresh /64
  // gets one guess, and that guess makes it dirty.
  if (hasNet && counts.net.limited && (counts.ip.prior > 0 || dirtyForAccount)) {
    return refuse(counts.net.retryAfterSeconds, [ipKey, netKey, accountKey]);
  }

  // Per account, across every host, but only for a caller that has itself
  // failed against this account (see the comment at the top). Its knock still
  // costs it its /64 and /48 slots.
  if (counts.account.limited && dirtyForAccount) {
    return refuse(counts.account.retryAfterSeconds, [accountKey]);
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
