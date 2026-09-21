import { useCallback, useState } from 'react';
import { createWalletClient, custom, getAddress, encodeFunctionData } from 'viem';

/**
 * Thin wrapper around a browser-injected wallet (MetaMask, Coinbase Wallet,
 * any EIP-1193 provider on window.ethereum). Deliberately does NOT pull in
 * WalletConnect/RainbowKit -- those need a Reown/WalletConnect Cloud project
 * id that nobody has set up yet, and an injected-only connector already
 * covers the large majority of desktop crypto users without that
 * dependency. Add a WalletConnect connector later without touching the
 * payment logic below -- this hook's return shape (`address`, `sendUsdc`)
 * is the only thing callers depend on.
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

  /**
   * Switches the wallet to the configured payment chain, adding it first if
   * the wallet has never seen it (any chain that isn't pre-loaded into
   * MetaMask/etc, which a niche appchain generally isn't). Without this, a
   * wallet left on whatever chain it happened to be on would either reject
   * the transaction outright or -- worse -- broadcast it against a contract
   * address that means something completely different on that chain.
   */
  const ensureChain = useCallback(async ({ chainId, chainName, rpcUrl, nativeSymbol }) => {
    const hexChainId = `0x${Number(chainId).toString(16)}`;
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] });
    } catch (err) {
      // 4902: wallet has never seen this chain -- add it, then switch.
      if (err?.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: hexChainId,
            chainName: chainName || `Chain ${chainId}`,
            rpcUrls: [rpcUrl],
            nativeCurrency: { name: nativeSymbol || 'ETH', symbol: nativeSymbol || 'ETH', decimals: 18 },
          }],
        });
      } else {
        throw err;
      }
    }
  }, []);

  /**
   * Sends a USDC-style ERC-20 `transfer` for `amountCents` (US cents) to
   * `payoutAddress`, at `decimals` (6 for real USDC -- never assume, the
   * caller passes what's actually configured, same reasoning as the
   * server's assertTokenDecimals()). Returns the transaction hash, which
   * the caller submits to the server for on-chain verification -- this
   * function only broadcasts, it never itself proves anything was paid.
   */
  const sendUsdc = useCallback(async ({ tokenAddress, payoutAddress, amountCents, decimals = 6, chainId, chainName, rpcUrl, nativeSymbol }) => {
    if (!hasInjectedWallet()) throw new Error('No wallet extension detected');
    if (chainId) await ensureChain({ chainId, chainName, rpcUrl, nativeSymbol });
    const client = createWalletClient({ transport: custom(window.ethereum) });
    const [from] = await client.requestAddresses();
    // amountCents is whole US cents (e.g. 2599 = $25.99); a stablecoin is
    // 1:1 with the dollar, so the on-chain amount is cents/100 dollars
    // scaled to the token's own decimals -- done as one integer expression
    // so there's no intermediate floating-point dollar value to round badly.
    const amount = (BigInt(amountCents) * 10n ** BigInt(decimals)) / 100n;
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [getAddress(payoutAddress), amount],
    });
    return client.sendTransaction({
      account: getAddress(from),
      to: getAddress(tokenAddress),
      data,
    });
  }, [ensureChain]);

  /**
   * Signs an arbitrary message with the connected wallet -- used to prove
   * control of the address that's about to send (or already sent) a
   * deposit, before the server will credit it. Never used to authorize a
   * transaction; the message text itself says so (see lib/wallet-auth.js).
   */
  const signMessage = useCallback(async (message) => {
    if (!hasInjectedWallet()) throw new Error('No wallet extension detected');
    const client = createWalletClient({ transport: custom(window.ethereum) });
    const [from] = await client.requestAddresses();
    return client.signMessage({ account: getAddress(from), message });
  }, []);

  return { address, chainId, connecting, error, connect, sendUsdc, signMessage };
}
