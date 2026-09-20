import { getVerifiedSessionUserId } from '../../../lib/session';
import { verifyUsdcPayment } from '../../../lib/chain-verify';
import { getMarketplaceVerificationConfig, marketplaceVerificationLive } from '../../../lib/marketplace-payment-config';
import { creditAccount } from '../../../lib/credits-store';
import { withTransaction } from '../../../lib/db';
import { FEES } from '../../../lib/fees';

/**
 * The ONLY place a fan ever needs a wallet: converting a real on-chain USDG
 * payment into a credits balance. Every purchase after this (marketplace,
 * and eventually tips/subscriptions) spends from that balance with no
 * wallet interaction at all -- see pages/api/marketplace/orders/create.js.
 *
 * Same real on-chain verification as the marketplace checkout, reused
 * rather than re-implemented: this endpoint doesn't trust the amount the
 * client claims to have sent, it re-derives it from what actually landed
 * on-chain. The used_payment_tx claim (inside the same transaction as the
 * balance credit) is what stops one real deposit being replayed to mint
 * credits twice -- same table and same reasoning as marketplace orders.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const config = getMarketplaceVerificationConfig();
  if (!marketplaceVerificationLive(config)) {
    return res.status(501).json({ error: 'Buying credits is not configured yet.' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return res.status(401).json({ error: 'Log in to buy credits' });

  const { txHash } = req.body || {};
  if (!txHash) return res.status(400).json({ error: 'Missing transaction hash' });

  let paidUnits;
  try {
    // minAmount of 1 unit -- any real, confirmed payment to our address is
    // accepted; the actual credited amount is derived from what the chain
    // says arrived, not from anything the client claims.
    paidUnits = await verifyUsdcPayment({
      rpcUrl: config.rpcUrl,
      txHash,
      tokenAddress: config.usdcAddress,
      payoutAddress: config.payoutAddress,
      minAmount: 1n,
    });
  } catch (err) {
    return res.status(402).json({ error: err.message, code: err.code });
  }

  // paidUnits is in the token's smallest unit (6 decimals for USDG) --
  // convert to whole cents, rounding down so the platform is never short.
  const grossCents = Number(paidUnits / 10_000n); // 10^6 units per dollar / 100 cents per dollar = 10^4 units per cent
  const feeCents = Math.floor((grossCents * FEES.DEPOSIT_BPS) / 10_000);
  const netCents = grossCents - feeCents;

  try {
    const newBalance = await withTransaction(async (client) => {
      try {
        await client.query('insert into used_payment_tx (tx_hash) values ($1)', [txHash]);
      } catch (err) {
        if (err.code === '23505') {
          throw Object.assign(new Error('This payment has already been used'), { code: 'TX_ALREADY_USED' });
        }
        throw err;
      }
      await creditAccount({ userId: uid, cents: netCents, type: 'deposit', meta: { txHash, grossCents, feeCents } }, client);
      const { rows } = await client.query('select balance_cents from credit_balances where user_id = $1', [String(uid)]);
      return Number(rows[0].balance_cents);
    });
    return res.status(200).json({ ok: true, creditedCents: netCents, feeCents, balanceCents: newBalance });
  } catch (err) {
    if (err.code === 'TX_ALREADY_USED') return res.status(409).json({ error: err.message });
    return res.status(500).json({ error: err.message });
  }
}
