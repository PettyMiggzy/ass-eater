import { verifyUsdcPayment, assertTokenDecimals } from './chain-verify';
import { creditAccount } from './credits-store';
import { withTransaction } from './db';
import { FEES, MIN_DEPOSIT_CENTS } from './fees';

export const TX_ALREADY_USED = 'TX_ALREADY_USED';
export const BELOW_MINIMUM = 'BELOW_MINIMUM';

/**
 * The one place a real on-chain payment becomes a credits balance. Shared by
 * the fan-facing buy endpoint (pages/api/credits/buy.js, which requires a
 * proven sender) and the admin manual-credit tool (which a human has already
 * verified some other way) so the actual money-moving logic -- decimals
 * assertion, minimum-amount floor, replay protection, the balance credit --
 * exists in exactly one place rather than being re-implemented twice with a
 * chance to drift.
 *
 * `expectedFrom`, when given, is enforced against the transaction's own
 * sender (see chain-verify.js) -- omit it only when the caller has already
 * established who paid through some other means (the admin tool, which
 * requires the admin to state the address and takes responsibility for it).
 */
export async function creditDepositFromChain({ userId, txHash, expectedFrom, config }) {
  // Ethereum tx hashes are case-insensitive -- the RPC node resolves
  // "0xABC..." and "0xabc..." to the identical transaction -- but
  // used_payment_tx's primary key is a plain case-sensitive Postgres `text`
  // column. Without normalizing, the SAME real payment could be submitted
  // under multiple different letter-casings of its own hash and credited
  // once per casing: each one is a distinct primary-key row even though
  // they're all the same on-chain transaction. Lowercasing here, before the
  // RPC lookup and before the insert, means every submission of the same
  // real hash collides on the same row no matter how it was typed/pasted.
  txHash = String(txHash || '').toLowerCase();

  await assertTokenDecimals({
    rpcUrl: config.rpcUrl,
    tokenAddress: config.usdcAddress,
    expectedDecimals: config.usdcDecimals,
  });

  const paidUnits = await verifyUsdcPayment({
    rpcUrl: config.rpcUrl,
    txHash,
    tokenAddress: config.usdcAddress,
    payoutAddress: config.payoutAddress,
    minAmount: 1n,
    expectedFrom,
  });

  // paidUnits is in the token's smallest unit -- convert to whole cents,
  // rounding down so the platform is never short. 1 cent = 10^(decimals-2)
  // raw units (decimals-per-dollar / 100 cents-per-dollar), computed this
  // way rather than a hardcoded 10_000n so a correctly-configured token with
  // a different decimals count still prices correctly.
  const unitsPerCent = 10n ** BigInt(config.usdcDecimals - 2);
  const grossCents = Number(paidUnits / unitsPerCent);

  if (grossCents < MIN_DEPOSIT_CENTS) {
    // Deliberately does NOT claim used_payment_tx: nothing was credited, so
    // there is nothing to protect against being "replayed" -- and burning
    // the hash here would permanently block the depositor from ever
    // resubmitting a larger, legitimate payment under the same reference.
    throw Object.assign(
      new Error(`That payment (${(grossCents / 100).toFixed(2)}) is below the $${(MIN_DEPOSIT_CENTS / 100).toFixed(2)} minimum deposit and can't be credited.`),
      { code: BELOW_MINIMUM },
    );
  }

  const feeCents = Math.floor((grossCents * FEES.DEPOSIT_BPS) / 10_000);
  const netCents = grossCents - feeCents;

  return withTransaction(async (client) => {
    try {
      await client.query('insert into used_payment_tx (tx_hash) values ($1)', [txHash]);
    } catch (err) {
      if (err.code === '23505') {
        throw Object.assign(new Error('This payment has already been used'), { code: TX_ALREADY_USED });
      }
      throw err;
    }
    await creditAccount({ userId, cents: netCents, type: 'deposit', meta: { txHash, grossCents, feeCents } }, client);
    const { rows } = await client.query('select balance_cents from credit_balances where user_id = $1', [String(userId)]);
    return { creditedCents: netCents, feeCents, grossCents, balanceCents: Number(rows[0].balance_cents) };
  });
}
