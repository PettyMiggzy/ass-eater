import { createPublicClient, createWalletClient, http, erc20Abi, parseAbiItem, type Address } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { robinhood, robinhoodTestnet } from 'viem/chains';

export const chain = process.env.CHAIN === 'robinhood-testnet' ? robinhoodTestnet : robinhood;
export const CHAIN_ID = chain.id;
export const CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? 12);

export const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL) });

export const treasury = privateKeyToAccount(process.env.TREASURY_PRIVATE_KEY as `0x${string}`);
export const treasuryClient = createWalletClient({ account: treasury, chain, transport: http(process.env.RPC_URL) });

/**
 * Robinhood Chain's stablecoin is USDG (Global Dollar, issued by Paxos), not
 * USDC -- USDC has no contract on this chain at all. A fan bridging USDC in
 * receives USDG on arrival (the bridge converts, no separate swap), and USDG
 * bridged out comes back as USDC on Base, Ethereum and eleven other chains.
 * So the fan-facing and creator-facing experience is still "USDC", while the
 * asset this ledger actually settles in is USDG.
 *
 * The default address is the canonical one from Robinhood's own registry
 * (docs.robinhood.com/chain/contracts). Overridable for testnet, but do NOT
 * point it at a token with a matching ticker and a different address.
 */
export const USDG_ADDRESS_MAINNET = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;

export const TOKENS: Record<'USDG' | 'ONLYASS', { address: Address; decimals: number }> = {
  USDG: { address: (process.env.USDG_ADDRESS as Address) ?? USDG_ADDRESS_MAINNET, decimals: Number(process.env.USDG_DECIMALS ?? 6) },
  ONLYASS:  { address: process.env.ONLYASS_TOKEN_ADDRESS as Address, decimals: Number(process.env.ONLYASS_DECIMALS ?? 18) },
};
export const DECIMALS = { USDG: TOKENS.USDG.decimals, ETH: 18, ONLYASS: TOKENS.ONLYASS.decimals } as const;

/**
 * Confirms every configured token's decimals against the contract itself.
 *
 * This is the one configuration mistake in here that is silent and total: a
 * token with 6 decimals read as 18 misprices every single deposit by a factor
 * of a trillion, in the direction that credits a fan a fortune for a dollar.
 * Nothing downstream would notice -- the arithmetic is all internally
 * consistent. So it is checked against the chain at worker startup rather
 * than trusted to an env var, and it throws rather than warning.
 */
export async function assertTokenDecimals() {
  for (const [symbol, token] of Object.entries(TOKENS)) {
    if (!token.address) throw new Error(`${symbol}: no contract address configured`);
    const onChain = await publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals' });
    if (Number(onChain) !== token.decimals) {
      throw new Error(`${symbol} at ${token.address} reports ${onChain} decimals, configured as ${token.decimals}. Refusing to price deposits against a wrong scale.`);
    }
  }
}
export const ADDR_TO_ASSET = new Map<string, 'USDG' | 'ONLYASS'>(
  Object.entries(TOKENS).map(([k, v]) => [v.address.toLowerCase(), k as 'USDG' | 'ONLYASS']));

export const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
export { erc20Abi };

/** Per-user deposit addresses derived from one HD mnemonic. Index stored in DepositAddress.derivationIndex. */
export const depositAccount = (index: number) =>
  mnemonicToAccount(process.env.DEPOSIT_MNEMONIC!, { addressIndex: index });

export const depositWalletClient = (index: number) =>
  createWalletClient({ account: depositAccount(index), chain, transport: http(process.env.RPC_URL) });
