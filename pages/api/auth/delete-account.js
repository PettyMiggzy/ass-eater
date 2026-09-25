import { getSessionUser, clearSessionCookie } from '../../../lib/session';
import { verifyPassword, deleteFanAccount, ACCOUNT_IS_CREATOR, ACCOUNT_HAS_OBLIGATIONS } from '../../../lib/users-store';
import { getBalanceCents } from '../../../lib/credits-store';
import { deliverFor, reportPushFailure } from '../../../lib/server-api';
import { consumeAttempt } from '../../../lib/rate-limit';

/**
 * POST /api/auth/delete-account { password, acknowledgeForfeit? }
 *   -> 200 { ok: true, forfeitedCents }    signed out; the account is gone
 *   -> 401 not signed in / wrong password
 *   -> 409 { code: 'BALANCE_FORFEIT', balanceCents }   a credit balance would be forfeited:
 *          re-send with acknowledgeForfeit: true after the person confirms
 *   -> 409 { code: 'account_is_creator' }       creators: contact support (their profile,
 *          listings and money go through the admin delete)
 *   -> 409 { code: 'account_has_obligations', obligations }  earnings or a pending payout
 *
 * Self-service deletion for a fan account (Privacy Policy section 7) --
 * lib/users-store.js deleteFanAccount says exactly what is removed and what
 * is kept. Deposited credits are closed-loop and never refunded, so a
 * remaining balance is only forfeited after an explicit acknowledgement.
 */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const { password, acknowledgeForfeit } = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Enter your password to confirm.' });
  const { limited, retryAfterSeconds } = consumeAttempt(`delete-account:user:${user.id}`, { limit: MAX_ATTEMPTS, windowMs: WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  try {
    if (!(await verifyPassword(user, password))) return res.status(401).json({ error: 'Password is wrong.' });
    const balanceCents = await getBalanceCents(user.id);
    if (balanceCents > 0 && acknowledgeForfeit !== true) {
      return res.status(409).json({
        code: 'BALANCE_FORFEIT',
        balanceCents,
        error: `Your ${balanceCents} remaining credits will be lost -- credits are never refunded. Confirm to delete anyway.`,
      });
    }
    const out = await deleteFanAccount(user.id);
    if (!out) return res.status(401).json({ error: 'Not logged in' });
    clearSessionCookie(res);
    reportPushFailure(await deliverFor([out.deletedUserId]), `self-delete ${out.deletedUserId}`);
    return res.status(200).json({ ok: true, forfeitedCents: out.forfeitedCents });
  } catch (err) {
    if (err.code === ACCOUNT_IS_CREATOR) {
      return res.status(409).json({ code: ACCOUNT_IS_CREATOR, error: 'Creator accounts are deleted by support -- email team@onlyone1.fun.' });
    }
    if (err.code === ACCOUNT_HAS_OBLIGATIONS) {
      return res.status(409).json({ code: ACCOUNT_HAS_OBLIGATIONS, obligations: err.obligations, error: 'This account has earnings or a pending payout. Cash out or contact support first.' });
    }
    console.error('[auth/delete-account] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Nothing was deleted -- please try again.' });
  }
}
