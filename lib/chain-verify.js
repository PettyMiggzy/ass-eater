import { createPublicClient, http, getAddress, parseAbiItem, decodeEventLog } from 'viem';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/**
 * Verifies that `txHash` is a real, confirmed ERC-20 transfer of at least
 * `minAmount` (in the token's smallest unit) of `tokenAddress` to
 * `payoutAddress`, against the server's own RPC -- never trusted from
 * anything the client sends about the payment beyond the hash itself.
 *
 * Returns the actual transferred amount (>= minAmount) on success, or throws
 * with a `.code` describing exactly why it was rejected, so the caller can
 * give the buyer a real reason instead of a bare 400.
 */
export async function verifyUsdcPayment({ rpcUrl, txHash, tokenAddress, payoutAddress, minAmount }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) {
    throw Object.assign(new Error('Malformed transaction hash'), { code: 'BAD_HASH' });
  }

  const client = createPublicClient({ transport: http(rpcUrl) });

  let receipt;
  try {
    // Real confirmations can take a little longer than the browser's own
    // wait -- this gives a transaction that just landed a real chance to be
    // found rather than failing a checkout that actually succeeded on-chain.
    receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  } catch {
    throw Object.assign(new Error('Transaction not found or not yet confirmed'), { code: 'NOT_CONFIRMED' });
  }

  if (receipt.status !== 'success') {
    throw Object.assign(new Error('That transaction failed on-chain'), { code: 'TX_REVERTED' });
  }

  const wantToken = getAddress(tokenAddress);
  const wantTo = getAddress(payoutAddress);

  for (const log of receipt.logs) {
    if (getAddress(log.address) !== wantToken) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics });
    } catch {
      continue; // not a Transfer log (or a differently-shaped one) -- not ours
    }
    if (getAddress(decoded.args.to) !== wantTo) continue;
    if (decoded.args.value >= minAmount) {
      return decoded.args.value;
    }
  }

  throw Object.assign(
    new Error('No matching payment found in that transaction'),
    { code: 'NO_MATCHING_TRANSFER' },
  );
}
