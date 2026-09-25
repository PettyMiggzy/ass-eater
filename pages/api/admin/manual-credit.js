import { requireAdminKey } from '../../../lib/admin-auth';
import { creditDepositFromChain, TX_ALREADY_USED, BELOW_MINIMUM, ACCOUNT_GONE } from '../../../lib/deposit';
import { getMarketplaceVerificationConfig, marketplaceVerificationLive } from '../../../lib/marketplace-payment-config';
import { findUserById } from '../../../lib/users-store';
import { accountStanding, isFrozenStanding } from '../../../lib/credits-store';

/**
 * Support fallback for a fan whose payment landed on-chain but the browser
 * died before /api/credits/buy ever ran (closed tab, crashed wallet app,
 * lost connection right after broadcasting). The self-service path
 * (pages/credits.js's "Already paid?" box) covers the same case for anyone
 * who can still reach the site with the same wallet -- this exists for
 * whoever can't, and reaches an admin instead.
 *
 * Deliberately requires `fromAddress` explicitly rather than skipping the
 * sender check: the admin has to state which wallet the fan says they paid
 * from (confirmed some other way -- a support conversation, a screenshot),
 * and the on-chain check below still confirms a real transfer from that
 * exact address actually exists before anything is credited. This can't be
 * fabricated -- it can only misattribute a real payment if the admin is
 * given a wrong address, which is a support-process risk, not a code one.
 *
 * POST { userId, txHash, fromAddress, expectedLogin, creditFrozen? }
 *   expectedLogin (required): the email/username of the account the admin
 *   means to credit. 400 CONFIRM_ACCOUNT when missing (the body carries the
 *   resolved { userId, login, role } to confirm), 409 ACCOUNT_MISMATCH when it
 *   is not user `userId`'s -- both before anything is credited.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!requireAdminKey(req, res)) return;

  const config = getMarketplaceVerificationConfig();
  if (!marketplaceVerificationLive(config)) {
    return res.status(501).json({ error: 'Credits payments are not configured.' });
  }

  const { userId, txHash, fromAddress, creditFrozen, expectedLogin } = req.body && typeof req.body === 'object' ? req.body : {};
  if (expectedLogin !== undefined && expectedLogin !== null && (typeof expectedLogin !== 'string' || expectedLogin.length > 320)) {
    return res.status(400).json({ error: 'expectedLogin must be text' });
  }
  if ((typeof userId !== 'string' && typeof userId !== 'number') || !String(userId)
    || typeof txHash !== 'string' || !txHash || typeof fromAddress !== 'string' || !fromAddress) {
    return res.status(400).json({ error: 'userId, txHash, and fromAddress are all required' });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(fromAddress))) {
    return res.status(400).json({ error: 'fromAddress is not a valid wallet address' });
  }

  // Everything that touches the database runs inside the try, so a lookup
  // failure is the logged, generic 500 below rather than an unhandled rejection.
  try {
    // credit_balances/credit_ledger have no foreign key to users -- a typo'd
    // userId would otherwise silently succeed (crediting an orphan row nobody
    // can ever see, or worse, a real DIFFERENT account) and there is no
    // reversal tool: used_payment_tx permanently claims the real hash the
    // instant this succeeds, so even a caught mistake can't be resubmitted.
    // Resolving the account FIRST, before anything is credited, and echoing
    // back who it actually belongs to, is what makes this a real check
    // rather than a typo waiting to happen.
    const user = await findUserById(String(userId));
    if (!user) {
      return res.status(404).json({ error: `No account with id "${userId}" exists. Double-check it before crediting real money -- this cannot be undone once submitted.` });
    }
    // A suspended or banned account's credits are frozen: they can't be spent
    // or cashed out. Crediting one claims the hash for good and parks real
    // money where nobody can use it -- the exact case /api/credits/buy refuses
    // and sends to support. So it is refused here too, with the standing
    // spelled out, unless the admin re-sends with `creditFrozen: true` having
    // decided to anyway. There is no tool that returns USDG: once claimed, a
    // refund is a manual on-chain transfer by the owner.
    const standing = await accountStanding(String(userId));
    if (isFrozenStanding(standing) && creditFrozen !== true) {
      const rawUntil = standing.effectiveStatus === 'suspended'
        ? (standing.creator?.suspendedUntil || standing.user?.moderationUntil || null)
        : null;
      // A malformed stored date must not throw (RangeError) out of the 409.
      const until = rawUntil && Number.isFinite(Date.parse(rawUntil)) ? new Date(rawUntil).toISOString() : null;
      return res.status(409).json({
        code: 'ACCOUNT_FROZEN',
        status: standing.effectiveStatus,
        until,
        error: `That account is ${standing.effectiveStatus}${until ? ` until ${until.slice(0, 10)}` : ''}, so its credits are frozen. Crediting it claims this transaction for good and the credits can't be spent or withdrawn. Re-send with creditFrozen: true only if you have decided to anyway.`,
      });
    }

    // The echo below (creditedUserEmail) only comes back AFTER the credit has committed, when a
    // typo'd id can no longer be undone. `expectedLogin` is the login the
    // admin confirmed (the panel resolves the id with GET
    // /api/admin/user-moderation and asks first); it is REQUIRED, and a
    // mismatch refuses before anything moves -- so a stale or bypassed UI
    // cannot credit the wrong account. Matched the way sign-in matches it.
    const actualLogin = typeof user.email === 'string' ? user.email : '';
    if (typeof expectedLogin !== 'string' || !expectedLogin.trim()) {
      return res.status(400).json({
        code: 'CONFIRM_ACCOUNT',
        error: 'Confirm which account this is for: send expectedLogin (the account\'s email or username) with the credit.',
        account: { userId: String(user.id), login: actualLogin || null, role: user.role || null },
      });
    }
    if (expectedLogin.trim().toLowerCase() !== actualLogin.trim().toLowerCase()) {
      return res.status(409).json({
        code: 'ACCOUNT_MISMATCH',
        error: `User ${user.id} is not the account you confirmed. Nothing was credited -- check the user id.`,
        account: { userId: String(user.id), login: actualLogin || null, role: user.role || null },
      });
    }

    const result = await creditDepositFromChain({ userId: String(userId), txHash, expectedFrom: fromAddress, config });
    return res.status(200).json({ ok: true, ...result, creditedUserEmail: user.email, frozen: isFrozenStanding(standing) });
  } catch (err) {
    if (err.code === TX_ALREADY_USED) return res.status(409).json({ error: err.message });
    if (err.code === BELOW_MINIMUM) return res.status(400).json({ error: err.message });
    if (err.code === ACCOUNT_GONE) return res.status(404).json({ error: 'That account no longer exists -- nothing was credited and the transaction is still unused.', code: err.code });
    if (err.code === 'SENDER_MISMATCH') return res.status(400).json({ error: `That transaction was not sent from ${fromAddress}.` });
    // Same fix as pages/api/credits/buy.js: enumerate the actual known-safe
    // codes lib/chain-verify.js can throw rather than a bare `if (err.code)`,
    // which would also match a Postgres SQLSTATE or an RPC network error's
    // code and leak that raw text to whoever holds the admin key.
    if (['BAD_HASH', 'NOT_CONFIRMED', 'TX_REVERTED', 'NO_MATCHING_TRANSFER'].includes(err.code)) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[admin/manual-credit] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
