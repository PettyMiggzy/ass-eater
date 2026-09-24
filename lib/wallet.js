import { useCallback, useState } from 'react';
import { createWalletClient, custom, getAddress, encodeFunctionData, defineChain } from 'viem';

/**
 * Thin wrapper around a browser-injected wallet (MetaMask, Coinbase Wallet,
 * any EIP-1193 provider on window.ethereum). Deliberately does NOT pull in
 * WalletConnect/RainbowKit -- those need a Reown/WalletConnect Cloud project
 * id that nobody has set up yet, and an injected-only connector already
 * covers the large majority of desktop crypto users without that
 * dependency. Add a WalletConnect connector later without touching the
 * payment logic below -- this hook's return shape (`address`, `sendUsdc`)
 * is the only thing callers depend on.
 *
 * The provider-level functions are exported separately from the hook and
 * take the EIP-1193 provider as an argument, so they can be exercised
 * against a mock provider in a plain node test (lib/wallet.test.mjs).
 */

const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
];

/**
 * The configured payment network as a viem chain. `rpcUrls` is only what
 * the wallet is told when the network is added -- never a trust boundary
 * (the server verifies every payment against its own RPC).
 */
export function paymentChain({ chainId, chainName, rpcUrl, nativeSymbol }) {
  const id = Number(chainId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid payment chain id');
  return defineChain({
    id,
    name: chainName || `Chain ${id}`,
    nativeCurrency: { name: nativeSymbol || 'ETH', symbol: nativeSymbol || 'ETH', decimals: 18 },
    rpcUrls: { default: { http: rpcUrl ? [rpcUrl] : [] } },
  });
}

/** Whole US cents -> the token's smallest unit, as one integer expression (no float dollars to round badly). */
export function centsToTokenUnits(amountCents, decimals) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('Invalid amount');
  if (!Number.isInteger(decimals) || decimals < 2) throw new Error('Invalid token decimals');
  return (BigInt(amountCents) * 10n ** BigInt(decimals)) / 100n;
}

/**
 * Switches the wallet to the configured payment chain, adding it first if
 * the wallet has never seen it (any chain that isn't pre-loaded into
 * MetaMask/etc, which a niche appchain generally isn't). Without this, a
 * wallet left on whatever chain it happened to be on would either reject
 * the transaction outright or -- worse -- broadcast it against a contract
 * address that means something completely different on that chain.
 */
export async function ensureProviderChain(provider, { chainId, chainName, rpcUrl, nativeSymbol }) {
  const hexChainId = `0x${Number(chainId).toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] });
  } catch (err) {
    // 4902: wallet has never seen this chain -- add it, then switch.
    if (err?.code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hexChainId,
          chainName: chainName || `Chain ${chainId}`,
          rpcUrls: [rpcUrl],
          nativeCurrency: { name: nativeSymbol || 'ETH', symbol: nativeSymbol || 'ETH', decimals: 18 },
        }],
      });
      // Most wallets switch on add, but not all -- ask explicitly.
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] });
    } else {
      throw err;
    }
  }
}

/**
 * Sends a USDC-style ERC-20 `transfer` for `amountCents` (US cents) to
 * `payoutAddress`, at `decimals` (never assumed -- the caller passes what's
 * actually configured, same reasoning as the server's assertTokenDecimals()).
 * Returns the transaction hash, which the caller submits to the server for
 * on-chain verification -- this only broadcasts, it never proves anything.
 *
 * `expectedFrom` is the wallet the fan already proved they own; if the
 * wallet's selected account is different, nothing is sent.
 */
export async function sendStablecoinTransfer(provider, { tokenAddress, payoutAddress, amountCents, decimals = 6, chainId, chainName, rpcUrl, nativeSymbol, expectedFrom }) {
  if (!provider) throw new Error('No wallet extension detected');
  if (!chainId) throw new Error('No payment network is configured');
  const amount = centsToTokenUnits(amountCents, decimals);
  await ensureProviderChain(provider, { chainId, chainName, rpcUrl, nativeSymbol });
  // A real chain object, not none: with no chain at all viem's
  // sendTransaction throws "No chain was provided to the request" before
  // broadcasting -- which is what made every Buy click fail. With it, viem
  // also asserts the wallet really is on the payment network before sending.
  const chain = paymentChain({ chainId, chainName, rpcUrl, nativeSymbol });
  const client = createWalletClient({ chain, transport: custom(provider) });
  const [from] = await client.requestAddresses();
  // The server credits a deposit only if it came from the wallet the fan
  // proved they own. Catching an account switch here, before sending,
  // beats a payment the server then can't attribute.
  if (expectedFrom && getAddress(from) !== getAddress(expectedFrom)) {
    throw new Error('Your wallet switched accounts. Switch back to the account you verified, then pay.');
  }
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [getAddress(payoutAddress), amount],
  });
  return client.sendTransaction({
    account: getAddress(from),
    chain,
    to: getAddress(tokenAddress),
    data,
  });
}

/**
 * Signs `message` with the wallet's currently selected account and returns
 * BOTH the address and the signature -- read together, so the address the
 * server is told about is the one that actually signed.
 */
export async function signWithProvider(provider, message) {
  if (!provider) throw new Error('No wallet extension detected');
  const client = createWalletClient({ transport: custom(provider) });
  const [from] = await client.requestAddresses();
  const address = getAddress(from);
  const signature = await client.signMessage({ account: address, message });
  return { address, signature };
}

export function hasInjectedWallet() {
  return typeof window !== 'undefined' && !!window.ethereum;
}

export function useWallet() {
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const connect = useCallback(async () => {
    setError(null);
    if (!hasInjectedWallet()) {
      setError('no_wallet');
      return null;
    }
    setConnecting(true);
    try {
      const client = createWalletClient({ transport: custom(window.ethereum) });
      const [acct] = await client.requestAddresses();
      const cid = await window.ethereum.request({ method: 'eth_chainId' });
      setAddress(getAddress(acct));
      setChainId(parseInt(cid, 16));
      return acct;
    } catch (err) {
      // 4001 is the standard EIP-1193 "user rejected the request" code --
      // that's not a real error, it's someone clicking Cancel.
      setError(err?.code === 4001 ? 'rejected' : 'connect_failed');
      return null;
    } finally {
      setConnecting(false);
    }
  }, []);

  const ensureChain = useCallback(async (opts) => {
    if (!hasInjectedWallet()) throw new Error('No wallet extension detected');
    return ensureProviderChain(window.ethereum, opts);
  }, []);

  const sendUsdc = useCallback(async (opts) => {
    if (!hasInjectedWallet()) throw new Error('No wallet extension detected');
    return sendStablecoinTransfer(window.ethereum, opts);
  }, []);

  /**
   * Signs an arbitrary message with the connected wallet -- used to prove
   * control of an address before the server will trust it. Never used to
   * authorize a transaction; the message text itself says so (see
   * lib/wallet-auth.js). Returns the signature only; `signMessageWithAddress`
   * returns { address, signature }.
   */
  const signMessage = useCallback(async (message) => {
    if (!hasInjectedWallet()) throw new Error('No wallet extension detected');
    const { signature } = await signWithProvider(window.ethereum, message);
    return signature;
  }, []);

  const signMessageWithAddress = useCallback(async (message) => {
    if (!hasInjectedWallet()) throw new Error('No wallet extension detected');
    const result = await signWithProvider(window.ethereum, message);
    setAddress(result.address);
    return result;
  }, []);

  return { address, chainId, connecting, error, connect, ensureChain, sendUsdc, signMessage, signMessageWithAddress };
}
