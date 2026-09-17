import { findUserByEmail, verifyPassword } from '../../../lib/users-store';
import { createSessionToken, setSessionCookie } from '../../../lib/session';
import { checkRateLimit, clearFailures, clientIp, recordFailure } from '../../../lib/rate-limit';

// Counted per IP and per targeted account, separately: the IP bucket stops
// one host spraying many accounts, the account bucket stops many hosts
// grinding one account. See lib/rate-limit.js for what this does and does
// not actually guarantee on serverless -- it is a speed bump, not a lockout.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 10;
const MAX_FAILURES_PER_ACCOUNT = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Trimmed the same way signup trims it. Signup stores the trimmed value,
  // so an identifier a phone keyboard or a paste put a stray space on was
  // being looked up here with the space still attached -- a correct
  // password failing for no visible reason. The password is NOT trimmed:
  // leading/trailing spaces are legitimate password characters.
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const ipKey = `login:ip:${clientIp(req)}`;
  const accountKey = `login:account:${email.toLowerCase()}`;
  const buckets = [
    [ipKey, MAX_FAILURES_PER_IP],
    [accountKey, MAX_FAILURES_PER_ACCOUNT],
  ];

  for (const [key, limit] of buckets) {
    const { limited, retryAfterSeconds } = checkRateLimit(key, { limit, windowMs: WINDOW_MS });
    if (limited) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
    }
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
      for (const [key, limit] of buckets) recordFailure(key, { limit, windowMs: WINDOW_MS });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    for (const [key] of buckets) clearFailures(key);

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
