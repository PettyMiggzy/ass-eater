import { query, withTransaction } from './db';

export const INSUFFICIENT_BALANCE = 'insufficient_balance';

/** A user's current credit balance, in cents. 0 for a user who's never bought credits. */
export async function getBalanceCents(userId) {
  const { rows } = await query('select balance_cents from credit_balances where user_id = $1', [String(userId)]);
  return rows.length ? Number(rows[0].balance_cents) : 0;
}

/**
 * Increments a user's balance and writes the ledger row in one transaction
 * -- a balance change with no explanation next to it is exactly the kind of
 * thing that's impossible to reconcile later. Runs inside the caller's
 * transaction (`client`) when given one, so a deposit's balance credit and
 * its used_payment_tx claim commit or roll back together.
 */
export async function creditAccount({ userId, cents, type, meta = {} }, client = null) {
  const run = async (c) => {
    await c.query(
      `insert into credit_balances (user_id, balance_cents, updated_at)
       values ($1, $2, now())
       on conflict (user_id) do update set balance_cents = credit_balances.balance_cents + $2, updated_at = now()`,
      [String(userId), cents],
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
 */
export async function debitAccount({ userId, cents, type, meta = {} }, client = null) {
  const run = async (c) => {
    const { rows } = await c.query(
      `update credit_balances set balance_cents = balance_cents - $2, updated_at = now()
        where user_id = $1 and balance_cents >= $2
        returning balance_cents`,
      [String(userId), cents],
    );
    if (!rows.length) {
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
 * Moves credits from a spender straight to whoever earns from that spend,
 * net of the platform's cut -- one transaction, so a charge can never debit
 * the fan without crediting someone (or the reverse). `feeBps` is a
 * property of the call site (marketplace 1500, everything else 1000 per
 * FEES elsewhere in this codebase), not guessed here.
 */
export async function transferWithFee({ fromUserId, toUserId, cents, feeBps, type, meta = {} }, client = null) {
  const feeCents = Math.round((cents * feeBps) / 10_000);
  const netCents = cents - feeCents;
  const run = async (c) => {
    await debitAccount({ userId: fromUserId, cents, type: `${type}_charge`, meta }, c);
    await creditAccount({ userId: toUserId, cents: netCents, type: `${type}_earn`, meta: { ...meta, feeCents, feeBps } }, c);
    return { feeCents, netCents };
  };
  return client ? run(client) : withTransaction(run);
}

/**
 * A creator's request to cash out. The balance is debited immediately --
 * reserved against this request -- so it can't also be spent or requested
 * again while a human hasn't sent the real USDG yet. See lib/db.js's
 * payout_requests comment for why the actual send is a manual step, not
 * automated from here.
 */
export async function requestPayout({ userId, cents, payoutWallet }) {
  if (!Number.isFinite(cents) || cents <= 0) throw new Error('Invalid payout amount');
  return withTransaction(async (client) => {
    await debitAccount({ userId, cents, type: 'payout_reserved', meta: { payoutWallet } }, client);
    const { rows } = await client.query(
      `insert into payout_requests (user_id, amount_cents, payout_wallet) values ($1, $2, $3) returning id, user_id, amount_cents, status, payout_wallet, created_at`,
      [String(userId), cents, payoutWallet || null],
    );
    return rows[0];
  });
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

/** A single user's own payout requests (pending and paid), newest first -- what a creator sees of their own cash-out history. */
export async function getPayoutRequestsForUser(userId, limit = 50) {
  const { rows } = await query(
    `select * from payout_requests where user_id = $1 order by created_at desc limit $2`,
    [String(userId), limit],
  );
  return rows;
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

/** Admin marks a payout request fulfilled once the real USDG has actually been sent, recording the transaction hash as proof. */
export async function markPayoutPaid(id, txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) throw new Error('A real transaction hash is required to mark a payout paid');
  const { rows } = await query(
    `update payout_requests set status = 'paid', tx_hash = $2, paid_at = now() where id = $1 and status = 'pending' returning *`,
    [id, txHash],
  );
  if (!rows.length) throw new Error('Payout request not found or already paid');
  return rows[0];
}
