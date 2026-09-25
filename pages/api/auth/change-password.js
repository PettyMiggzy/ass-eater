import { getSessionUser, createSessionToken, setSessionCookie } from '../../../lib/session';
import { changePassword, WRONG_PASSWORD } from '../../../lib/users-store';
import { consumeAttempt } from '../../../lib/rate-limit';

/**
 * POST /api/auth/change-password { currentPassword, newPassword }
 *   -> 200 { ok: true }      (this browser stays signed in; every other session is signed out)
 *   -> 400 { error }         new password too short/long
 *   -> 401 not signed in, or current password wrong (same message either way)
 *   -> 429 too many attempts
 *
 * There was no way at all to change a password. A forgotten-password reset
 * needs an email provider and is not built.
 */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const { currentPassword, newPassword } = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Enter your current password and a new one.' });
  }
  // Guessing the current password from a hijacked session is the attack this
  // bounds, so it is per account.
  const { limited, retryAfterSeconds } = consumeAttempt(`change-password:user:${user.id}`, { limit: MAX_ATTEMPTS, windowMs: WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  try {
    const sessionVersion = await changePassword(user.id, currentPassword, newPassword);
    setSessionCookie(res, createSessionToken(user.id, sessionVersion));
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err.code === WRONG_PASSWORD) return res.status(401).json({ error: 'Current password is wrong.' });
    if (err.code === 'bad_password') return res.status(400).json({ error: err.message });
    console.error('[auth/change-password] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
