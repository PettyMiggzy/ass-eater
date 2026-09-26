import { getSessionUser, clearSessionCookie } from '../../../lib/session';
import { verifyPassword, deleteFanAccount, getSelfDeleteImpact, ACCOUNT_IS_CREATOR, ACCOUNT_HAS_OBLIGATIONS, ACCOUNT_UNDER_REVIEW, ACCOUNT_UNSHIPPED_ORDERS, BALANCE_FORFEIT } from '../../../lib/users-store';
import { effectiveUserStatus } from '../../../lib/user-moderation';
import { getBalanceCents } from '../../../lib/credits-store';
import { deliverFor, reportPushFailure } from '../../../lib/server-api';
import { consumeAttempt } from '../../../lib/rate-limit';
import { formatCredits } from '../../../lib/brand';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * POST /api/auth/delete-account { password, acknowledgeForfeit?, expectedForfeitCents?, expectedDigitalPurchases? }
 *   -> 200 { ok: true, forfeitedCents }    signed out; the account is gone
 *   -> 401 not signed in / wrong password
 *   -> 409 { code: 'BALANCE_FORFEIT', balanceCents, digitalPurchases, changed? }   a credit balance
 *          would be forfeited and/or digital items they bought would stop being viewable: re-send
 *          with acknowledgeForfeit: true PLUS expectedForfeitCents = balanceCents and
 *          expectedDigitalPurchases = digitalPurchases from this answer, after the person confirms.
 *          The acknowledgement covers exactly those amounts: if either changed by the time of the
 *          deletion (a deposit in another tab), nothing is deleted and this 409 comes back with the
 *          new amounts and `changed: true`.
 *   -> 409 { code: 'unshipped_orders', unshippedOrders }   a physical order hasn't shipped yet:
 *          refused until it ships (Privacy section 7 -- settled with them first)
 *   -> 409 { code: 'account_is_creator' }       creators: contact support (their profile,
 *          listings and money go through the admin delete)
 *   -> 409 { code: 'account_has_obligations', obligations }  earnings or a pending payout
 *   -> 409 { code: 'account_under_review' }    the account is suspended, or a possible-minor /
 *          non-consensual report against something it wrote is open: support only
 *
 * Self-service deletion for a fan account (Privacy Policy section 7) --
 * lib/users-store.js deleteFanAccount says exactly what is removed and what
 * is kept. Deposited credits are closed-loop and never refunded, so a
 * remaining balance is only forfeited after an explicit acknowledgement.
 */
const UNDER_REVIEW = { code: ACCOUNT_UNDER_REVIEW, error: 'This account is under review and cannot be deleted right now. Contact team@onlyone1.fun.' };
const unshipped = (n) => ({
  code: ACCOUNT_UNSHIPPED_ORDERS,
  unshippedOrders: n,
  error: `You have ${n} order${n === 1 ? '' : 's'} that ${n === 1 ? "hasn't" : "haven't"} shipped yet. Wait until ${n === 1 ? 'it ships' : 'they ship'} (you can follow ${n === 1 ? 'it' : 'them'} on your Orders page), or contact team@onlyone1.fun.`,
});
function forfeitPrompt(balanceCents, digitalPurchases, changed) {
  const lost = [
    balanceCents > 0 ? `your remaining ${formatCredits(balanceCents)} (credits are never refunded)` : null,
    digitalPurchases > 0 ? `access to the ${digitalPurchases} digital item${digitalPurchases === 1 ? '' : 's'} you bought` : null,
  ].filter(Boolean).join(' and ');
  const what = lost ? `Deleting your account loses ${lost}. Confirm to delete anyway.` : 'Confirm to delete your account.';
  return {
    code: BALANCE_FORFEIT,
    balanceCents,
    digitalPurchases,
    ...(changed ? { changed: true } : {}),
    error: changed ? `Your balance or purchases changed since you confirmed, so nothing was deleted. ${what}` : what,
  };
}
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res, { skip: ['password'] })) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });

  const { password, acknowledgeForfeit, expectedForfeitCents, expectedDigitalPurchases } =
    req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Enter your password to confirm.' });
  const { limited, retryAfterSeconds } = consumeAttempt(`delete-account:user:${user.id}`, { limit: MAX_ATTEMPTS, windowMs: WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  try {
    if (!(await verifyPassword(user, password))) return res.status(401).json({ error: 'Password is wrong.' });
    // A suspended account is read-only, and deleting it would erase the
    // suspension record and every message it sent. Checked again inside the
    // deletion's transaction (deleteFanAccount selfService), with open reports.
    if (effectiveUserStatus(user) !== 'active') return res.status(409).json(UNDER_REVIEW);
    // Unshipped physical orders first: that is a refusal, not something a
    // confirmation can waive (re-checked inside the deletion's transaction).
    const { unshippedOrders, digitalPurchases } = await getSelfDeleteImpact(user.id);
    if (unshippedOrders > 0) return res.status(409).json(unshipped(unshippedOrders));
    const balanceCents = await getBalanceCents(user.id);
    const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
    const acknowledged = acknowledgeForfeit === true && isCount(expectedForfeitCents) && isCount(expectedDigitalPurchases);
    if ((balanceCents > 0 || digitalPurchases > 0) && !acknowledged) {
      return res.status(409).json(forfeitPrompt(balanceCents, digitalPurchases, false));
    }
    // What the person agreed to lose -- or, with nothing to lose, nothing.
    // deleteFanAccount compares it against the locked balance, so a deposit
    // or purchase landing after this point refuses the deletion instead of
    // being forfeited unseen.
    const expectedForfeit = acknowledged
      ? { balanceCents: expectedForfeitCents, digitalPurchases: expectedDigitalPurchases }
      : { balanceCents: 0, digitalPurchases: 0 };
    const out = await deleteFanAccount(user.id, { selfService: true, expectedForfeit });
    if (!out) return res.status(401).json({ error: 'Not logged in' });
    clearSessionCookie(res);
    reportPushFailure(await deliverFor([out.deletedUserId]), `self-delete ${out.deletedUserId}`);
    return res.status(200).json({ ok: true, forfeitedCents: out.forfeitedCents });
  } catch (err) {
    if (err.code === ACCOUNT_IS_CREATOR) {
      return res.status(409).json({ code: ACCOUNT_IS_CREATOR, error: 'Creator accounts are deleted by support -- email team@onlyone1.fun.' });
    }
    if (err.code === ACCOUNT_UNDER_REVIEW) return res.status(409).json(UNDER_REVIEW);
    if (err.code === BALANCE_FORFEIT && err.forfeit) {
      return res.status(409).json(forfeitPrompt(err.forfeit.balanceCents, err.forfeit.digitalPurchases, true));
    }
    if (err.code === ACCOUNT_UNSHIPPED_ORDERS) return res.status(409).json(unshipped(err.obligations?.unshippedOrders || 1));
    if (err.code === ACCOUNT_HAS_OBLIGATIONS) {
      return res.status(409).json({ code: ACCOUNT_HAS_OBLIGATIONS, obligations: err.obligations, error: 'This account has earnings or a pending payout. Cash out or contact support first.' });
    }
    console.error('[auth/delete-account] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Nothing was deleted -- please try again.' });
  }
}
