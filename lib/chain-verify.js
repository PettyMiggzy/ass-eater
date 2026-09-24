import { createPublicClient, http, getAddress, parseAbiItem, decodeEventLog } from 'viem';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const DECIMALS_ABI = [{ name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }];

// Real ERC-20 decimals never change after deployment -- cached per
// (rpcUrl, tokenAddress) pair for the life of this instance rather than
// re-read on every request. Keyed by a plain string so cold starts (a fresh
// serverless instance) simply re-check once, which is the point: this is a
// safety net against a *configuration* mistake, not something that needs to
// react to the chain in real time.
const decimalsCache = new Map();

/**
 * Confirms the token at `tokenAddress` really has `expectedDecimals`, against
 * the server's own RPC -- the one guard this codebase already built once for
 * exactly this failure mode (see assertTokenDecimals() in server/'s deposit
 * indexer, which this mirrors). A wrong assumption here is silent and total:
 * every deposit computed from the wrong decimals is mispriced by a power of
 * ten in one direction or the other, and nothing downstream would notice
 * since the arithmetic stays internally consistent. Throws rather than warns.
 */
export async function assertTokenDecimals({ rpcUrl, tokenAddress, expectedDecimals }) {
  const key = `${rpcUrl}:${tokenAddress}`;
  if (decimalsCache.has(key)) {
    if (decimalsCache.get(key) !== expectedDecimals) {
      throw new Error(`Configured stablecoin decimals (${expectedDecimals}) don't match the token contract's real decimals (${decimalsCache.get(key)})`);
    }
    return;
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  const real = await client.readContract({ address: getAddress(tokenAddress), abi: DECIMALS_ABI, functionName: 'decimals' });
  decimalsCache.set(key, real);
  if (real !== expectedDecimals) {
    throw new Error(`Configured stablecoin decimals (${expectedDecimals}) don't match the token contract's real decimals (${real})`);
  }
}

/**
 * Verifies that `txHash` is a real, confirmed ERC-20 transfer of at least
 * `minAmount` (in the token's smallest unit) of `tokenAddress` to
 * `payoutAddress`, against the server's own RPC -- never trusted from
 * anything the client sends about the payment beyond the hash itself.
 *
 * `expectedFrom`, when given, is checked against the transfer's own sender.
 * Without this, ANY logged-in caller could submit ANY qualifying txHash --
 * including someone else's real, already-in-flight deposit, since the
 * payout address is public in the client bundle and every Transfer to it is
 * visible on-chain to anyone watching. Amount and destination alone don't
 * prove who paid; only the sender field does, and this is what makes that
 * check happen before a single deposit's credit is ever handed out. The
 * caller is expected to have already proven control of `expectedFrom` via a
 * signature (see lib/wallet-auth.js) -- this function only checks that the
 * on-chain transfer actually came from that proven address.
 *
 * Returns the actual transferred amount (>= minAmount) on success, or throws
 * with a `.code` describing exactly why it was rejected, so the caller can
 * give the buyer a real reason instead of a bare 400.
 */
export async function verifyUsdcPayment({ rpcUrl, txHash, tokenAddress, payoutAddress, minAmount, expectedFrom }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) {
    throw Object.assign(new Error('Malformed transaction hash'), { code: 'BAD_HASH' });
  }

  const client = createPublicClient({ transport: http(rpcUrl) });

  let receipt;
  try {
    // Real confirmations can take a little longer than the browser's own
    // wait -- this gives a transaction that just landed a real chance to be
    // found rather than failing a checkout that actually succeeded on-chain.
    //
    // checkReplacement: false -- by default viem, on seeing the submitted tx
    // replaced (sped up / cancelled: same sender, same nonce), resolves with
    // the REPLACEMENT's receipt. The caller then claims the ORIGINAL hash in
    // used_payment_tx, leaving the replacement's hash unclaimed, so the same
    // payment could be credited a second time by submitting it. Only the
    // transaction that was actually mined under this exact hash counts.
    receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000, checkReplacement: false });
  } catch {
    throw Object.assign(new Error('Transaction not found or not yet confirmed'), { code: 'NOT_CONFIRMED' });
  }

  // Belt and braces for the same reason: whatever the RPC or client library
  // does, the receipt must be for the hash that will be claimed.
  if (String(receipt?.transactionHash || '').toLowerCase() !== String(txHash).toLowerCase()) {
    throw Object.assign(new Error('No matching payment found in that transaction'), { code: 'NO_MATCHING_TRANSFER' });
  }

  if (receipt.status !== 'success') {
    throw Object.assign(new Error('That transaction failed on-chain'), { code: 'TX_REVERTED' });
  }

  const wantToken = getAddress(tokenAddress);
  const wantTo = getAddress(payoutAddress);
  const wantFrom = expectedFrom ? getAddress(expectedFrom) : null;

  // A single transaction can legitimately carry more than one Transfer log
  // of the configured token to our address (a smart-contract wallet, a
  // batched call, a router hop) -- so a sender mismatch on ONE candidate log
  // must not abort the whole search. Keep scanning for a log that matches
  // amount, destination AND sender; only report a sender mismatch (rather
  // than the generic "no matching transfer") if at least one log matched
  // everything except the sender, once every log has been checked.
  let sawAmountAndDestinationMatch = false;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== wantToken) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
    } catch {
      continue; // not a Transfer log (or a differently-shaped one) -- not ours
    }
    if (getAddress(decoded.args.to) !== wantTo) continue;
    if (decoded.args.value < minAmount) continue;
    if (wantFrom && getAddress(decoded.args.from) !== wantFrom) {
      sawAmountAndDestinationMatch = true;
      continue;
    }
    return decoded.args.value;
  }

  if (sawAmountAndDestinationMatch) {
    throw Object.assign(
      new Error('This transaction was not sent from the wallet you verified'),
      { code: 'SENDER_MISMATCH' },
    );
  }
  throw Object.assign(
    new Error('No matching payment found in that transaction'),
    { code: 'NO_MATCHING_TRANSFER' },
  );
}
