import crypto from 'crypto';
import { verifyUsdcPayment, assertTokenDecimals } from './chain-verify';
import { creditAccount } from './credits-store';
import { withTransaction } from './db';
import { FEES, MIN_DEPOSIT_CENTS } from './fees';

export const TX_ALREADY_USED = 'TX_ALREADY_USED';
export const BELOW_MINIMUM = 'BELOW_MINIMUM';
// The account the deposit is for no longer exists (deleted while the payment
// confirmed). The hash is NOT claimed, so it stays creditable by support.
export const ACCOUNT_GONE = 'ACCOUNT_GONE';

/**
 * Proof that THIS logged-in user controls THIS wallet, established BEFORE
 * any money is sent.
 *
 * The deposit flow used to be: get a 5-minute nonce, sign it, then send the
 * USDG, then submit hash + signature. The signature was only checked at the
 * last step -- so a slow send (adding the network, buying gas) or a wallet
 * whose signature doesn't ecrecover meant the USDG had already left when the
 * server said "verification expired, try again", and trying again paid
 * twice. Now the signature is verified first (POST
 * /api/credits/verify-wallet), which sets this short-lived signed cookie;
 * /api/credits/buy then only needs the tx hash, and the cookie outlives a
 * slow send.
 *
 * Its own derived key and its own `typ`, like every other token on the one
 * root secret (see lib/wallet-auth.js for why that matters), and bound to
 * the user id so it can't be carried to another account.
 */
export const DEPOSIT_WALLET_COOKIE_NAME = 'oa_deposit_wallet';
export const DEPOSIT_WALLET_TTL_SECONDS = 2 * 60 * 60;

function depositWalletKey(secret) {
  return crypto.createHmac('sha256', String(secret)).update('oa:deposit-wallet:v1').digest();
}

export function createDepositWalletToken(secret, { uid, address }) {
  const payload = Buffer.from(
    JSON.stringify({ typ: 'deposit_wallet', uid: String(uid), address: String(address).toLowerCase(), exp: Date.now() + DEPOSIT_WALLET_TTL_SECONDS * 1000 }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', depositWalletKey(secret)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** The proven wallet address for `uid`, or null (missing, forged, expired, or minted for another account). */
export function readDepositWalletToken(secret, token, uid) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const want = crypto.createHmac('sha256', depositWalletKey(secret)).update(payload).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.typ !== 'deposit_wallet') return null;
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    if (String(data.uid) !== String(uid)) return null;
    if (typeof data.address !== 'string' || !/^0x[0-9a-f]{40}$/.test(data.address)) return null;
    return data.address;
  } catch {
    return null;
  }
}

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

  // The SUM of every transfer from the proven sender to our address in this
  // transaction (lib/chain-verify.js): the hash is claimed below, so any
  // transfer left uncounted here could never be credited later.
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
  // Guarded rather than left to throw BigInt's own cryptic "Exponent must be
  // non-negative" -- a stablecoin configured with fewer than 2 decimals
  // isn't attacker-reachable (it's env config, checked against the real
  // contract elsewhere by assertTokenDecimals), but a misconfiguration here
  // should fail with a message that says what's wrong, not a BigInt internal.
  if (config.usdcDecimals < 2) {
    throw new Error(`Configured stablecoin decimals (${config.usdcDecimals}) must be at least 2 -- cents can't be derived from fewer.`);
  }
  const unitsPerCent = 10n ** BigInt(config.usdcDecimals - 2);
  const grossCents = Number(paidUnits / unitsPerCent);

  if (grossCents < MIN_DEPOSIT_CENTS) {
    // Deliberately does NOT claim used_payment_tx (nothing was credited).
    // Note that a transaction's amount can never change, so resubmitting the
    // same hash will always be refused the same way: the real protection is
    // that pages/credits.js refuses to SEND anything under the minimum in the
    // first place. A sub-minimum transfer that arrives anyway (sent by hand
    // outside the page) is a support case: the admin can see it on-chain.
    throw Object.assign(
      new Error(`That payment (${(grossCents / 100).toFixed(2)}) is below the $${(MIN_DEPOSIT_CENTS / 100).toFixed(2)} minimum deposit and can't be credited.`),
      { code: BELOW_MINIMUM },
    );
  }

  const feeCents = Math.floor((grossCents * FEES.DEPOSIT_BPS) / 10_000);
  const netCents = grossCents - feeCents;
  return recordDepositCredit({ userId, txHash, grossCents, feeCents, netCents });
}

/**
 * The database half of a verified deposit: claims the hash and credits the
 * account in ONE transaction. Exported for tests; the only production caller
 * is creditDepositFromChain above, AFTER the on-chain verification.
 */
export async function recordDepositCredit({ userId, txHash, grossCents, feeCents, netCents }) {
  return withTransaction(async (client) => {
    // The account must still exist, checked FIRST and before the hash is
    // claimed. /api/credits/buy checks the session once, then waits up to a
    // minute for the receipt -- an account deleted meanwhile used to have the
    // deposit credited to a user id that no longer existed (credit_balances has
    // no foreign key to users), the USDG kept and the hash used up for good.
    // FOR SHARE also serialises against deleteFanAccount's `users ... for
    // update`: a deletion that read "no balance" commits first and this finds
    // no row, or this commits first and the deletion sees the credit.
    const { rows: who } = await client.query('select 1 from users where id = $1 for share', [String(userId)]);
    if (!who.length) {
      throw Object.assign(
        new Error('That account no longer exists, so the payment was not credited. It can still be recovered: contact team@onlyone1.fun with the transaction hash.'),
        { code: ACCOUNT_GONE },
      );
    }
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
