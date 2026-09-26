import { requireAdminKey } from '../../../lib/admin-auth';
import { deleteFanAccount, ACCOUNT_IS_CREATOR, ACCOUNT_HAS_OBLIGATIONS } from '../../../lib/users-store';
import { deliverFor, reportPushFailure } from '../../../lib/server-api';
import { refuseMalformedText } from '../../../lib/field-validation';

/**
 * POST /api/admin/delete-user { userId, force? }   Header x-admin-key.
 *   -> 200 { ok: true, deletedUserId, forfeitedCents, obligations }
 *   -> 404 no such account
 *   -> 409 { code: 'account_is_creator' }   use /api/admin/delete (the creator profile)
 *   -> 409 { code: 'account_has_obligations', obligations }  a credit balance (it would be
 *          forfeited), withdrawable earnings, a pending payout, or a physical order of
 *          theirs not yet shipped; obligations = { balanceCents, withdrawableCents,
 *          pendingPayouts, pendingPayoutCents, unshippedOrders }. Re-send with
 *          force: true to delete anyway.
 *
 * Deletes a fan account on request (Privacy Policy section 7): the login,
 * their wall comments, the messages they sent, favorites and notifications.
 * Financial and moderation records are kept (lib/users-store.js
 * deleteFanAccount). The server/ account is told 'banned'.
 */
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdminKey(req, res)) return;
  const { userId, force } = req.body && typeof req.body === 'object' ? req.body : {};
  if ((typeof userId !== 'string' && typeof userId !== 'number') || !String(userId).trim() || String(userId).length > 100) {
    return res.status(400).json({ error: 'Missing userId' });
  }
  try {
    const out = await deleteFanAccount(String(userId).trim(), { force: force === true, strict: true });
    if (!out) return res.status(404).json({ error: 'No such account' });
    reportPushFailure(await deliverFor([out.deletedUserId]), `admin delete-user ${out.deletedUserId}`);
    console.info('[admin/delete-user] deleted', out.deletedUserId);
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    if (err.code === ACCOUNT_IS_CREATOR) {
      return res.status(409).json({ code: ACCOUNT_IS_CREATOR, error: 'That account has a creator profile -- delete the creator instead.' });
    }
    if (err.code === ACCOUNT_HAS_OBLIGATIONS) {
      return res.status(409).json({ code: ACCOUNT_HAS_OBLIGATIONS, obligations: err.obligations, error: 'That account still has a credit balance, earnings, a pending payout or an unshipped order. Resolve them, or delete with force to forfeit / leave them behind.' });
    }
    console.error('[admin/delete-user] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Nothing was deleted -- please try again.' });
  }
}
