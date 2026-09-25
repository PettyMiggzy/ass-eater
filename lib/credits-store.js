import { getAddress } from 'viem';
import { payoutWalletError } from './field-validation';
import { query, withTransaction } from './db';
import { createNotification } from './notifications-store';
import { effectiveCreatorStatus, isDemoCreator } from './creator-status';
import { feeWaiverActive } from './founding';
import { MIN_PAYOUT_CENTS } from './fees';
import { effectiveUserStatus } from './user-moderation';

export const INSUFFICIENT_BALANCE = 'insufficient_balance';
// Enough credits in total, but not enough of them EARNED. Deposited credits
// are closed-loop -- spendable here, never cashed back out -- so a payout
// is capped at the withdrawable part of the balance only.
export const INSUFFICIENT_WITHDRAWABLE = 'insufficient_withdrawable';
// The payer is a creator account that is banned or suspended: its balance
// is frozen (see accountStanding below).
export const ACCOUNT_FROZEN = 'account_frozen';
// The would-be recipient of a charge is not a creator who can be paid right
// now (not active, a demo/seed profile, or not a creator at all).
export const RECIPIENT_UNAVAILABLE = 'recipient_unavailable';
// A cash-out was asked for by an account that may not cash out.
export const PAYOUT_NOT_ALLOWED = 'payout_not_allowed';
// An admin tried to mark paid a request whose owner is no longer in good
// standing, without explicitly overriding.
export const PAYOUT_FROZEN = 'payout_frozen';
// The same on-chain transaction was already recorded as proof for another
// payout (payout_requests_tx_hash_lower_idx).
export const TX_HASH_REUSED = 'tx_hash_reused';
export const INVALID_PAYOUT_WALLET = 'invalid_payout_wallet';
export const PAYOUT_NOT_PENDING = 'payout_not_pending';

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function assertCents(cents, { allowZero = false } = {}) {
  if (!Number.isInteger(cents) || cents < 0 || (!allowZero && cents === 0)) {
    throw new Error(`Invalid credit amount: ${cents}`);
  }
}

/** A user's current credit balance, in cents. 0 for a user who's never bought credits. */
export async function getBalanceCents(userId) {
  const { rows } = await query('select balance_cents from credit_balances where user_id = $1', [String(userId)]);
  return rows.length ? Number(rows[0].balance_cents) : 0;
}

/**
 * The part of a user's balance that may leave the platform as a payout:
 * credits EARNED from someone else's spend, less anything already reserved
 * for a payout or spent. Never more than the balance itself.
 */
export async function getWithdrawableCents(userId) {
  const { rows } = await query('select withdrawable_cents from credit_balances where user_id = $1', [String(userId)]);
  return rows.length ? Number(rows[0].withdrawable_cents) : 0;
}

export async function getBalanceSummary(userId) {
  const { rows } = await query('select balance_cents, withdrawable_cents from credit_balances where user_id = $1', [String(userId)]);
  if (!rows.length) return { balanceCents: 0, withdrawableCents: 0 };
  return { balanceCents: Number(rows[0].balance_cents), withdrawableCents: Number(rows[0].withdrawable_cents) };
}

/**
 * Increments a user's balance and writes the ledger row in one transaction
 * -- a balance change with no explanation next to it is exactly the kind of
 * thing that's impossible to reconcile later. Runs inside the caller's
 * transaction (`client`) when given one, so a deposit's balance credit and
 * its used_payment_tx claim commit or roll back together.
 *
 * `withdrawable: true` marks the credits as EARNED (another user's spend,
 * or a refunded payout reservation) -- only those may later be cashed out.
 * Everything else (deposits, manual support credits) is spend-only.
 */
export async function creditAccount({ userId, cents, type, meta = {}, withdrawable = false }, client = null) {
  assertCents(cents, { allowZero: true });
  const run = async (c) => {
    const w = withdrawable ? cents : 0;
    await c.query(
      `insert into credit_balances (user_id, balance_cents, withdrawable_cents, updated_at)
       values ($1, $2, $3, now())
       on conflict (user_id) do update
         set balance_cents = credit_balances.balance_cents + $2,
             withdrawable_cents = credit_balances.withdrawable_cents + $3,
             updated_at = now()`,
      [String(userId), cents, w],
    );
    await c.query(
      'insert into credit_ledger (user_id, type, amount_cents, meta) values ($1, $2, $3, $4)',
      [String(userId), type, cents, JSON.stringify(meta)],
    );
  };
  return client ? run(client) : withTransaction(run);
}

/**
 * Decrements a user's balance, but only if they actually have enough --
 * checked and applied in the same guarded UPDATE (`where balance_cents >=
 * $2`), not a separate read-then-write, so two concurrent spends can't both
 * pass a balance check that only one of them can actually afford. Throws
 * INSUFFICIENT_BALANCE (as `.code`) rather than silently going negative.
 *
 * An ordinary spend consumes the NON-withdrawable part of the balance first
 * (withdrawable becomes least(withdrawable, new balance)): a creator who is
 * also a fan spends their own deposits before their earnings. All SET
 * expressions read the row's old values, so this is one atomic step.
 *
 * `fromWithdrawable: true` (payout reservations only) requires and consumes
 * withdrawable credits specifically, and throws INSUFFICIENT_WITHDRAWABLE
 * when the balance is there but was deposited rather than earned.
 */
export async function debitAccount({ userId, cents, type, meta = {}, fromWithdrawable = false }, client = null) {
  assertCents(cents);
  const run = async (c) => {
    const { rows } = fromWithdrawable
      ? await c.query(
          `update credit_balances
              set balance_cents = balance_cents - $2,
                  withdrawable_cents = withdrawable_cents - $2,
                  updated_at = now()
            where user_id = $1 and balance_cents >= $2 and withdrawable_cents >= $2
            returning balance_cents`,
          [String(userId), cents],
        )
      : await c.query(
          `update credit_balances
              set balance_cents = balance_cents - $2,
                  withdrawable_cents = least(withdrawable_cents, balance_cents - $2),
                  updated_at = now()
            where user_id = $1 and balance_cents >= $2
            returning balance_cents`,
          [String(userId), cents],
        );
    if (!rows.length) {
      if (fromWithdrawable) {
        const { rows: cur } = await c.query('select balance_cents from credit_balances where user_id = $1', [String(userId)]);
        if (cur.length && Number(cur[0].balance_cents) >= cents) {
          throw Object.assign(
            new Error('Only credits you earned from fans can be cashed out -- credits you bought are spend-only.'),
            { code: INSUFFICIENT_WITHDRAWABLE },
          );
        }
      }
      throw Object.assign(new Error('Not enough credits'), { code: INSUFFICIENT_BALANCE });
    }
    await c.query(
      'insert into credit_ledger (user_id, type, amount_cents, meta) values ($1, $2, $3, $4)',
      [String(userId), type, -cents, JSON.stringify(meta)],
    );
  };
  return client ? run(client) : withTransaction(run);
}

/**
 * Who a user account is, money-wise: the account row and, for a creator
 * account, its creator record (with `effectiveStatus` resolved against the
 * clock, the same way every other gate does). `lock` takes a share lock on
 * the creator row, so a ban or approval landing concurrently waits for this
 * transaction instead of racing the check.
 */
export async function accountStanding(userId, client, { lock = false } = {}) {
  const c = client || { query };
  const { rows: u } = await c.query(`select id, data from users where id = $1${lock ? ' for share' : ''}`, [String(userId)]);
  if (!u.length) return { user: null, creator: null, effectiveStatus: null };
  const user = { ...u[0].data, id: u[0].id };
  if (user.role !== 'creator' || !user.creatorId) {
    // A fan account's own moderation (lib/user-moderation.js): suspended or
    // banned freezes its credits exactly like a creator's, so checkout,
    // paid DMs and buying credits all refuse it through isFrozenStanding.
    const fanStatus = effectiveUserStatus(user);
    return { user, creator: null, effectiveStatus: fanStatus === 'active' ? null : fanStatus };
  }
  const { rows: cr } = await c.query(
    `select id, data from creators where id = $1${lock ? ' for share' : ''}`,
    [String(user.creatorId)],
  );
  const creator = cr.length ? { ...cr[0].data, id: cr[0].id } : null;
  return { user, creator, effectiveStatus: creator ? effectiveCreatorStatus(creator) : null };
}

/** Shown when a frozen account tries to buy credits (pages/api/credits/*). */
export const FROZEN_BUY_MESSAGE =
  'Your account is suspended or banned, so its credits are frozen -- buying credits is closed for this account. Nothing has been sent.';

/** A banned or suspended creator account's balance is frozen: it can't be spent, moved or cashed out. */
export function isFrozenStanding(standing) {
  return standing?.effectiveStatus === 'banned' || standing?.effectiveStatus === 'suspended';
}

/**
 * Only an active, real (non-demo) creator can be paid by a fan or cash out.
 * "Demo" is lib/creator-status.js isDemoCreator (seed OR demo) -- the same
 * predicate the UI uses for its "Demo — not for sale" label, so a record
 * flagged `demo` by hand can't be paid while the page says it can't.
 */
export function canReceiveStanding(standing) {
  return !!standing?.creator && standing.effectiveStatus === 'active' && !isDemoCreator(standing.creator);
}

/**
 * Moves credits from a spender straight to the creator who earns from that
 * spend, net of the platform's cut -- one transaction, so a charge can never
 * debit the fan without crediting someone (or the reverse). `feeBps` is a
 * property of the call site (FEES in lib/fees.js: marketplace 1500,
 * everything else 1000), not guessed here.
 *
 * Enforced here, at the one place money moves between users, rather than
 * trusted to every caller:
 *  - the payer must not be a frozen (banned/suspended) creator account;
 *  - the recipient must be an ACTIVE, non-demo creator (RECIPIENT_UNAVAILABLE
 *    otherwise) -- a pending, suspended or banned creator is never paid;
 *  - a founding creator inside their waiver window (lib/founding.js) pays
 *    NO fee at all: the whole amount is theirs;
 *  - the recipient's net is EARNED, so it becomes withdrawable; the payer's
 *    spend consumes their non-withdrawable credits first.
 *
 * Returns { feeCents, netCents, feeBps } where feeBps is the rate actually
 * applied (0 during a founding waiver).
 */
export async function transferWithFee({ fromUserId, toUserId, cents, feeBps, type, meta = {} }, client = null) {
  assertCents(cents);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) throw new Error(`Invalid fee rate: ${feeBps}`);
  if (String(fromUserId) === String(toUserId)) {
    throw Object.assign(new Error('You can’t pay yourself.'), { code: RECIPIENT_UNAVAILABLE });
  }
  const run = async (c) => {
    const payer = await accountStanding(fromUserId, c, { lock: true });
    if (isFrozenStanding(payer)) {
      throw Object.assign(new Error('This account’s credits are frozen while it is suspended or banned.'), { code: ACCOUNT_FROZEN });
    }
    const payee = await accountStanding(toUserId, c, { lock: true });
    if (!canReceiveStanding(payee)) {
      throw Object.assign(new Error('That creator can’t be paid right now.'), { code: RECIPIENT_UNAVAILABLE });
    }
    const appliedBps = feeWaiverActive(payee.creator) ? 0 : feeBps;
    const feeCents = Math.round((cents * appliedBps) / 10_000);
    const netCents = cents - feeCents;
    await debitAccount({ userId: fromUserId, cents, type: `${type}_charge`, meta }, c);
    await creditAccount(
      {
        userId: toUserId,
        cents: netCents,
        type: `${type}_earn`,
        meta: { ...meta, feeCents, feeBps: appliedBps, ...(appliedBps !== feeBps ? { foundingWaiver: true } : {}) },
        withdrawable: true,
      },
      c,
    );
    return { feeCents, netCents, feeBps: appliedBps };
  };
  return client ? run(client) : withTransaction(run);
}

/** Checks and normalises a payout wallet: a real EVM address, checksummed. Throws INVALID_PAYOUT_WALLET otherwise. */
export function normalizePayoutWallet(wallet) {
  const raw = typeof wallet === 'string' ? wallet.trim() : '';
  // Same rule as the profile save (lib/field-validation.js payoutWalletError):
  // a mixed-case address must pass its EIP-55 checksum, and the zero address
  // is refused -- re-checksumming a typo'd address would pay nobody.
  if (!raw || payoutWalletError(raw)) {
    throw Object.assign(
      new Error('Your saved payout wallet isn’t a valid wallet address (0x followed by 40 hex characters, with a matching checksum). Fix it in your profile first.'),
      { code: INVALID_PAYOUT_WALLET },
    );
  }
  return getAddress(raw);
}

/**
 * A creator's request to cash out. The amount is debited immediately --
 * reserved against this request -- so it can't also be spent or requested
 * again while a human hasn't sent the real USDG yet. See lib/db.js's
 * payout_requests comment for why the actual send is a manual step, not
 * automated from here.
 *
 * Only an ACTIVE, non-demo creator may cash out (checked inside the same
 * transaction as the debit, against the locked creator row), only to a
 * valid EVM address, and only from EARNED credits (withdrawable_cents) --
 * deposited credits never leave the platform. Payouts are USDG only.
 */
export async function requestPayout({ userId, cents, payoutWallet }) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error('Invalid payout amount');
  if (cents < MIN_PAYOUT_CENTS) {
    throw Object.assign(new Error(`The minimum cash-out is $${(MIN_PAYOUT_CENTS / 100).toFixed(2)}.`), { code: PAYOUT_NOT_ALLOWED });
  }
  const wallet = normalizePayoutWallet(payoutWallet);
  const request = await withTransaction(async (client) => {
    const standing = await accountStanding(userId, client, { lock: true });
    if (!canReceiveStanding(standing)) {
      throw Object.assign(new Error('Only approved creator accounts in good standing can cash out.'), { code: PAYOUT_NOT_ALLOWED });
    }
    await debitAccount({ userId, cents, type: 'payout_reserved', meta: { payoutWallet: wallet, asset: 'USDG' }, fromWithdrawable: true }, client);
    const { rows } = await client.query(
      `insert into payout_requests (user_id, amount_cents, payout_wallet) values ($1, $2, $3)
       returning id, user_id, amount_cents, status, payout_wallet, created_at`,
      [String(userId), cents, wallet],
    );
    return rows[0];
  });
  return request;
}

/**
 * Adds, to each payout_requests row, who it belongs to and whether that
 * account is still in good standing -- so the admin queue can show a name
 * and a status instead of a bare user id, and so a frozen request is
 * visibly frozen before anyone sends real money against it.
 */
export async function describePayoutRows(rows) {
  const out = [];
  const cache = new Map();
  for (const row of rows) {
    const key = String(row.user_id);
    if (!cache.has(key)) cache.set(key, await accountStanding(key));
    const standing = cache.get(key);
    out.push({
      ...row,
      account: {
        email: standing.user?.email ?? null,
        creatorId: standing.creator?.id ?? null,
        creatorName: standing.creator?.name ?? null,
        creatorHandle: standing.creator?.handle ?? null,
        status: standing.effectiveStatus ?? null,
        seed: isDemoCreator(standing.creator),
      },
      frozen: !canReceiveStanding(standing),
    });
  }
  return out;
}

export async function getPendingPayoutRequests() {
  const { rows } = await query(`select * from payout_requests where status = 'pending' order by created_at asc`);
  return rows;
}

/**
 * Recently PAID payout requests -- the half of the picture the admin panel
 * never showed before: a request used to just vanish from the UI the moment
 * it was marked paid (the row survived in Postgres, but nothing ever read it
 * back), so there was no way to do monthly reconciliation without querying
 * the database by hand.
 */
export async function getRecentPaidPayoutRequests(limit = 50) {
  const { rows } = await query(
    `select * from payout_requests where status = 'paid' order by paid_at desc limit $1`,
    [limit],
  );
  return rows;
}

export async function getRecentRejectedPayoutRequests(limit = 50) {
  const { rows } = await query(
    `select * from payout_requests where status = 'rejected' order by rejected_at desc limit $1`,
    [limit],
  );
  return rows;
}

/** A single user's own payout requests (any status), newest first -- what a creator sees of their own cash-out history. */
export async function getPayoutRequestsForUser(userId, limit = 50) {
  const { rows } = await query(
    `select * from payout_requests where user_id = $1 order by created_at desc limit $2`,
    [String(userId), limit],
  );
  return rows;
}

export async function getPayoutRequest(id) {
  const { rows } = await query('select * from payout_requests where id = $1', [id]);
  return rows[0] || null;
}

/**
 * A user's own recent ledger entries -- every credit/debit that's ever
 * touched their balance, with the type and metadata that explains it. This
 * is the audit trail lib/db.js's credit_ledger table was built to hold,
 * finally read back somewhere: before this, every deposit, spend, sale and
 * payout was written faithfully and never surfaced to the person it
 * happened to.
 */
export async function getLedgerForUser(userId, limit = 50) {
  const { rows } = await query(
    `select id, type, amount_cents, meta, created_at from credit_ledger where user_id = $1 order by id desc limit $2`,
    [String(userId), limit],
  );
  return rows;
}

/**
 * Admin marks a payout request fulfilled once the real USDG has actually
 * been sent, recording the transaction hash as proof.
 *
 *  - The hash is stored lowercased, and a unique index on lower(tx_hash)
 *    means one real transfer can close exactly one request (TX_HASH_REUSED).
 *  - A request whose owner is no longer an active creator (banned,
 *    suspended, reverted to pending, deleted) is FROZEN: it can't be marked
 *    paid unless the admin passes `override: true` deliberately -- the
 *    normal path for such a request is rejectPayout, which returns the
 *    credits to the (still frozen) balance.
 *
 * Whether the hash really is a transfer of the right amount to the right
 * wallet is checked on-chain by the route before this is called (see
 * pages/api/admin/payouts-mark-paid.js); this function only records.
 */
export async function markPayoutPaid(id, txHash, { override = false } = {}) {
  if (!TX_HASH_RE.test(typeof txHash === 'string' ? txHash : '')) {
    throw new Error('A real transaction hash is required to mark a payout paid');
  }
  const hash = txHash.toLowerCase();
  const request = await withTransaction(async (client) => {
    const { rows: cur } = await client.query('select * from payout_requests where id = $1 for update', [id]);
    if (!cur.length || cur[0].status !== 'pending') {
      throw Object.assign(new Error('Payout request not found or not pending'), { code: PAYOUT_NOT_PENDING });
    }
    const standing = await accountStanding(cur[0].user_id, client, { lock: true });
    if (!canReceiveStanding(standing) && override !== true) {
      throw Object.assign(
        new Error(`This account is ${standing.effectiveStatus || 'no longer an active creator'} -- its payouts are frozen. Reject the request, or override explicitly if you really mean to pay it.`),
        { code: PAYOUT_FROZEN },
      );
    }
    try {
      const { rows } = await client.query(
        `update payout_requests set status = 'paid', tx_hash = $2, paid_at = now() where id = $1 and status = 'pending' returning *`,
        [id, hash],
      );
      return rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw Object.assign(new Error('That transaction hash is already recorded as the proof for another payout.'), { code: TX_HASH_REUSED });
      }
      throw err;
    }
  });
  // Best-effort, after the real status change already committed -- a
  // notification failing here must never make an admin think a real,
  // already-sent payout didn't go through.
  await createNotification({
    userId: request.user_id,
    type: 'payout_paid',
    message: `Your $${(Number(request.amount_cents) / 100).toFixed(2)} cash-out was paid.`,
    meta: { payoutRequestId: request.id, txHash: hash },
  });
  return request;
}

/**
 * Admin refuses a pending payout request (a wallet nobody can send to, a
 * banned or suspended account, suspected fraud). In ONE transaction the
 * request is marked 'rejected' -- only if it is still pending, so it can't
 * race a mark-paid -- and the reserved credits go back to the creator's
 * balance as withdrawable again ('payout_reversed' ledger row). For a
 * frozen account that refund is simply held: a frozen balance can't be
 * spent or cashed out (see transferWithFee / requestPayout).
 */
export async function rejectPayout(id, reason) {
  const why = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
  if (!why) throw new Error('A reason is required to reject a payout');
  const request = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `update payout_requests set status = 'rejected', rejected_at = now(), reject_reason = $2
        where id = $1 and status = 'pending' returning *`,
      [id, why],
    );
    if (!rows.length) {
      throw Object.assign(new Error('Payout request not found or not pending'), { code: PAYOUT_NOT_PENDING });
    }
    const r = rows[0];
    await creditAccount(
      {
        userId: r.user_id,
        cents: Number(r.amount_cents),
        type: 'payout_reversed',
        meta: { payoutRequestId: r.id, reason: why },
        withdrawable: true,
      },
      client,
    );
    return r;
  });
  await createNotification({
    userId: request.user_id,
    type: 'payout_rejected',
    message: `Your $${(Number(request.amount_cents) / 100).toFixed(2)} cash-out wasn’t sent (${why}). The credits are back in your balance.`,
    meta: { payoutRequestId: request.id },
  });
  return request;
}
